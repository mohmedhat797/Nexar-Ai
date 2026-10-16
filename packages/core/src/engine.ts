import { randomUUID } from 'node:crypto';
import { realpath, stat } from 'node:fs/promises';
import {
  NexarError,
  emptyUsage,
  isNexarError,
  projectId,
  taskId,
  toNexarError,
  unavailable,
  valueOf,
  type CostEstimateRecord,
  type EngineeringWorkspace,
  type ExecutionGateway,
  type ExecutionEvent,
  type ExecutionOutcome,
  type ExecutionRecord,
  type ArtifactRef,
  type CostEstimate,
  type Measured,
  type ExecutionResult,
  type Logger,
  type NexarTask,
  type ProjectId,
  type QuotaObservation,
  type ResourceId,
  type ResourceRouter,
  type RouteDecision,
  type TaskId,
  type TaskKind,
  type TaskOrigin,
  type TaskRequirements,
  type TelemetryEvent,
  type TelemetrySink,
} from '@nexar/contracts';
import { ProjectRegistry, mergeRequirements } from '@nexar/projects';
import { requireSelected } from '@nexar/resource-controller';
import type { ResourceRegistry } from '@nexar/resource-registry';
import { isQuotaObserved } from '@nexar/telemetry';
import type { AdapterRegistry } from './adapter-registry.js';

const DEFAULT_QUOTA_EXHAUSTED_HOLD_MS = 60 * 60 * 1000;

export interface NexarDependencies {
  readonly registry: ResourceRegistry;
  readonly router: ResourceRouter;
  readonly adapters: AdapterRegistry;
  readonly telemetry: TelemetrySink;
  readonly logger: Logger;
  readonly clock?: () => Date;
  readonly newTaskId?: () => TaskId;
  readonly projects?: ProjectRegistry;
  /**
   * Where a task may run. `'project-only'` (default, secure): a working directory is accepted only
   * through a project, and is canonicalized against that project's working directories.
   * `'project-or-unscoped'`: a task without a project may also name a directory, which is only
   * canonicalized (for an owner at their own terminal, never for external clients).
   */
  readonly workingDirectoryPolicy?: 'project-only' | 'project-or-unscoped';
  /** How long a `QUOTA_EXHAUSTED` failure without a reset time blocks the resource; default 1 h. */
  readonly quotaExhaustedHoldMs?: number;
}

export interface NewTaskInput {
  readonly kind: TaskKind;
  readonly prompt: string;
  readonly title?: string;
  readonly systemPrompt?: string;
  readonly requirements?: Partial<TaskRequirements>;
  readonly origin?: TaskOrigin;
  readonly workingDirectory?: string;
  /** Applies the project's defaults; its boundary is enforced by `run`. Unknown ids throw. */
  readonly projectId?: string;
  readonly attachments?: readonly ArtifactRef[];
  readonly metadata?: Record<string, unknown>;
}

export interface RunOptions {
  readonly signal?: AbortSignal;
  readonly timeoutMs?: number;
  readonly onEvent?: (e: ExecutionEvent) => void;
  /**
   * Engineering lanes only (ADR-019): a Nexar-created task worktree and its launcher. It is a
   * code-level option, never derived from a request. The task must belong to a project and must not
   * also name a working directory; the adapter receives the workspace in its execution context.
   */
  readonly workspace?: EngineeringWorkspace;
  /**
   * Engineering lanes only (ADR-027 section 9b): the lane's engine gateway session, handed to the adapter
   * unchanged. Requires workspace. A secret: never logged. With gatewayResourceId it reaches the
   * adapter only when routing selected that resource.
   */
  readonly gateway?: ExecutionGateway;
  readonly gatewayResourceId?: string;
  /**
   * Engineering lanes only: owner-confirmed project memory handed to the adapter unchanged (never
   * logged or recorded). Requires workspace.
   */
  readonly requiredContext?: string;
}

export interface RunOutcome {
  readonly task: NexarTask;
  readonly decision: Extract<RouteDecision, { outcome: 'selected' }>;
  readonly result: ExecutionResult;
  readonly record: ExecutionRecord;
}

/**
 * Settles as soon as `signal` aborts, even if `work` never does, so an adapter
 * that ignores its signal cannot hang a run past its timeout or cancellation.
 */
function untilAborted<T>(work: Promise<T>, signal: AbortSignal): Promise<T> {
  if (signal.aborted) {
    work.catch(() => undefined);
    return Promise.reject(signal.reason as Error);
  }
  return new Promise<T>((resolve, reject) => {
    const onAbort = (): void => reject(signal.reason as Error);
    signal.addEventListener('abort', onAbort, { once: true });
    work.then(
      (value) => {
        signal.removeEventListener('abort', onAbort);
        resolve(value);
      },
      (error: unknown) => {
        signal.removeEventListener('abort', onAbort);
        reject(toNexarError(error));
      },
    );
  });
}

