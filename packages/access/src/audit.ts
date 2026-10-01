import { appendFile, chmod, mkdir } from 'node:fs/promises';
import { dirname } from 'node:path';
import { NEXAR_ERROR_CODES, NexarError, isNexarError, type NexarErrorCode } from '@nexar/contracts';

export type AuditOutcome = 'completed' | 'failed' | 'rejected' | 'running';

/**
 * One line per request. Every field is an explicit allowlist member; there is deliberately no
 * free-text, prompt, path, document, or token field.
 */
export interface AuditRecord {
  readonly schemaVersion: 1;
  readonly requestId: string;
  readonly at: string;
  readonly durationMs: number;
  /** null if authentication failed. */
  readonly clientId: string | null;
  readonly tool: string;
  /** Transport, e.g. `mcp-stdio`. */
  readonly origin: string;
  readonly projectId?: string;
  readonly taskKind?: string;
  readonly workflowId?: string;
  readonly auth: 'succeeded' | 'failed';
  readonly policy: 'allowed' | 'rejected' | 'not-evaluated';
  readonly resourceId?: string;
  readonly taskId?: string;
  readonly outcome: AuditOutcome;
  readonly errorCode?: NexarErrorCode;
  readonly artifactCount?: number;
}

export interface AuditLog {
  append(record: AuditRecord): Promise<void>;
}

const SAFE_ID = /^[A-Za-z0-9._:-]{1,128}$/;
const INVALID = 'invalid';

/** Replaces anything that is not a short, plain identifier, so content cannot ride along. */
export function sanitizeId(value: unknown): string {
  return typeof value === 'string' && SAFE_ID.test(value) ? value : INVALID;
}

function sanitizeCount(value: unknown): number {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0 ? Math.floor(value) : 0;
}

function sanitizeErrorCode(value: unknown): NexarErrorCode {
  return (NEXAR_ERROR_CODES as readonly unknown[]).includes(value)
    ? (value as NexarErrorCode)
    : 'INTERNAL_ERROR';
}

/** Keeps records in memory; for tests. */
export class InMemoryAuditLog implements AuditLog {
  private readonly store: AuditRecord[] = [];

  get records(): readonly AuditRecord[] {
    return this.store;
  }

  append(record: AuditRecord): Promise<void> {
    this.store.push(record);
    return Promise.resolve();
  }
}

/** Append-only JSONL file (dir 0700, file 0600); writes are serialized so lines never interleave. */
export class JsonlAuditLog implements AuditLog {
  private tail: Promise<void> = Promise.resolve();

  constructor(private readonly filePath: string) {}

  append(record: AuditRecord): Promise<void> {
    const line = JSON.stringify(record) + '\n';
    const result = this.tail.then(() => this.write(line));
    // Keep the chain alive after a failure; the caller still sees the rejection via `result`.
    this.tail = result.catch(() => undefined);
    return result;
  }

  private async write(line: string): Promise<void> {
    await mkdir(dirname(this.filePath), { recursive: true, mode: 0o700 });
    await appendFile(this.filePath, line, { mode: 0o600 });
    // `mode` applies only on creation and is subject to umask; enforce it.
    await chmod(this.filePath, 0o600);
  }
}

export interface StartAuditOptions {
  readonly requestId: string;
  readonly tool: string;
  readonly origin: string;
  readonly clock?: () => Date;
}

export interface AuditHandle {
  /** Marks authentication as succeeded for this client. */
  setClient(clientId: string): void;
  setPolicy(policy: 'allowed' | 'rejected'): void;
  setScope(fields: { projectId?: string; taskKind?: string; workflowId?: string }): void;
  setTask(fields: { taskId?: string; resourceId?: string; artifactCount?: number }): void;
  /** Writes the record once; later calls return the first call's result and write nothing. */
  finish(outcome: AuditOutcome, errorCode?: NexarErrorCode): Promise<void>;
  readonly finished: boolean;
}

/** Begins auditing a request. Until told otherwise: auth failed, policy not evaluated. */
export function startAudit(log: AuditLog, options: StartAuditOptions): AuditHandle {
  const clock = options.clock ?? (() => new Date());
  const startedAt = clock();
  let clientId: string | null = null;
  let policy: AuditRecord['policy'] = 'not-evaluated';
  let scope: { projectId?: string; taskKind?: string; workflowId?: string } = {};
  let task: { taskId?: string; resourceId?: string; artifactCount?: number } = {};
  let done: Promise<void> | undefined;

  return {
    setClient(id) {
      clientId = sanitizeId(id);
    },
    setPolicy(value) {
      policy = value;
    },
    setScope(fields) {
      scope = { ...scope, ...fields };
    },
    setTask(fields) {
      task = { ...task, ...fields };
    },
    get finished() {
      return done !== undefined;
    },
    finish(outcome, errorCode) {
      if (done !== undefined) return done;
      const now = clock();
      const record: AuditRecord = {
        schemaVersion: 1,
        requestId: sanitizeId(options.requestId),
        at: now.toISOString(),
        durationMs: sanitizeCount(now.getTime() - startedAt.getTime()),
        clientId,
        tool: sanitizeId(options.tool),
        origin: sanitizeId(options.origin),
        ...(scope.projectId === undefined ? {} : { projectId: sanitizeId(scope.projectId) }),
        ...(scope.taskKind === undefined ? {} : { taskKind: sanitizeId(scope.taskKind) }),
        ...(scope.workflowId === undefined ? {} : { workflowId: sanitizeId(scope.workflowId) }),
        auth: clientId === null ? 'failed' : 'succeeded',
        policy,
        ...(task.resourceId === undefined ? {} : { resourceId: sanitizeId(task.resourceId) }),
        ...(task.taskId === undefined ? {} : { taskId: sanitizeId(task.taskId) }),
        outcome,
        ...(errorCode === undefined ? {} : { errorCode: sanitizeErrorCode(errorCode) }),
        ...(task.artifactCount === undefined
          ? {}
          : { artifactCount: sanitizeCount(task.artifactCount) }),
      };
      done = log.append(record);
      return done;
    },
  };
}

const REJECTION_CODES: ReadonlySet<NexarErrorCode> = new Set<NexarErrorCode>([
  'AUTH_REQUIRED',
  'POLICY_REJECTED',
  'VALIDATION_ERROR',
]);

/**
 * Runs `fn` and guarantees one audit record on success and on throw. If `fn` already finished the
 * handle (e.g. as `running`), that record stands.
 *
 * Audit write failures are never swallowed: security events must not be lost quietly. If `fn`
 * threw, its original error is rethrown (the audit failure is dropped in its favor, so callers
 * still see the real cause); otherwise the audit failure surfaces as `INTERNAL_ERROR`.
 */
export async function withAudit<T>(
  log: AuditLog,
  base: StartAuditOptions,
  fn: (handle: AuditHandle) => Promise<T>,
): Promise<T> {
  const handle = startAudit(log, base);
  let result: T;
  try {
    result = await fn(handle);
  } catch (error) {
    const code: NexarErrorCode = isNexarError(error) ? error.code : 'INTERNAL_ERROR';
    if (code === 'POLICY_REJECTED') handle.setPolicy('rejected');
    try {
      await handle.finish(REJECTION_CODES.has(code) ? 'rejected' : 'failed', code);
    } catch {
      // The original error wins; see the function documentation.
    }
    throw error;
  }
  try {
    await handle.finish('completed');
  } catch (error) {
    throw new NexarError('INTERNAL_ERROR', 'audit write failed', { cause: error });
  }
  return result;
}
