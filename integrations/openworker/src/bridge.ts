import {
  NexarError,
  isNexarError,
  projectId,
  resourceId,
  type ArtifactRef,
  type Logger,
  type NexarTask,
} from '@nexar/contracts';
import type { ArtifactStore } from '@nexar/artifacts';
import type { NewTaskInput, RunOptions, RunOutcome } from '@nexar/core';
import type { Project, ProjectRegistry } from '@nexar/projects';
import { explainRouteDecision } from '@nexar/resource-controller';
import type {
  PrepareWorkflowInput,
  PreparedWorkflow,
  WorkflowRunOptions,
  WorkflowRunResult,
} from '@nexar/workflows';
import {
  DEFAULT_MAX_REQUEST_CHARS,
  WORK_BRIDGE_VERSION,
  createWorkRequestSchema,
  type WorkRequest,
  type WorkResponse,
  type WorkResponseError,
} from './schema.js';

/**
 * The slice of the Nexar engine the bridge needs; the real `Nexar` class satisfies it.
 *
 * SECURITY: the bridge never validates paths itself. Containment is the engine's realpath policy,
 * so the engine MUST be built with `workingDirectoryPolicy: 'project-only'` (the `createNexar`
 * default) and the same `ProjectRegistry` the bridge gets. Never hand the bridge an engine
 * configured as `'project-or-unscoped'`: that would let a request run in an unscoped directory.
 */
export interface WorkEngine {
  createTask(input: NewTaskInput): NexarTask;
  run(task: NexarTask, options?: RunOptions): Promise<RunOutcome>;
  recordArtifacts(
    forTask: NexarTask['id'],
    forProject: NexarTask['projectId'],
    artifacts: readonly ArtifactRef[],
  ): Promise<void>;
}

/**
 * The slice of `WorkflowRunner` the bridge needs. Same rule as {@link WorkEngine}: the runner must
 * be built on the same engine and `ProjectRegistry` as the bridge.
 */
export interface WorkflowPort {
  describe(workflowId: string, projectId?: string): { readonly taskKind: string } | undefined;
  prepare(input: PrepareWorkflowInput): Promise<PreparedWorkflow>;
  run(prepared: PreparedWorkflow, options?: WorkflowRunOptions): Promise<WorkflowRunResult>;
}

/** What an authorization hook sees: the validated, still-untrusted facts of a request. */
export interface AuthorizableRequest {
  readonly requestId: string;
  readonly source: string;
  readonly project: string;
  /** For a workflow request, the workflow's task kind (empty if the workflow does not exist). */
  readonly taskKind: string;
  /** Set for workflow requests. */
  readonly workflowId?: string;
  readonly documentSets: readonly string[];
  readonly maxCostUsd?: number;
}

export interface WorkBridgeOptions {
  readonly engine: WorkEngine;
  readonly projects: ProjectRegistry;
  readonly artifacts: ArtifactStore;
  /** Enables `workflow` requests; without it they are rejected. */
  readonly workflows?: WorkflowPort;
  /** Default `['openworker']`. */
  readonly allowedSources?: readonly string[];
  /** Default 100_000. */
  readonly maxRequestChars?: number;
  readonly logger?: Logger;
  /** Per-run execution timeout passed to the engine. */
  readonly timeoutMs?: number;
  readonly clock?: () => Date;
}

export interface SubmitOptions {
  /** Cancels the run. Jobs outlive the call that started them, so pass a lifetime signal, not a per-request one. */
  readonly signal?: AbortSignal;
  /** How long to wait for the job before answering `running`. Default 90_000, max 100_000. */
  readonly waitMs?: number;
  /** Identifies the caller for idempotency and `status` ownership. */
  readonly clientId?: string;
  /** Throws to refuse the request (a `NexarError` code is passed through). Runs before any task exists. */
  readonly authorize?: (request: AuthorizableRequest) => void;
}

export interface WorkBridge {
  submit(input: unknown, opts?: SubmitOptions): Promise<WorkResponse>;
  /** Current state of a job; only the client that submitted it (same `clientId`) may read it. */
  status(requestId: string, opts?: { readonly clientId?: string }): WorkResponse;
}

