import type { BigIntStats } from 'node:fs';
import { chmod, lstat, mkdir, open, readdir, realpath, rename, unlink } from 'node:fs/promises';
import { basename, join } from 'node:path';
import { NexarError, isNexarError } from '@nexar/contracts';
import type { ArtifactRef } from '@nexar/contracts';
import { assertSessionId, randomHex } from './ids.js';
import { MAX_LIST, MAX_SESSION_BYTES, SESSION_BYTES_HEADROOM } from './limits.js';
import { parseSession, serializeSession } from './record.js';
import {
  beginTurn,
  completeTurn,
  createSession,
  interruptRunning,
  linkApprovals,
  linkArtifacts,
  linkTask,
  rename as renameSession,
  resolveConfirmation,
  setContext,
  setMode,
  updateTask,
} from './transitions.js';
import type {
  BeginTurnInput,
  BeginTurnResult,
  CompleteTurnInput,
  ConfirmationDecision,
  TaskUpdate,
  TurnMutation,
} from './transitions.js';
import type {
  ContextManifest,
  OperatingMode,
  OperatingSession,
  SessionSummary,
  TurnTaskLink,
  UnavailableSession,
} from './types.js';

const SESSION_FILE = /^(ses_[0-9a-f]{32})\.json$/;
const LEASE_NAME = '.lease';
const MAX_LEASE_BYTES = 1024;
const SHARING_WAIT_MS = 1_000;

export interface FileSessionStoreOptions {
  readonly clock?: () => Date;
  /** Returns 32 lowercase hex characters; used for new session and turn ids. */
  readonly newId?: () => string;
  readonly instanceId?: string;
  readonly pid?: number;
  readonly isProcessAlive?: (pid: number) => boolean;
}

export interface CreateSessionRequest {
  readonly projectId: string;
  readonly mode: OperatingMode;
  readonly title: string;
}

export type BeginTurnRequest = Omit<BeginTurnInput, 'turnId' | 'now'>;

function conflict(reason: string, extra: Readonly<Record<string, unknown>> = {}): NexarError {
  return new NexarError('CONFLICT', `Session conflict: ${reason}`, {
    details: { reason, ...extra },
  });
}

function unreadable(): NexarError {
  return new NexarError('VALIDATION_ERROR', 'Session record is unreadable', {
    details: { reason: 'corrupt-record' },
  });
}

function unsafeDir(): NexarError {
  return new NexarError('POLICY_REJECTED', 'Session directory is not safe to use', {
    details: { reason: 'unsafe-directory' },
  });
}

function errnoOf(e: unknown): string | undefined {
  if (typeof e !== 'object' || e === null) return undefined;
  const code = (e as { code?: unknown }).code;
  return typeof code === 'string' ? code : undefined;
}

/** Fs errors embed absolute paths in their messages; nothing but a code may leave this package. */
async function sanitize<T>(operation: () => Promise<T>): Promise<T> {
  try {
    return await operation();
  } catch (error) {
    if (isNexarError(error)) throw error;
    const errno = errnoOf(error);
    throw new NexarError('INTERNAL_ERROR', 'Session storage failure', {
      details: errno === undefined ? { reason: 'io-error' } : { reason: 'io-error', errno },
    });
  }
}

/** Bound Windows sharing retries at the file operation (same policy as the approval store). */
async function retrySharing<T>(operation: () => Promise<T>): Promise<T> {
  const deadline = Date.now() + SHARING_WAIT_MS;
  for (;;) {
    try {
      return await operation();
    } catch (error) {
      const code = errnoOf(error);
      if (
        process.platform !== 'win32' ||
        (code !== 'EPERM' && code !== 'EACCES' && code !== 'EBUSY') ||
        Date.now() >= deadline
      ) {
        throw error;
      }
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
  }
}

/** Windows readers/scanners may briefly deny replacement; the destination is never removed. */
async function replaceAtomic(source: string, target: string): Promise<void> {
  await retrySharing(() => rename(source, target));
}

function defaultIsProcessAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return errnoOf(error) === 'EPERM';
  }
}

