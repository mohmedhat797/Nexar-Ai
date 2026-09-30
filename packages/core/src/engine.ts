import { randomUUID } from 'node:crypto';
import { realpath } from 'node:fs/promises';
import {
  NexarError,
  emptyUsage,
  isNexarError,
  projectId,
  taskId,
  toNexarError,
  unavailable,
  type ExecutionEvent,
  type ExecutionOutcome,
  type ExecutionRecord,
  type ArtifactRef,
  type ExecutionResult,
  type Logger,
  type NexarTask,
  type ProjectId,
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
import type { AdapterRegistry } from './adapter-registry.js';

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

/** Task → route → execute → record. Knows no upstream; speaks only contracts. */
export class Nexar {
  private readonly clock: () => Date;
  private readonly newTaskId: () => TaskId;
  private readonly projects: ProjectRegistry;
  private readonly workingDirectoryPolicy: 'project-only' | 'project-or-unscoped';

  constructor(private readonly deps: NexarDependencies) {
    this.projects = deps.projects ?? ProjectRegistry.empty();
    this.workingDirectoryPolicy = deps.workingDirectoryPolicy ?? 'project-only';
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

  async run(submitted: NexarTask, options: RunOptions = {}): Promise<RunOutcome> {
    const task = await this.enforceWorkspace(submitted);
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
      },
      startedAt: started.toISOString(),
      quotaImpact: unavailable('not tracked in v0.1'),
    } as const;
    const finish = (
      extra: Pick<ExecutionRecord, 'usage' | 'retries' | 'outcome' | 'artifacts'> &
        Partial<Pick<ExecutionRecord, 'provider' | 'model' | 'runtimeVersion' | 'error'>>,
    ): ExecutionRecord => {
      const ended = this.clock();
      return {
        ...base,
        ...extra,
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