export const DEFAULT_WAIT_MS = 90_000;
export const MAX_WAIT_MS = 100_000;
export const MAX_JOBS = 200;

const silent: Logger = {
  debug: () => undefined,
  info: () => undefined,
  warn: () => undefined,
  error: () => undefined,
  child: () => silent,
};

const REQUEST_ID = /^[A-Za-z0-9._:-]{1,128}$/;

function readRequestId(input: unknown): string | null {
  if (typeof input !== 'object' || input === null || Array.isArray(input)) return null;
  const id = (input as { requestId?: unknown }).requestId;
  return typeof id === 'string' && REQUEST_ID.test(id) ? id : null;
}

function rejected(
  requestId: string | null,
  error: Omit<WorkResponseError, 'retryable'>,
): WorkResponse {
  return {
    version: WORK_BRIDGE_VERSION,
    requestId,
    status: 'rejected',
    error: { ...error, retryable: false },
  };
}

function failed(
  requestId: string,
  error: Omit<WorkResponseError, 'issues'>,
  extra: Pick<WorkResponse, 'taskId' | 'route'> = {},
): WorkResponse {
  return { version: WORK_BRIDGE_VERSION, requestId, status: 'failed', ...extra, error };
}

function internalFailure(requestId: string, taskId?: string): WorkResponse {
  const internal = new NexarError('INTERNAL_ERROR', 'Internal error while running the request');
  return failed(
    requestId,
    { code: internal.code, message: internal.message, retryable: internal.retryable },
    taskId === undefined ? {} : { taskId },
  );
}

function clampWait(waitMs: number | undefined): number {
  if (waitMs === undefined || !Number.isFinite(waitMs)) return DEFAULT_WAIT_MS;
  return Math.min(Math.max(Math.floor(waitMs), 0), MAX_WAIT_MS);
}

/** Issues of a rejected workflow request: the runner's per-input problems, as response paths. */
function workflowIssues(error: NexarError): { path: string; message: string }[] {
  const raw = error.details?.['issues'];
  const issues = Array.isArray(raw)
    ? (raw as { input?: unknown; problem?: unknown }[]).flatMap((i) =>
        typeof i.input === 'string' && typeof i.problem === 'string'
          ? [
              {
                path: i.input === 'workflow' ? 'workflow.id' : `workflow.inputs.${i.input}`,
                message: i.problem,
              },
            ]
          : [],
      )
    : [];
  return issues.length > 0 ? issues : [{ path: 'workflow', message: 'not usable in this project' }];
}

/** Explains a NO_ELIGIBLE_RESOURCE error from the ids and reason codes the engine attached. */
function explainNoEligible(error: NexarError): NonNullable<WorkResponse['route']> {
  const entries = Array.isArray(error.details?.['rejected'])
    ? (error.details['rejected'] as { resourceId?: unknown; reasonCodes?: unknown }[])
    : [];
  const lines = [error.message];
  const codes = new Set<string>();
  if (entries.length > 0) lines.push('Rejected:');
  for (const entry of entries) {
    const reasons = Array.isArray(entry.reasonCodes)
      ? entry.reasonCodes.filter((c): c is string => typeof c === 'string')
      : [];
    reasons.forEach((c) => codes.add(c));
    lines.push(`  - ${String(entry.resourceId)}: ${reasons.join(', ')}`);
  }
  return { reasonCodes: [...codes], explanation: lines.join('\n') };
}

interface Job {
  readonly requestId: string;
  readonly clientId: string | undefined;
  readonly taskId: string;
  readonly createdAt: number;
  readonly settled: Promise<WorkResponse>;
  response: WorkResponse | undefined;
}

/** A request that is a plain prompt (no workflow): `request` and `taskKind` are known to be set. */
type PlainRequest = WorkRequest & { readonly taskKind: string; readonly request: string };

/** What a request turned into before running: a task, plus the prepared workflow if it was one. */
interface Plan {
  readonly task: NexarTask;
  readonly workflow?: PreparedWorkflow;
}

