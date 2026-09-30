import {
  NexarError,
  isNexarError,
  resourceId,
  type Logger,
  type NexarTask,
} from '@nexar/contracts';
import type { NewTaskInput, RunOptions, RunOutcome } from '@nexar/core';
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
 * default) and a `ProjectRegistry`. Never hand the bridge an engine configured as
 * `'project-or-unscoped'`: that would let a request run in an unscoped directory.
 */
export interface WorkEngine {
  createTask(input: NewTaskInput): NexarTask;
  run(task: NexarTask, options?: RunOptions): Promise<RunOutcome>;
}

export interface WorkBridgeOptions {
  readonly engine: WorkEngine;
  /** Default `['openworker']`. */
  readonly allowedSources?: readonly string[];
  /** Default 100_000. */
  readonly maxRequestChars?: number;
  readonly logger?: Logger;
  readonly timeoutMs?: number;
}

export interface WorkBridge {
  submit(input: unknown, opts?: { readonly signal?: AbortSignal }): Promise<WorkResponse>;
}

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

function failed(requestId: string, error: Omit<WorkResponseError, 'issues'>): WorkResponse {
  return { version: WORK_BRIDGE_VERSION, requestId, status: 'failed', error };
}

/** Transport-agnostic entry point: validates untrusted input, runs it on Nexar, never throws. */
export function createWorkBridge(options: WorkBridgeOptions): WorkBridge {
  const { engine } = options;
  const logger = options.logger ?? silent;
  const allowedSources = options.allowedSources ?? ['openworker'];
  const schema = createWorkRequestSchema(options.maxRequestChars ?? DEFAULT_MAX_REQUEST_CHARS);

  function buildTask(req: WorkRequest): NexarTask {
    const constraints = req.constraints;
    return engine.createTask({
      kind: req.taskKind,
      prompt: req.request,
      ...(req.systemPrompt === undefined ? {} : { systemPrompt: req.systemPrompt }),
      ...(req.project === undefined ? {} : { projectId: req.project }),
      // Passed through unchecked on purpose: the engine canonicalizes it against the project.
      ...(req.workingDirectory === undefined ? {} : { workingDirectory: req.workingDirectory }),
      origin: {
        source: req.source,
        correlationId: req.requestId,
        ...(req.project === undefined ? {} : { project: req.project }),
        ...(req.requestedBy === undefined ? {} : { requestedBy: req.requestedBy }),
      },
      requirements: {
        capabilities: constraints?.capabilities ?? [],
        ...(constraints?.privacy === undefined ? {} : { privacy: constraints.privacy }),
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

  async function execute(
    task: NexarTask,
    req: WorkRequest,
    signal: AbortSignal | undefined,
  ): Promise<WorkResponse> {
    const outcome = await engine.run(task, {
      ...(signal === undefined ? {} : { signal }),
      ...(options.timeoutMs === undefined ? {} : { timeoutMs: options.timeoutMs }),
    });
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
        reasons: decision.selected.reasons.map((r) => ({
          code: r.code,
          effect: r.effect,
          message: r.message,
        })),
      },
      usage: {
        inputTokens: result.usage.inputTokens,
        outputTokens: result.usage.outputTokens,
        costUsd: result.usage.costUsd,
      },
    };
  }

  return {
    async submit(input, opts = {}) {
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
      if (req.workingDirectory !== undefined && req.project === undefined) {
        log.info('work request rejected', { source: req.source, code: 'POLICY_REJECTED' });
        return rejected(req.requestId, {
          code: 'POLICY_REJECTED',
          message: 'A working directory requires a project',
          issues: [{ path: 'workingDirectory', message: 'requires a project' }],
        });
      }

      log.info('work request accepted', {
        source: req.source,
        taskKind: req.taskKind,
        requestChars: req.request.length,
        systemPromptChars: req.systemPrompt?.length ?? 0,
      });
      let building = true;
      try {
        const task = buildTask(req);
        building = false;
        const response = await execute(task, req, opts.signal);
        log.info('work request completed', { taskId: response.taskId });
        return response;
      } catch (thrown) {
        // Both cases happen before routing: nothing ran.
        // - building: unknown or malformed project
        // - running: the engine's workspace policy rejected the working directory
        if (
          isNexarError(thrown) &&
          (thrown.code === 'POLICY_REJECTED' || (building && thrown.code === 'VALIDATION_ERROR'))
        ) {
          log.info('work request rejected', { source: req.source, code: thrown.code });
          return rejected(req.requestId, {
            code: thrown.code,
            message: thrown.message,
            issues: building
              ? [{ path: 'project', message: 'not a registered project' }]
              : [{ path: 'workingDirectory', message: 'outside the project boundary' }],
          });
        }
        if (isNexarError(thrown)) {
          log.warn('work request failed', { code: thrown.code });
          return failed(req.requestId, {
            code: thrown.code,
            message: thrown.message,
            retryable: thrown.retryable,
          });
        }
        log.warn('work request failed unexpectedly', {
          error: thrown instanceof Error ? thrown.message : String(thrown),
        });
        const internal = new NexarError(
          'INTERNAL_ERROR',
          'Internal error while running the request',
        );
        return failed(req.requestId, {
          code: internal.code,
          message: internal.message,
          retryable: internal.retryable,
        });
      }
    },
  };
}
