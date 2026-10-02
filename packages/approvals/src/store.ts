import { randomBytes } from 'node:crypto';
import { chmod, mkdir, open, readdir, readFile, rename, stat, unlink } from 'node:fs/promises';
import { join } from 'node:path';
import { NexarError } from '@nexar/contracts';
import { approvalDenied } from './errors.js';
import type { ApprovalRequest, ApprovalStatus } from './types.js';

export const APPROVAL_ID_PATTERN = /^apr_[0-9a-f]{32}$/;

export interface TransitionPatch {
  readonly decidedAt?: string;
  readonly decidedBy?: string;
  readonly reason?: string;
}

export interface ApprovalStore {
  create(request: ApprovalRequest): Promise<void>;
  get(id: string): Promise<ApprovalRequest | undefined>;
  list(filter?: { readonly status?: ApprovalStatus }): Promise<readonly ApprovalRequest[]>;
  transition(
    id: string,
    from: readonly ApprovalStatus[],
    to: ApprovalStatus,
    patch: TransitionPatch,
  ): Promise<ApprovalRequest>;
}

const ALLOWED: Readonly<Record<ApprovalStatus, readonly ApprovalStatus[]>> = {
  pending: ['approved', 'denied', 'expired', 'cancelled'],
  approved: ['consumed', 'expired', 'cancelled'],
  denied: [],
  expired: [],
  cancelled: [],
  consumed: [],
};

const STATUSES = Object.keys(ALLOWED);

/** Generates a fresh unguessable approval id. */
export function newApprovalId(): string {
  return `apr_${randomBytes(16).toString('hex')}`;
}

export function assertApprovalId(id: string): void {
  if (typeof id !== 'string' || !APPROVAL_ID_PATTERN.test(id)) {
    throw new NexarError('VALIDATION_ERROR', 'Invalid approval id', {
      details: { kind: 'ApprovalId' },
    });
  }
}

/** Shared transition rules; returns the updated record or throws `APPROVAL_DENIED`. */
function applyTransition(
  current: ApprovalRequest,
  from: readonly ApprovalStatus[],
  to: ApprovalStatus,
  patch: TransitionPatch,
): ApprovalRequest {
  if (to === 'consumed' && current.status === 'consumed') {
    throw approvalDenied('already-consumed', current.id);
  }
  if (!from.includes(current.status) || !ALLOWED[current.status].includes(to)) {
    throw approvalDenied('invalid-state', current.id);
  }
  return { ...current, ...patch, status: to };
}

function parseRecord(id: string, text: string): ApprovalRequest {
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch {
    throw approvalDenied('corrupt-record', id);
  }
  const r = value as Partial<ApprovalRequest> | null;
  if (
    typeof r !== 'object' ||
    r === null ||
    r.id !== id ||
    typeof r.status !== 'string' ||
    !STATUSES.includes(r.status) ||
    typeof r.fingerprint !== 'string' ||
    typeof r.expiresAt !== 'string' ||
    typeof r.instanceId !== 'string' ||
    Number.isNaN(Date.parse(r.expiresAt))
  ) {
    throw approvalDenied('corrupt-record', id);
  }
  return r as ApprovalRequest;
}

function isErrno(e: unknown, code: string): boolean {
  return typeof e === 'object' && e !== null && (e as { code?: unknown }).code === code;
}

const LOCK_STALE_MS = 10_000;
const LOCK_WAIT_MS = 3_000;
const RENAME_WAIT_MS = 1_000;