interface LeaseRecord {
  readonly instanceId: string;
  readonly pid: number;
}

function parseLease(text: string): LeaseRecord | undefined {
  try {
    const value = JSON.parse(text) as unknown;
    if (typeof value !== 'object' || value === null || Array.isArray(value)) return undefined;
    const { instanceId, pid } = value as { instanceId?: unknown; pid?: unknown };
    if (
      typeof instanceId !== 'string' ||
      instanceId.length === 0 ||
      instanceId.length > 128 ||
      typeof pid !== 'number' ||
      !Number.isInteger(pid) ||
      pid <= 0
    ) {
      return undefined;
    }
    return { instanceId, pid };
  } catch {
    return undefined;
  }
}

function sameFile(a: BigIntStats, b: BigIntStats): boolean {
  return a.dev === b.dev && a.ino === b.ino;
}

/**
 * One JSON file per session (ADR-024 §5, §6): directory 0700, files 0600, exclusive temp file plus
 * atomic replace, bounded reads that refuse links and non-regular files, a process lease for writers,
 * and per-session serialized, revision-checked mutations.
 */
export class FileSessionStore {
  private readonly clock: () => Date;
  private readonly newId: () => string;
  private readonly instanceId: string;
  private readonly pid: number;
  private readonly isProcessAlive: (pid: number) => boolean;
  private readonly chains = new Map<string, Promise<void>>();
  private leaseHeld = false;
  private canonical: string | undefined;

  constructor(
    private readonly dir: string,
    options: FileSessionStoreOptions = {},
  ) {
    this.clock = options.clock ?? (() => new Date());
    this.newId = options.newId ?? randomHex;
    this.instanceId = options.instanceId ?? `inst_${randomHex()}`;
    this.pid = options.pid ?? process.pid;
    this.isProcessAlive = options.isProcessAlive ?? defaultIsProcessAlive;
  }

  // ---------------------------------------------------------------- lease

  /**
   * Becomes the single writer. Replaces a stale lease (dead pid or unreadable file), then marks every
   * `running` turn `interrupted`; nothing is replayed. Corrupt session files are skipped, never rewritten.
   */
  acquireLease(): Promise<{ readonly interruptedTurns: number }> {
    return sanitize(async () => {
      if (this.leaseHeld) return { interruptedTurns: 0 };
      await this.ensureDir();
      const body = JSON.stringify({ instanceId: this.instanceId, pid: this.pid });
      if (!(await this.createLease(body))) {
        const existing = await this.readLease();
        if (
          existing !== undefined &&
          existing.instanceId !== this.instanceId &&
          this.isProcessAlive(existing.pid)
        ) {
          throw conflict('lease-held');
        }
        await this.replaceLease(body);
        if ((await this.readLease())?.instanceId !== this.instanceId) throw conflict('lease-held');
      }
      this.leaseHeld = true;
      try {
        return { interruptedTurns: await this.recover() };
      } catch (error) {
        await this.releaseLease().catch(() => undefined);
        throw error;
      }
    });
  }

  /** Whether this process is the single writer (used to gate other owner-state writers, B9). */
  holdsLease(): boolean {
    return this.leaseHeld;
  }

  /** Removes the lease only if it is still ours. */
  releaseLease(): Promise<void> {
    return sanitize(async () => {
      if (!this.leaseHeld) return;
      this.leaseHeld = false;
      const lease = await this.readLease();
      if (lease?.instanceId !== this.instanceId) return;
      await retrySharing(() => unlink(join(this.dir, LEASE_NAME))).catch((error: unknown) => {
        if (errnoOf(error) !== 'ENOENT') throw error;
      });
    });
  }

  private async createLease(body: string): Promise<boolean> {
    try {
      const handle = await retrySharing(() => open(join(this.dir, LEASE_NAME), 'wx', 0o600));
      try {
        await handle.writeFile(body, 'utf8');
        await handle.sync();
      } finally {
        await handle.close();
      }
      return true;
    } catch (error) {
      if (errnoOf(error) === 'EEXIST') return false;
      throw error;
    }
  }