/**
 * Estimate vs actual (observability only). Absent unless the selected candidate carried an
 * estimate; errors are computed only from numeric (measured or estimated) values.
 */
function costEstimateRecord(
  estimate: CostEstimate | undefined,
  actualUsd: Measured<number>,
): CostEstimateRecord | undefined {
  if (estimate === undefined) return undefined;
  const est = valueOf(estimate.cashUsd);
  const act = valueOf(actualUsd);
  const absoluteErrorUsd =
    est !== undefined && act !== undefined && Number.isFinite(est + act)
      ? Math.abs(est - act)
      : undefined;
  return {
    estimator: estimate.estimator,
    class: estimate.class,
    estimatedUsd: estimate.cashUsd,
    actualUsd,
    ...(absoluteErrorUsd === undefined ? {} : { absoluteErrorUsd }),
    ...(absoluteErrorUsd !== undefined && act !== undefined && act > 0
      ? { relativeError: absoluteErrorUsd / act }
      : {}),
  };
}

/** Task → route → execute → record. Knows no upstream; speaks only contracts. */
export class Nexar {
  private readonly clock: () => Date;
  private readonly newTaskId: () => TaskId;
  private readonly projects: ProjectRegistry;
  private readonly workingDirectoryPolicy: 'project-only' | 'project-or-unscoped';
  private readonly quotaExhaustedHoldMs: number;

  constructor(private readonly deps: NexarDependencies) {
    this.projects = deps.projects ?? ProjectRegistry.empty();
    this.workingDirectoryPolicy = deps.workingDirectoryPolicy ?? 'project-only';
    this.quotaExhaustedHoldMs = deps.quotaExhaustedHoldMs ?? DEFAULT_QUOTA_EXHAUSTED_HOLD_MS;
    this.clock = deps.clock ?? (() => new Date());
    this.newTaskId = deps.newTaskId ?? (() => taskId(`task_${randomUUID()}`));
  }

  createTask(input: NewTaskInput): NexarTask {
    const project =
      input.projectId === undefined ? undefined : this.projects.require(projectId(input.projectId));
    return {
      id: this.newTaskId(),
      kind: input.kind,
      ...(input.title === undefined ? {} : { title: input.title }),
      input: {
        prompt: input.prompt,
        ...(input.systemPrompt === undefined ? {} : { systemPrompt: input.systemPrompt }),
        ...(input.workingDirectory === undefined
          ? {}
          : { workingDirectory: input.workingDirectory }),
        ...(input.attachments === undefined ? {} : { attachments: input.attachments }),
      },
      requirements:
        project === undefined
          ? { capabilities: [], ...input.requirements }
          : mergeRequirements(project.defaults, input.requirements ?? {}),
      ...(project === undefined ? {} : { projectId: project.id }),
      origin: input.origin ?? { source: 'cli' },
      createdAt: this.clock().toISOString(),
      ...(input.metadata === undefined ? {} : { metadata: input.metadata }),
    };
  }

  async route(task: NexarTask): Promise<RouteDecision> {
    const decision = await this.deps.router.route(task);
    await this.emit({ type: 'route.decided', at: this.now(), decision });
    return decision;
  }

  /**
   * The working directory is enforced here, before routing and before any event, so a rejected task
   * never reaches an adapter. The returned task carries the canonical path; only it flows onward.
   */
  private async enforceWorkspace(task: NexarTask): Promise<NexarTask> {
    const requested = task.input.workingDirectory;
    let canonical: string | undefined;
    if (task.projectId !== undefined) {
      const project = this.projects.require(task.projectId);
      canonical = await this.projects.resolveWorkingDirectory(project, requested);
    } else if (requested !== undefined) {
      if (this.workingDirectoryPolicy === 'project-only') {
        throw new NexarError('POLICY_REJECTED', 'A working directory requires a project', {
          details: { reason: 'PROJECT_REQUIRED' },
        });
      }
      try {
        canonical = await realpath(requested);
      } catch (error) {
        const code = (error as { code?: unknown } | null)?.code;
        // No `cause`: fs errors embed the path.
        throw new NexarError('POLICY_REJECTED', 'Path is not accessible or does not exist', {
          details: { reason: typeof code === 'string' ? code : 'UNKNOWN' },
        });
      }
    }
    if (canonical === undefined) return task;
    return { ...task, input: { ...task.input, workingDirectory: canonical } };
  }