/** Fields that belong to a plain prompt and must not be combined with `workflow`. */
const PLAIN_ONLY_FIELDS = [
  'request',
  'taskKind',
  'systemPrompt',
  'output',
  'documentSets',
  'workingDirectory',
] as const;

/**
 * Transport-agnostic entry point: validates untrusted input, runs it on Nexar as an async job,
 * never throws.
 */
export function createWorkBridge(options: WorkBridgeOptions): WorkBridge {
  const { engine, projects, artifacts, workflows } = options;
  const logger = options.logger ?? silent;
  const clock = options.clock ?? (() => new Date());
  const allowedSources = options.allowedSources ?? ['openworker'];
  const schema = createWorkRequestSchema(options.maxRequestChars ?? DEFAULT_MAX_REQUEST_CHARS);
  const jobs = new Map<string, Job>();

  /** The task for a request: resolves the project and document sets, then asks the engine. */
  async function prepare(req: PlainRequest, project: Project): Promise<NexarTask> {
    const attachments = new Map<string, ArtifactRef>();
    for (const name of new Set(req.documentSets ?? [])) {
      for (const ref of await projects.resolveDocumentSet(project, name)) {
        attachments.set(ref.uri, ref);
      }
    }
    const constraints = req.constraints;
    return engine.createTask({
      kind: req.taskKind,
      prompt: req.request,
      ...(req.systemPrompt === undefined ? {} : { systemPrompt: req.systemPrompt }),
      projectId: project.id,
      ...(attachments.size === 0 ? {} : { attachments: [...attachments.values()] }),
      // Passed through unchecked on purpose: the engine canonicalizes it against the project.
      ...(req.workingDirectory === undefined ? {} : { workingDirectory: req.workingDirectory }),
      origin: {
        source: req.source,
        project: project.id,
        correlationId: req.requestId,
        ...(req.requestedBy === undefined ? {} : { requestedBy: req.requestedBy }),
      },
      requirements: {
        capabilities: constraints?.capabilities ?? [],
        ...(constraints?.privacy === undefined ? {} : { privacy: constraints.privacy }),
        ...(constraints?.maxCostUsd === undefined ? {} : { maxCostUsd: constraints.maxCostUsd }),
        ...(constraints?.preferredResourceIds === undefined
          ? {}
          : { preferredResourceIds: constraints.preferredResourceIds.map(resourceId) }),
        ...(constraints?.excludedResourceIds === undefined
          ? {}
          : { excludedResourceIds: constraints.excludedResourceIds.map(resourceId) }),
      },
      metadata: { bridge: 'openworker', bridgeVersion: WORK_BRIDGE_VERSION },
    });
  }

  /** Validates and renders a workflow request; the runner owns input validation. */
  async function prepareWorkflow(
    req: WorkRequest,
    workflow: NonNullable<WorkRequest['workflow']>,
    project: Project,
  ): Promise<Plan> {
    if (workflows === undefined)
      throw new NexarError('VALIDATION_ERROR', 'Workflows are not enabled');
    const constraints = req.constraints;
    const prepared = await workflows.prepare({
      workflowId: workflow.id,
      projectId: project.id,
      inputs: workflow.inputs,
      origin: {
        source: req.source,
        project: project.id,
        correlationId: req.requestId,
        ...(req.requestedBy === undefined ? {} : { requestedBy: req.requestedBy }),
      },
      requirements: {
        capabilities: constraints?.capabilities ?? [],
        ...(constraints?.privacy === undefined ? {} : { privacy: constraints.privacy }),
        ...(constraints?.maxCostUsd === undefined ? {} : { maxCostUsd: constraints.maxCostUsd }),
        ...(constraints?.preferredResourceIds === undefined
          ? {}
          : { preferredResourceIds: constraints.preferredResourceIds.map(resourceId) }),
        ...(constraints?.excludedResourceIds === undefined
          ? {}
          : { excludedResourceIds: constraints.excludedResourceIds.map(resourceId) }),
      },
    });
    return { task: prepared.task, workflow: prepared };
  }

  /** Persists the result text when the request asked for it; a storage failure never loses the text. */
  async function persist(
    req: PlainRequest,
    task: NexarTask,
    text: string,
    log: Logger,
  ): Promise<Pick<WorkResponse, 'artifacts' | 'error'>> {
    if (req.output === undefined) return {};
    try {
      const forProject = projectId(req.project);
      const ref = await artifacts.store({
        projectId: forProject,
        taskId: task.id,
        filename: req.output.filename,
        content: text,
        mediaType: req.output.mediaType ?? 'text/markdown',
      });
      await engine.recordArtifacts(task.id, forProject, [ref]);
      return { artifacts: [ref] };
    } catch (thrown) {
      log.warn('storing the result artifact failed', {
        code: isNexarError(thrown) ? thrown.code : 'UNKNOWN',
      });
      return {
        error: {
          code: isNexarError(thrown) ? thrown.code : 'INTERNAL_ERROR',
          message: 'The result could not be stored as an artifact',
          retryable: false,
        },
      };
    }
  }

  async function run(
    req: WorkRequest,
    plan: Plan,
    signal: AbortSignal | undefined,
    log: Logger,
  ): Promise<WorkResponse> {
    const { task } = plan;
    try {
      const runOptions = {
        ...(signal === undefined ? {} : { signal }),
        ...(options.timeoutMs === undefined ? {} : { timeoutMs: options.timeoutMs }),
      };
      let outcome: RunOutcome;
      let stored: Pick<WorkResponse, 'artifacts' | 'error' | 'workflow'>;
      if (plan.workflow !== undefined && workflows !== undefined) {
        const ran = await workflows.run(plan.workflow, runOptions);
        outcome = ran.outcome;
        stored = {
          artifacts: ran.artifacts,
          workflow: { id: plan.workflow.workflowId, outputsSplit: ran.outputsSplit },
        };
      } else {
        outcome = await engine.run(task, runOptions);
        stored = await persist(req as PlainRequest, outcome.task, outcome.result.text, log);
      }
      const { result, decision } = outcome;
      return {
        version: WORK_BRIDGE_VERSION,
        requestId: req.requestId,
        status: 'completed',
        taskId: outcome.task.id,
        output: { text: result.text },
        route: {
          resourceId: decision.selected.resourceId,
          policy: decision.policy.name,
          reasonCodes: decision.selected.reasons.map((r) => r.code),
          explanation: explainRouteDecision(decision),
        },
        usage: {
          inputTokens: result.usage.inputTokens,
          outputTokens: result.usage.outputTokens,
          costUsd: result.usage.costUsd,
        },
        ...stored,
      };
    } catch (thrown) {
      if (isNexarError(thrown) && thrown.code === 'POLICY_REJECTED') {
        // The engine's workspace policy refused the directory before routing: nothing ran.
        log.info('work request rejected', { code: thrown.code });
        return rejected(req.requestId, {
          code: thrown.code,
          message: thrown.message,
          issues: [{ path: 'workingDirectory', message: 'outside the project boundary' }],
        });
      }
      if (isNexarError(thrown)) {
        log.warn('work request failed', { code: thrown.code });
        return failed(
          req.requestId,
          { code: thrown.code, message: thrown.message, retryable: thrown.retryable },
          {
            taskId: task.id,
            ...(thrown.code === 'NO_ELIGIBLE_RESOURCE' ? { route: explainNoEligible(thrown) } : {}),
          },
        );
      }
      log.warn('work request failed unexpectedly', {
        error: thrown instanceof Error ? thrown.message : String(thrown),
      });
      return internalFailure(req.requestId, task.id);
    }
  }

  /** Answers with the job's final response, or undefined if it is still running after `waitMs`. */
  function waitFor(job: Job, waitMs: number): Promise<WorkResponse | undefined> {
    if (job.response !== undefined) return Promise.resolve(job.response);
    if (waitMs <= 0) return Promise.resolve(undefined);
    return new Promise((resolve) => {
      const timer = setTimeout(() => resolve(undefined), waitMs);
      timer.unref();
      void job.settled.then((response) => {
        clearTimeout(timer);
        resolve(response);
      });
    });
  }

  function snapshot(job: Job): WorkResponse {
    return (
      job.response ?? {
        version: WORK_BRIDGE_VERSION,
        requestId: job.requestId,
        status: 'running',
        taskId: job.taskId,
      }
    );
  }

  /**
   * Jobs are namespaced per client: another client's request id is indistinguishable from an
   * unknown one, so ids cannot be probed or taken over across clients.
   */
  function jobKey(clientId: string | undefined, requestId: string): string {
    return `${clientId ?? ''}\u0000${requestId}`;
  }

  /** Makes room for one more job by dropping the oldest finished one; false if all are running. */
  function makeRoom(): boolean {
    if (jobs.size < MAX_JOBS) return true;
    let oldest: Job | undefined;
    for (const job of jobs.values()) {
      if (
        job.response !== undefined &&
        (oldest === undefined || job.createdAt < oldest.createdAt)
      ) {
        oldest = job;
      }
    }
    if (oldest === undefined) return false;
    jobs.delete(jobKey(oldest.clientId, oldest.requestId));
    return true;
  }

  async function submit(input: unknown, opts: SubmitOptions): Promise<WorkResponse> {
    const parsed = schema.safeParse(input);
    if (!parsed.success) {
      const requestId = readRequestId(input);
      logger.info('work request rejected', { requestId, code: 'VALIDATION_ERROR' });
      return rejected(requestId, {
        code: 'VALIDATION_ERROR',
        message: 'Invalid work request',
        issues: parsed.error.issues.map((issue) => ({
          path: issue.path.map(String).join('.'),
          message: issue.message,
        })),
      });
    }
    const req = parsed.data;
    const log = logger.child({ requestId: req.requestId });

    if (!allowedSources.includes(req.source)) {
      log.info('work request rejected', { source: req.source, code: 'POLICY_REJECTED' });
      return rejected(req.requestId, {
        code: 'POLICY_REJECTED',
        message: `Source "${req.source}" is not allowed`,
        issues: [{ path: 'source', message: 'not an allowed source' }],
      });
    }

    // Exactly one shape: a plain prompt (`request` + `taskKind`) or a `workflow`.
    const shapeIssues: { path: string; message: string }[] = [];
    if (req.workflow === undefined) {
      if (req.request === undefined) shapeIssues.push({ path: 'request', message: 'required' });
      if (req.taskKind === undefined) shapeIssues.push({ path: 'taskKind', message: 'required' });
    } else if (workflows === undefined) {
      shapeIssues.push({ path: 'workflow', message: 'workflows are not enabled' });
    } else {
      for (const field of PLAIN_ONLY_FIELDS) {
        if (req[field] !== undefined) {
          shapeIssues.push({ path: field, message: 'cannot be combined with workflow' });
        }
      }
    }
    if (shapeIssues.length > 0) {
      log.info('work request rejected', { code: 'VALIDATION_ERROR', stage: 'shape' });
      return rejected(req.requestId, {
        code: 'VALIDATION_ERROR',
        message: 'Invalid work request',
        issues: shapeIssues,
      });
    }
    const workflowRequest = req.workflow;
    // An unknown workflow has no task kind: '' passes only a wildcard scope, so a client without
    // the scope cannot tell a missing workflow from a forbidden one.
    const taskKind =
      workflowRequest === undefined
        ? (req.taskKind as string)
        : (workflows?.describe(workflowRequest.id, req.project)?.taskKind ?? '');

    if (opts.authorize !== undefined) {
      try {
        opts.authorize({
          requestId: req.requestId,
          source: req.source,
          project: req.project,
          taskKind,
          ...(workflowRequest === undefined ? {} : { workflowId: workflowRequest.id }),
          documentSets: req.documentSets ?? [],
          ...(req.constraints?.maxCostUsd === undefined
            ? {}
            : { maxCostUsd: req.constraints.maxCostUsd }),
        });
      } catch (thrown) {
        // Fail closed: anything but a NexarError is still a refusal.
        const code = isNexarError(thrown) ? thrown.code : 'POLICY_REJECTED';
        log.info('work request rejected', { code, stage: 'authorize' });
        return rejected(req.requestId, {
          code,
          message: isNexarError(thrown) ? thrown.message : 'Not permitted for this client',
        });
      }
    }

    const waitMs = clampWait(opts.waitMs);
    const existing = jobs.get(jobKey(opts.clientId, req.requestId));
    if (existing !== undefined) {
      log.info('work request resubmitted', { taskId: existing.taskId });
      return (await waitFor(existing, waitMs)) ?? snapshot(existing);
    }

    const project = (() => {
      try {
        return projects.get(projectId(req.project));
      } catch {
        return undefined;
      }
    })();
    if (project === undefined) {
      log.info('work request rejected', { code: 'POLICY_REJECTED', stage: 'project' });
      return rejected(req.requestId, {
        code: 'POLICY_REJECTED',
        message: 'Unknown project',
        issues: [{ path: 'project', message: 'not a registered project' }],
      });
    }

    let plan: Plan;
    try {
      plan =
        workflowRequest === undefined
          ? { task: await prepare(req as PlainRequest, project) }
          : await prepareWorkflow(req, workflowRequest, project);
    } catch (thrown) {
      if (
        isNexarError(thrown) &&
        (thrown.code === 'POLICY_REJECTED' || thrown.code === 'VALIDATION_ERROR')
      ) {
        log.info('work request rejected', { code: thrown.code, stage: 'prepare' });
        return rejected(req.requestId, {
          code: thrown.code,
          message: thrown.message,
          issues:
            workflowRequest === undefined
              ? [{ path: 'documentSets', message: 'not usable in this project' }]
              : workflowIssues(thrown),
        });
      }
      if (isNexarError(thrown)) {
        log.warn('work request failed', { code: thrown.code, stage: 'prepare' });
        // A workflow configuration message can name local files: keep it out of the response.
        const generic = workflowRequest !== undefined && thrown.code === 'CONFIGURATION_ERROR';
        return failed(req.requestId, {
          code: thrown.code,
          message: generic ? 'Workflow configuration error' : thrown.message,
          retryable: thrown.retryable,
        });
      }
      throw thrown;
    }
    const { task } = plan;

    if (!makeRoom()) {
      log.warn('work request refused: too many jobs in progress');
      return failed(
        req.requestId,
        { code: 'RESOURCE_UNAVAILABLE', message: 'Too many jobs in progress', retryable: true },
        {},
      );
    }

    log.info('work request accepted', {
      source: req.source,
      taskKind,
      ...(workflowRequest === undefined ? {} : { workflowId: workflowRequest.id }),
      project: req.project,
      taskId: task.id,
      requestChars: req.request?.length ?? 0,
      systemPromptChars: req.systemPrompt?.length ?? 0,
      documentSets: req.documentSets?.length ?? 0,
    });
    let finish!: (response: WorkResponse) => void;
    const settled = new Promise<WorkResponse>((resolve) => {
      finish = resolve;
    });
    const job: Job = {
      requestId: req.requestId,
      clientId: opts.clientId,
      taskId: task.id,
      createdAt: clock().getTime(),
      settled,
      response: undefined,
    };
    jobs.set(jobKey(opts.clientId, req.requestId), job);
    // `run` never rejects, so the job always settles.
    void run(req, plan, opts.signal, log).then((response) => {
      job.response = response;
      log.info('work request settled', { status: response.status, taskId: task.id });
      finish(response);
    });
    return (await waitFor(job, waitMs)) ?? snapshot(job);
  }

  return {
    async submit(input, opts = {}) {
      try {
        return await submit(input, opts);
      } catch (thrown) {
        logger.warn('work request failed unexpectedly', {
          error: thrown instanceof Error ? thrown.message : String(thrown),
        });
        const requestId = readRequestId(input);
        return requestId === null
          ? rejected(null, { code: 'INTERNAL_ERROR', message: 'Internal error' })
          : internalFailure(requestId);
      }
    },

    status(requestId, opts = {}) {
      const job = jobs.get(jobKey(opts.clientId, requestId));
      if (job === undefined) {
        return rejected(REQUEST_ID.test(requestId) ? requestId : null, {
          code: 'VALIDATION_ERROR',
          message: 'Unknown request',
        });
      }
      return snapshot(job);
    },
  };
}