  private async replaceLease(body: string): Promise<void> {
    await this.writeFileAtomic(`${LEASE_NAME}.${randomHex().slice(0, 12)}.tmp`, LEASE_NAME, body);
  }

  private async readLease(): Promise<LeaseRecord | undefined> {
    try {
      const text = await this.readBounded(LEASE_NAME, MAX_LEASE_BYTES);
      return text === undefined ? undefined : parseLease(text);
    } catch (error) {
      if (isNexarError(error) && error.code === 'VALIDATION_ERROR') return undefined;
      throw error;
    }
  }

  private requireLease(): void {
    if (!this.leaseHeld) throw conflict('lease-required');
  }

  private async recover(): Promise<number> {
    let interruptedTurns = 0;
    for (const id of await this.sessionIds()) {
      interruptedTurns += await this.serialized(id, async () => {
        let current: OperatingSession | undefined;
        try {
          current = await this.readSession(id);
        } catch (error) {
          if (isNexarError(error) && error.code === 'VALIDATION_ERROR') return 0;
          throw error;
        }
        if (current === undefined) return 0;
        const result = interruptRunning(current, this.clock().toISOString());
        if (result.interrupted > 0) await this.writeSession(result.session);
        return result.interrupted;
      });
    }
    return interruptedTurns;
  }

  // ---------------------------------------------------------------- reads

  get(id: string): Promise<OperatingSession | undefined> {
    return sanitize(async () => {
      assertSessionId(id);
      return this.serialized(id, () => this.readSession(id));
    });
  }

  has(id: string): Promise<boolean> {
    return sanitize(async () => {
      assertSessionId(id);
      try {
        return (await lstat(join(this.dir, `${id}.json`))).isFile();
      } catch (error) {
        if (errnoOf(error) === 'ENOENT') return false;
        throw error;
      }
    });
  }

  /** Newest first, at most {@link MAX_LIST}; unreadable files are listed as unavailable. */
  list(
    options: { readonly limit?: number } = {},
  ): Promise<readonly (SessionSummary | UnavailableSession)[]> {
    return sanitize(async () => {
      const limit = Math.min(Math.max(1, Math.floor(options.limit ?? MAX_LIST)), MAX_LIST);
      const available: SessionSummary[] = [];
      const unavailable: UnavailableSession[] = [];
      for (const id of await this.sessionIds()) {
        try {
          const session = await this.serialized(id, () => this.readSession(id));
          if (session === undefined) continue;
          const last = session.turns[session.turns.length - 1];
          available.push({
            id: session.id,
            projectId: session.projectId,
            mode: session.mode,
            title: session.title,
            createdAt: session.createdAt,
            updatedAt: session.updatedAt,
            revision: session.revision,
            turnCount: session.turns.length,
            activeTurnId: session.activeTurnId,
            ...(last === undefined ? {} : { lastTurnState: last.state }),
          });
        } catch {
          unavailable.push({ id, unavailable: true });
        }
      }
      available.sort((a, b) =>
        a.updatedAt === b.updatedAt
          ? a.id.localeCompare(b.id)
          : b.updatedAt.localeCompare(a.updatedAt),
      );
      unavailable.sort((a, b) => a.id.localeCompare(b.id));
      return [...available, ...unavailable].slice(0, limit);
    });
  }

  // ------------------------------------------------------------ mutations

  create(request: CreateSessionRequest): Promise<OperatingSession> {
    return sanitize(async () => {
      this.requireLease();
      const id = `ses_${this.newId()}`;
      const session = createSession({ ...request, id, now: this.now() });
      return this.serialized(id, async () => {
        await this.ensureDir();
        try {
          await lstat(join(this.dir, `${id}.json`));
          throw conflict('session-exists');
        } catch (error) {
          if (errnoOf(error) !== 'ENOENT') throw error;
        }
        await this.writeSession(session);
        return session;
      });
    });
  }