  /** Validates an engineering workspace and returns it with its canonical path. */
  private async enforceEngineeringWorkspace(
    task: NexarTask,
    workspace: EngineeringWorkspace,
  ): Promise<EngineeringWorkspace> {
    if (task.projectId === undefined) {
      throw new NexarError('POLICY_REJECTED', 'An engineering workspace requires a project', {
        details: { reason: 'PROJECT_REQUIRED' },
      });
    }
    this.projects.require(task.projectId);
    if (task.input.workingDirectory !== undefined) {
      throw new NexarError(
        'VALIDATION_ERROR',
        'A task with an engineering workspace must not also name a working directory',
      );
    }
    let canonical: string;
    try {
      canonical = await realpath(workspace.path);
      if (!(await stat(canonical)).isDirectory()) throw new Error('not a directory');
    } catch {
      // No `cause`: fs errors embed the path.
      throw new NexarError(
        'POLICY_REJECTED',
        'Engineering workspace is not an accessible directory',
      );
    }
    return { ...workspace, path: canonical };
  }

  async run(submitted: NexarTask, options: RunOptions = {}): Promise<RunOutcome> {
    if (options.gateway !== undefined && options.workspace === undefined) {
      throw new NexarError(
        'VALIDATION_ERROR',
        'A gateway session requires an engineering workspace',
      );
    }
    if (options.requiredContext !== undefined && options.workspace === undefined) {
      throw new NexarError(
        'VALIDATION_ERROR',
        'Required context requires an engineering workspace',
      );
    }
    const workspace =
      options.workspace === undefined
        ? undefined
        : await this.enforceEngineeringWorkspace(submitted, options.workspace);
    const task = workspace === undefined ? await this.enforceWorkspace(submitted) : submitted;
    // Never log the prompt: only ids and routing facts.
    const logger = this.deps.logger.child({ taskId: task.id });
    const decision = requireSelected(await this.route(task));
    const resourceId = decision.selected.resourceId;
    const resource = this.deps.registry.get(resourceId);
    if (resource === undefined) {
      throw new NexarError('INTERNAL_ERROR', `Routed resource ${resourceId} is not registered`, {
        details: { resourceId },
      });
    }
    const adapter = this.deps.adapters.resolve(resource);

    const started = this.clock();
    await this.emit({
      type: 'execution.started',
      at: started.toISOString(),
      taskId: task.id,
      resourceId,
    });
    logger.info('execution started', { resourceId, adapter: adapter.id });

    const timeoutSignal =
      options.timeoutMs === undefined ? undefined : AbortSignal.timeout(options.timeoutMs);
    const signals = [options.signal, timeoutSignal].filter(
      (s): s is AbortSignal => s !== undefined,
    );
    const signal = signals.length === 0 ? new AbortController().signal : AbortSignal.any(signals);

    const base = {
      schemaVersion: 1,
      taskId: task.id,
      taskKind: task.kind,
      origin: task.origin.source,
      ...(task.projectId === undefined ? {} : { projectId: task.projectId }),
      resourceId,
      resourceKind: resource.kind.type,
      adapter: adapter.id,
      routing: {
        policy: decision.policy.name,
        policyVersion: decision.policy.version,
        reasonCodes: decision.selected.reasons.map((r) => r.code),
        ...(decision.policy.configId === undefined ? {} : { configId: decision.policy.configId }),
        ...(decision.policy.fallback === undefined ? {} : { fallback: decision.policy.fallback }),
      },
      startedAt: started.toISOString(),
      quotaImpact: unavailable('not tracked in v0.1'),
    } as const;
    const finish = (
      extra: Pick<ExecutionRecord, 'usage' | 'retries' | 'outcome' | 'artifacts'> &
        Partial<Pick<ExecutionRecord, 'provider' | 'model' | 'runtimeVersion' | 'error'>>,
    ): ExecutionRecord => {
      const ended = this.clock();
      const costEstimate = costEstimateRecord(decision.selected.cost, extra.usage.costUsd);
      return {
        ...base,
        ...extra,
        ...(costEstimate === undefined ? {} : { costEstimate }),
        endedAt: ended.toISOString(),
        latencyMs: ended.getTime() - started.getTime(),
      };
    };

    let result: ExecutionResult;
    try {
      result = await untilAborted(
        adapter.execute(
          {
            task,
            resource,
          },
          {
            signal,
            logger: logger.child({ adapter: adapter.id }),
            ...(options.onEvent === undefined ? {} : { onEvent: options.onEvent }),
            ...(workspace === undefined ? {} : { workspace }),
            ...(options.gateway !== undefined &&
            (options.gatewayResourceId === undefined || options.gatewayResourceId === resourceId)
              ? { gateway: options.gateway }
              : {}),
            ...(options.requiredContext === undefined
              ? {}
              : { requiredContext: options.requiredContext }),
          },
        ),
        signal,
      );
    } catch (thrown) {
      const timedOut = timeoutSignal?.aborted === true && options.signal?.aborted !== true;
      const callerAborted = options.signal?.aborted === true;
      let error: NexarError;
      let outcome: ExecutionOutcome;
      if (callerAborted) {
        error =
          isNexarError(thrown) && thrown.code === 'EXECUTION_CANCELLED'
            ? thrown
            : new NexarError('EXECUTION_CANCELLED', 'Execution cancelled by caller', {
                cause: thrown,
              });
        outcome = 'cancelled';
      } else if (timedOut) {
        error = new NexarError(
          'EXECUTION_TIMEOUT',
          `Execution exceeded ${String(options.timeoutMs)}ms`,
          { cause: thrown, details: { timeoutMs: options.timeoutMs } },
        );
        outcome = 'timed-out';
      } else {
        error = toNexarError(thrown);
        outcome = 'failed';
      }
      const record = finish({
        usage: emptyUsage(error.code),
        retries: 0,
        outcome,
        artifacts: [],
        error: { code: error.code, message: error.message, retryable: error.retryable },
      });
      logger.warn('execution failed', { resourceId, outcome, code: error.code });
      await this.emit({ type: 'execution.finished', at: record.endedAt, record });
      if (error.code === 'QUOTA_EXHAUSTED') {
        await this.recordQuota(resourceId, [this.exhaustedSignal(error)]);
      }
      throw error;
    }

    const record = finish({
      usage: result.usage,
      retries: result.retries,
      outcome: 'succeeded',
      artifacts: result.artifacts,
      ...(result.resolved.provider === undefined ? {} : { provider: result.resolved.provider }),
      ...(result.resolved.model === undefined ? {} : { model: result.resolved.model }),
      ...(result.resolved.runtimeVersion === undefined
        ? {}
        : { runtimeVersion: result.resolved.runtimeVersion }),
    });
    logger.info('execution finished', { resourceId, latencyMs: record.latencyMs });
    await this.emit({ type: 'execution.finished', at: record.endedAt, record });
    if (result.quotaObservations !== undefined) {
      await this.recordQuota(resourceId, result.quotaObservations);
    }
    return { task, decision, result, record };
  }

