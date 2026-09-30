import { isAbsolute, relative, resolve, sep } from 'node:path';
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

/** The slice of the Nexar engine the bridge needs; the real `Nexar` class satisfies it. */
export interface WorkEngine {
  createTask(input: NewTaskInput): NexarTask;
  run(task: NexarTask, options?: RunOptions): Promise<RunOutcome>;
}

export interface WorkBridgeOptions {
  readonly engine: WorkEngine;
  /** Default `['openworker']`. */
  readonly allowedSources?: readonly string[];
  /** Directories a request's `workingDirectory` must be inside. Default: none. */
  readonly allowedWorkingDirectories?: readonly string[];
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

/** Separator-aware containment on resolved paths, so `..` cannot escape the directory. */
function isInside(directory: string, candidate: string): boolean {
  const rel = relative(directory, candidate);
  return rel === '' || (rel !== '..' && !rel.startsWith(`..${sep}`) && !isAbsolute(rel));
}

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
  const allowedDirs = (options.allowedWorkingDirectories ?? []).map((d) => resolve(d));
  const schema = createWorkRequestSchema(options.maxRequestChars ?? DEFAULT_MAX_REQUEST_CHARS);

  async function execute(req: WorkRequest, signal: AbortSignal | undefined): Promise<WorkResponse> {
    const constraints = req.constraints;
    const task = engine.createTask({
      kind: req.taskKind,
      prompt: req.request,
      ...(req.systemPrompt === undefined ? {} : { systemPrompt: req.systemPrompt }),
      ...(req.workingDirectory === undefined
        ? {}
        : { workingDirectory: resolve(req.workingDirectory) }),
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
      if (req.workingDirectory !== undefined) {
        const target = resolve(req.workingDirectory);
        if (!allowedDirs.some((dir) => isInside(dir, target))) {
          log.info('work request rejected', { source: req.source, code: 'POLICY_REJECTED' });
          return rejected(req.requestId, {
            code: 'POLICY_REJECTED',
            message: 'Working directory is not allowed',
            issues: [{ path: 'workingDirectory', message: 'not inside an allowed directory' }],
          });
        }
      }

      log.info('work request accepted', {
        source: req.source,
        taskKind: req.taskKind,
        requestChars: req.request.length,
        systemPromptChars: req.systemPrompt?.length ?? 0,
      });
      try {
        const response = await execute(req, opts.signal);
        log.info('work request completed', { taskId: response.taskId });
        return response;
      } catch (thrown) {
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