  async beginTurn(
    sessionId: string,
    request: BeginTurnRequest,
    expectedRevision?: number,
  ): Promise<BeginTurnResult> {
    const turnId = `turn_${this.newId()}`;
    return this.update(
      sessionId,
      expectedRevision,
      (s, now) => beginTurn(s, { ...request, turnId, now }),
      (result) => (result.created ? MAX_SESSION_BYTES - SESSION_BYTES_HEADROOM : MAX_SESSION_BYTES),
    );
  }

  resolveConfirmation(
    sessionId: string,
    turnId: string,
    resolution: ConfirmationDecision,
    expectedRevision?: number,
  ): Promise<TurnMutation> {
    return this.update(sessionId, expectedRevision, (s, now) =>
      resolveConfirmation(s, turnId, resolution, now),
    );
  }

  linkTask(
    sessionId: string,
    turnId: string,
    task: TurnTaskLink,
    expectedRevision?: number,
  ): Promise<TurnMutation> {
    return this.update(sessionId, expectedRevision, (s, now) => linkTask(s, turnId, task, now));
  }

  updateTask(
    sessionId: string,
    turnId: string,
    taskId: string,
    patch: TaskUpdate,
    expectedRevision?: number,
  ): Promise<TurnMutation> {
    return this.update(sessionId, expectedRevision, (s, now) =>
      updateTask(s, turnId, taskId, patch, now),
    );
  }

  linkArtifacts(
    sessionId: string,
    turnId: string,
    artifacts: readonly ArtifactRef[],
    expectedRevision?: number,
  ): Promise<TurnMutation> {
    return this.update(sessionId, expectedRevision, (s, now) =>
      linkArtifacts(s, turnId, artifacts, now),
    );
  }

  linkApprovals(
    sessionId: string,
    turnId: string,
    approvalIds: readonly string[],
    expectedRevision?: number,
  ): Promise<TurnMutation> {
    return this.update(sessionId, expectedRevision, (s, now) =>
      linkApprovals(s, turnId, approvalIds, now),
    );
  }

  setContext(
    sessionId: string,
    turnId: string,
    context: ContextManifest,
    expectedRevision?: number,
  ): Promise<TurnMutation> {
    return this.update(sessionId, expectedRevision, (s, now) =>
      setContext(s, turnId, context, now),
    );
  }

  completeTurn(
    sessionId: string,
    turnId: string,
    input: CompleteTurnInput,
    expectedRevision?: number,
  ): Promise<TurnMutation> {
    return this.update(sessionId, expectedRevision, (s, now) =>
      completeTurn(s, turnId, input, now),
    );
  }

  async setMode(
    sessionId: string,
    mode: OperatingMode,
    expectedRevision?: number,
  ): Promise<OperatingSession> {
    const { session } = await this.update(sessionId, expectedRevision, (s, now) => ({
      session: setMode(s, mode, now),
    }));
    return session;
  }

  async rename(
    sessionId: string,
    title: string,
    expectedRevision?: number,
  ): Promise<OperatingSession> {
    const { session } = await this.update(sessionId, expectedRevision, (s, now) => ({
      session: renameSession(s, title, now),
    }));
    return session;
  }

  // ------------------------------------------------------------ internals

  private now(): string {
    return this.clock().toISOString();
  }

  /** Lease check, per-session serialization, re-read, revision check, pure transition, write. */
  private update<R extends { readonly session: OperatingSession }>(
    sessionId: string,
    expectedRevision: number | undefined,
    apply: (session: OperatingSession, now: string) => R,
    maxBytes: (result: R) => number = () => MAX_SESSION_BYTES,
  ): Promise<R> {
    return sanitize(async () => {
      assertSessionId(sessionId);
      this.requireLease();
      return this.serialized(sessionId, async () => {
        const current = await this.readSession(sessionId);
        if (current === undefined) {
          throw new NexarError('VALIDATION_ERROR', 'Unknown session', {
            details: { reason: 'unknown-session' },
          });
        }
        if (expectedRevision !== undefined && expectedRevision !== current.revision) {
          throw conflict('stale-revision', { revision: current.revision });
        }
        const result = apply(current, this.now());
        if (result.session !== current) await this.writeSession(result.session, maxBytes(result));
        return result;
      });
    });
  }