  /** Records stored artifacts in telemetry (refs only, never content); sink failures are swallowed. */
  async recordArtifacts(
    forTask: TaskId,
    forProject: ProjectId | undefined,
    artifacts: readonly ArtifactRef[],
  ): Promise<void> {
    await this.emit({
      type: 'artifacts.stored',
      at: this.now(),
      taskId: forTask,
      ...(forProject === undefined ? {} : { projectId: forProject }),
      artifacts,
    });
  }

  /** The observation recorded when a run fails with `QUOTA_EXHAUSTED` (ADR-020 §4). */
  private exhaustedSignal(error: NexarError): QuotaObservation {
    const now = this.clock();
    const reported = (error.details as { resetsAt?: unknown } | undefined)?.resetsAt;
    const reportedMs = typeof reported === 'string' ? Date.parse(reported) : Number.NaN;
    const resetsAt =
      Number.isFinite(reportedMs) && reportedMs > now.getTime()
        ? new Date(reportedMs)
        : new Date(now.getTime() + this.quotaExhaustedHoldMs);
    return {
      unit: 'percent',
      limit: 100,
      used: 100,
      remaining: 0,
      resetsAt: resetsAt.toISOString(),
      observedAt: now.toISOString(),
      provenance: { limit: 'vendor-reported', usage: 'vendor-reported' },
      label: 'exhausted-signal',
    };
  }

  /** Emits one `quota.observed` per well-formed observation; malformed ones are dropped. */
  private async recordQuota(
    resourceId: ResourceId,
    observations: readonly QuotaObservation[],
  ): Promise<void> {
    for (const observation of observations) {
      const event: TelemetryEvent = {
        type: 'quota.observed',
        at: this.now(),
        resourceId,
        observation,
      };
      if (isQuotaObserved(event)) await this.emit(event);
    }
  }

  private now(): string {
    return this.clock().toISOString();
  }

  /** Telemetry must never break a run: failures are logged and swallowed. */
  private async emit(event: TelemetryEvent): Promise<void> {
    try {
      await this.deps.telemetry.emit(event);
    } catch (error) {
      this.deps.logger.warn('telemetry sink failed', {
        event: event.type,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }
}

/** Workflow helper: call after `ArtifactStore.store` so stored artifacts reach telemetry. */
export function recordArtifacts(
  nexar: Nexar,
  forTask: TaskId,
  forProject: ProjectId | undefined,
  artifacts: readonly ArtifactRef[],
): Promise<void> {
  return nexar.recordArtifacts(forTask, forProject, artifacts);
}