/** Windows readers/virus scanners may briefly deny replacement; never remove the destination. */
async function replaceAtomic(source: string, target: string): Promise<void> {
  const deadline = Date.now() + RENAME_WAIT_MS;
  for (;;) {
    try {
      await rename(source, target);
      return;
    } catch (error) {
      if (
        process.platform !== 'win32' ||
        !['EPERM', 'EACCES', 'EBUSY'].some((code) => isErrno(error, code)) ||
        Date.now() >= deadline
      ) {
        throw error;
      }
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
  }
}

/** One JSON file per request. Directory 0700, files 0600, atomic writes, O_EXCL single-use marker. */
export class FileApprovalStore implements ApprovalStore {
  constructor(private readonly dir: string) {}

  private path(id: string, ext: string): string {
    assertApprovalId(id);
    return join(this.dir, `${id}.${ext}`);
  }

  private async ensureDir(): Promise<void> {
    await mkdir(this.dir, { recursive: true, mode: 0o700 });
    await chmod(this.dir, 0o700);
  }

  private async writeAtomic(target: string, data: string): Promise<void> {
    const tmp = `${target}.tmp-${randomBytes(6).toString('hex')}`;
    try {
      const handle = await open(tmp, 'wx', 0o600);
      try {
        await handle.writeFile(data, 'utf8');
        await handle.sync();
      } finally {
        await handle.close();
      }
      await replaceAtomic(tmp, target);
      await chmod(target, 0o600);
    } catch (e) {
      await unlink(tmp).catch(() => undefined);
      throw e;
    }
  }

  /** Serializes read-modify-write per id across processes via an O_EXCL lock file. */
  private async withLock<T>(id: string, fn: () => Promise<T>): Promise<T> {
    const lockPath = this.path(id, 'lock');
    const deadline = Date.now() + LOCK_WAIT_MS;
    for (;;) {
      try {
        const handle = await open(lockPath, 'wx', 0o600);
        await handle.close();
        break;
      } catch (e) {
        if (!isErrno(e, 'EEXIST')) throw e;
        if (Date.now() >= deadline) throw approvalDenied('locked', id);
        const age = await stat(lockPath).then(
          (s) => Date.now() - s.mtimeMs,
          () => 0,
        );
        if (age > LOCK_STALE_MS) {
          await unlink(lockPath).catch(() => undefined);
        }
        // An undeletable stale lock must back off and respect the same acquisition deadline.
        await new Promise((r) => setTimeout(r, 5));
      }
    }
    try {
      return await fn();
    } finally {
      await unlink(lockPath).catch(() => undefined);
    }
  }

  async create(request: ApprovalRequest): Promise<void> {
    const target = this.path(request.id, 'json');
    await this.ensureDir();
    await this.withLock(request.id, () => this.writeAtomic(target, JSON.stringify(request)));
  }

  async get(id: string): Promise<ApprovalRequest | undefined> {
    assertApprovalId(id);
    // Windows replacement can be denied while a reader holds the destination open.
    if (process.platform !== 'win32') return this.readRecord(id);
    try {
      return await this.withLock(id, () => this.readRecord(id));
    } catch (error) {
      if (isErrno(error, 'ENOENT')) return undefined;
      throw error;
    }
  }

  private async readRecord(id: string): Promise<ApprovalRequest | undefined> {
    const target = this.path(id, 'json');
    let text: string;
    try {
      text = await readFile(target, 'utf8');
    } catch (e) {
      if (isErrno(e, 'ENOENT')) return undefined;
      throw e;
    }
    return parseRecord(id, text);
  }

  async list(filter?: { readonly status?: ApprovalStatus }): Promise<readonly ApprovalRequest[]> {
    let names: string[];
    try {
      names = await readdir(this.dir);
    } catch (e) {
      if (isErrno(e, 'ENOENT')) return [];
      throw e;
    }
    const out: ApprovalRequest[] = [];
    for (const name of names.sort()) {
      const id = name.endsWith('.json') ? name.slice(0, -5) : '';
      if (!APPROVAL_ID_PATTERN.test(id)) continue;
      try {
        const record = await this.get(id);
        if (
          record !== undefined &&
          (filter?.status === undefined || record.status === filter.status)
        ) {
          out.push(record);
        }
      } catch {
        // Corrupt records are never listed as approvable.
      }
    }
    return out;
  }

  async transition(
    id: string,
    from: readonly ApprovalStatus[],
    to: ApprovalStatus,
    patch: TransitionPatch,
  ): Promise<ApprovalRequest> {
    const target = this.path(id, 'json');
    const marker = this.path(id, 'consumed');
    return this.withLock(id, async () => {
      const current = await this.readRecord(id);
      if (current === undefined) throw approvalDenied('unknown-state', id);
      const next = applyTransition(current, from, to, patch);
      if (to === 'consumed') {
        try {
          await (await open(marker, 'wx', 0o600)).close();
        } catch (e) {
          if (isErrno(e, 'EEXIST')) throw approvalDenied('already-consumed', id);
          throw e;
        }
      }
      await this.writeAtomic(target, JSON.stringify(next));
      return next;
    });
  }
}

/** Runs synchronously (so in-memory transitions stay atomic) but surfaces throws as rejections. */
function run<T>(fn: () => T): Promise<T> {
  try {
    return Promise.resolve(fn());
  } catch (e) {
    return Promise.reject(e instanceof Error ? e : new Error(String(e)));
  }
}

/** Volatile store for tests. */
export class InMemoryApprovalStore implements ApprovalStore {
  private readonly records = new Map<string, ApprovalRequest>();

  create(request: ApprovalRequest): Promise<void> {
    return run(() => {
      assertApprovalId(request.id);
      this.records.set(request.id, request);
    });
  }

  get(id: string): Promise<ApprovalRequest | undefined> {
    return run(() => {
      assertApprovalId(id);
      return this.records.get(id);
    });
  }

  list(filter?: { readonly status?: ApprovalStatus }): Promise<readonly ApprovalRequest[]> {
    return run(() =>
      [...this.records.values()].filter(
        (r) => filter?.status === undefined || r.status === filter.status,
      ),
    );
  }

  transition(
    id: string,
    from: readonly ApprovalStatus[],
    to: ApprovalStatus,
    patch: TransitionPatch,
  ): Promise<ApprovalRequest> {
    return run(() => {
      assertApprovalId(id);
      const current = this.records.get(id);
      if (current === undefined) throw approvalDenied('unknown-state', id);
      const next = applyTransition(current, from, to, patch);
      this.records.set(id, next);
      return next;
    });
  }
}