  private serialized<T>(id: string, task: () => Promise<T>): Promise<T> {
    const previous = this.chains.get(id) ?? Promise.resolve();
    const run = previous.then(task);
    const tail = run.then(
      () => undefined,
      () => undefined,
    );
    this.chains.set(id, tail);
    void tail.then(() => {
      if (this.chains.get(id) === tail) this.chains.delete(id);
    });
    return run;
  }

  private async sessionIds(): Promise<string[]> {
    let names: string[];
    try {
      names = await readdir(this.dir);
    } catch (error) {
      if (errnoOf(error) === 'ENOENT') return [];
      throw error;
    }
    const ids: string[] = [];
    for (const name of names) {
      const match = SESSION_FILE.exec(name);
      if (match?.[1] !== undefined) ids.push(match[1]);
    }
    return ids.sort();
  }

  private async ensureDir(): Promise<void> {
    await mkdir(this.dir, { recursive: true, mode: 0o700 });
    await chmod(this.dir, 0o700);
    await this.canonicalDir();
  }

  /** The directory must be a real directory (no symlink/junction) and stay the same one. */
  private async canonicalDir(): Promise<string | undefined> {
    let stats;
    try {
      stats = await lstat(this.dir);
    } catch (error) {
      if (errnoOf(error) === 'ENOENT') return undefined;
      throw error;
    }
    if (!stats.isDirectory()) throw unsafeDir();
    const real = await realpath(this.dir);
    if (this.canonical !== undefined && this.canonical !== real) throw unsafeDir();
    this.canonical = real;
    return real;
  }

  private async readSession(id: string): Promise<OperatingSession | undefined> {
    const text = await this.readBounded(`${id}.json`, MAX_SESSION_BYTES);
    return text === undefined ? undefined : parseSession(text, id);
  }

  /**
   * Reads a regular, single-link file inside the canonical directory without following links, and
   * confirms the opened handle is the file that was inspected. `undefined` when it does not exist.
   */
  private async readBounded(name: string, maxBytes: number): Promise<string | undefined> {
    const canonical = await this.canonicalDir();
    if (canonical === undefined) return undefined;
    const path = join(this.dir, name);
    let before: BigIntStats;
    try {
      before = await retrySharing(() => lstat(path, { bigint: true }));
    } catch (error) {
      if (errnoOf(error) === 'ENOENT') return undefined;
      throw error;
    }
    const limit = BigInt(maxBytes);
    if (!before.isFile() || before.nlink !== 1n || before.size > limit) throw unreadable();
    const handle = await retrySharing(() => open(path, 'r'));
    try {
      const after = await handle.stat({ bigint: true });
      if (!after.isFile() || !sameFile(before, after) || after.nlink !== 1n || after.size > limit) {
        throw unreadable();
      }
      if ((await realpath(path)) !== join(canonical, basename(path))) throw unreadable();
      const buffer = Buffer.alloc(Number(after.size));
      let filled = 0;
      while (filled < buffer.length) {
        const { bytesRead } = await handle.read(buffer, filled, buffer.length - filled, filled);
        if (bytesRead === 0) break;
        filled += bytesRead;
      }
      return buffer.toString('utf8', 0, filled);
    } finally {
      await handle.close();
    }
  }

  private async writeSession(
    session: OperatingSession,
    maxBytes: number = MAX_SESSION_BYTES,
  ): Promise<void> {
    const data = serializeSession(session);
    if (Buffer.byteLength(data, 'utf8') > maxBytes) {
      throw new NexarError('POLICY_REJECTED', 'Session is full', {
        details: { reason: 'session-full' },
      });
    }
    await this.ensureDir();
    await this.writeFileAtomic(
      `.${session.id}.${randomHex().slice(0, 12)}.tmp`,
      `${session.id}.json`,
      data,
    );
  }

  private async writeFileAtomic(tmpName: string, targetName: string, data: string): Promise<void> {
    const tmp = join(this.dir, tmpName);
    const target = join(this.dir, targetName);
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
    } catch (error) {
      await unlink(tmp).catch(() => undefined);
      throw error;
    }
  }
}
