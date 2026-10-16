import { randomBytes } from 'node:crypto';
import type { BigIntStats } from 'node:fs';
import { chmod, lstat, mkdir, open, realpath, rename, unlink } from 'node:fs/promises';
import { basename, join } from 'node:path';
import { NexarError, isNexarError } from '@nexar/contracts';
import { isValidMemoryText, parseRecord, serializeRecord } from './record.js';
import { MAX_REQUIRED_CONTEXT_CHARS, renderProjectMemory } from './render.js';
import {
  MAX_MEMORY_ENTRIES,
  MAX_MEMORY_FILE_BYTES,
  MAX_MEMORY_TEXT_CHARS,
  MEMORY_ID_PATTERN,
  MEMORY_PROJECT_ID_PATTERN,
  PROJECT_MEMORY_KINDS,
} from './types.js';
import type { ProjectMemoryEntry, ProjectMemoryInput, ProjectMemoryRecord } from './types.js';

const DIR_NAME = 'project-memory';
const SHARING_WAIT_MS = 1_000;
const SESSION_ID = /^ses_[0-9a-f]{32}$/;
const TURN_ID = /^turn_[0-9a-f]{32}$/;
/** Windows treats these base names as devices even with an extension. */
const WINDOWS_DEVICE = /^(con|prn|aux|nul|com[1-9]|lpt[1-9])(\..*)?$/;

export interface FileProjectMemoryStoreOptions {
  /** The `<state>/.nexar` directory; records live in `<stateDir>/project-memory/`. */
  readonly stateDir: string;
  /** Mutations need the single-writer lease (B9); reads never do. */
  readonly isWriter: () => boolean;
  /** Returns 32 lowercase hex characters. */
  readonly newId?: () => string;
  readonly clock?: () => Date;
}

function conflict(reason: string, extra: Readonly<Record<string, unknown>> = {}): NexarError {
  return new NexarError('CONFLICT', `Project memory conflict: ${reason}`, {
    details: { reason, ...extra },
  });
}

function invalid(kind: string): NexarError {
  return new NexarError('VALIDATION_ERROR', `Invalid ${kind}`, { details: { kind } });
}

function unreadable(): NexarError {
  return new NexarError('VALIDATION_ERROR', 'Project memory record is unreadable', {
    details: { reason: 'corrupt-record' },
  });
}

function unsafeDir(): NexarError {
  return new NexarError('POLICY_REJECTED', 'Project memory directory is not safe to use', {
    details: { reason: 'unsafe-directory' },
  });
}

function full(): NexarError {
  return new NexarError('POLICY_REJECTED', 'Project memory is full', {
    details: { reason: 'memory-full' },
  });
}

/** Required context is never truncated, so an add that would make it unrenderable is refused. */
function budget(): NexarError {
  return new NexarError('POLICY_REJECTED', 'Project memory is full; remove an entry first', {
    details: { reason: 'required-context-budget' },
  });
}

function fitsRequiredContext(entries: readonly ProjectMemoryEntry[]): boolean {
  try {
    return renderProjectMemory(entries).block.length <= MAX_REQUIRED_CONTEXT_CHARS;
  } catch (error) {
    if (isNexarError(error) && error.details?.reason === 'required-context-overflow') return false;
    throw error;
  }
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
    throw new NexarError('INTERNAL_ERROR', 'Project memory storage failure', {
      details: errno === undefined ? { reason: 'io-error' } : { reason: 'io-error', errno },
    });
  }
}

/** Bound Windows sharing retries at the file operation (same policy as the session store). */
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

function sameFile(a: BigIntStats, b: BigIntStats): boolean {
  return a.dev === b.dev && a.ino === b.ino;
}

function randomHex(): string {
  return randomBytes(16).toString('hex');
}

/** The project id is validated first; `:` and device names are not safe file names on Windows. */
function fileNameFor(projectId: string): string {
  if (!MEMORY_PROJECT_ID_PATTERN.test(projectId)) throw invalid('ProjectId');
  const safe = projectId.replaceAll(':', '%3a');
  return `${WINDOWS_DEVICE.test(safe) ? '_' : ''}${safe}.json`;
}

function checkText(text: unknown): string {
  if (typeof text !== 'string') throw invalid('MemoryText');
  const trimmed = text.trim();
  if (trimmed.length > MAX_MEMORY_TEXT_CHARS || !isValidMemoryText(trimmed)) {
    throw invalid('MemoryText');
  }
  return trimmed;
}

/**
 * One JSON file per project (ADR-030 §7): directory 0700, files 0600, exclusive temp file plus
 * atomic replace, bounded reads that refuse links and non-regular files, strict schema, serialized
 * per project. Only owner actions call `add`/`remove`, and only while the sessions lease is held.
 */
export class FileProjectMemoryStore {
  private readonly dir: string;
  private readonly isWriter: () => boolean;
  private readonly newId: () => string;
  private readonly clock: () => Date;
  private readonly chains = new Map<string, Promise<void>>();
  private canonical: string | undefined;

  constructor(options: FileProjectMemoryStoreOptions) {
    this.dir = join(options.stateDir, DIR_NAME);
    this.isWriter = options.isWriter;
    this.newId = options.newId ?? randomHex;
    this.clock = options.clock ?? (() => new Date());
  }

  /** A missing file is an empty memory; a corrupt one is `VALIDATION_ERROR` and is never rewritten. */
  list(projectId: string): Promise<readonly ProjectMemoryEntry[]> {
    return sanitize(async () => {
      const file = fileNameFor(projectId);
      return (await this.read(file, projectId)).entries;
    });
  }

  add(
    projectId: string,
    input: ProjectMemoryInput,
    expectedRevision?: number,
  ): Promise<ProjectMemoryEntry> {
    return sanitize(async () => {
      const file = fileNameFor(projectId);
      if (!PROJECT_MEMORY_KINDS.includes(input.kind)) throw invalid('MemoryKind');
      const text = checkText(input.text);
      if (input.sessionId !== undefined && !SESSION_ID.test(input.sessionId)) {
        throw invalid('SessionId');
      }
      if (input.turnId !== undefined && !TURN_ID.test(input.turnId)) throw invalid('TurnId');
      this.requireWriter();
      return this.serialized(projectId, async () => {
        const current = await this.read(file, projectId);
        if (expectedRevision !== undefined && expectedRevision !== current.revision) {
          throw conflict('stale-revision', { revision: current.revision });
        }
        const existing = current.entries.find((e) => e.kind === input.kind && e.text === text);
        if (existing !== undefined) return existing;
        if (current.entries.length >= MAX_MEMORY_ENTRIES) throw full();
        const id = `mem_${this.newId()}`;
        if (!MEMORY_ID_PATTERN.test(id) || current.entries.some((e) => e.id === id)) {
          throw invalid('MemoryId');
        }
        const entry: ProjectMemoryEntry = {
          id,
          kind: input.kind,
          text,
          createdAt: this.clock().toISOString(),
          source: 'owner',
          ...(input.sessionId === undefined ? {} : { sessionId: input.sessionId }),
          ...(input.turnId === undefined ? {} : { turnId: input.turnId }),
        };
        const entries = [...current.entries, entry];
        if (!fitsRequiredContext(entries)) throw budget();
        await this.write(file, {
          schemaVersion: 1,
          projectId,
          revision: current.revision + 1,
          entries,
        });
        return entry;
      });
    });
  }

  /** Removing an unknown id is a no-op. */
  remove(projectId: string, entryId: string): Promise<void> {
    return sanitize(async () => {
      const file = fileNameFor(projectId);
      if (typeof entryId !== 'string' || !MEMORY_ID_PATTERN.test(entryId))
        throw invalid('MemoryId');
      this.requireWriter();
      await this.serialized(projectId, async () => {
        const current = await this.read(file, projectId);
        if (!current.entries.some((e) => e.id === entryId)) return;
        await this.write(file, {
          schemaVersion: 1,
          projectId,
          revision: current.revision + 1,
          entries: current.entries.filter((e) => e.id !== entryId),
        });
      });
    });
  }

  // ------------------------------------------------------------ internals

  private requireWriter(): void {
    if (!this.isWriter()) throw conflict('not-writer');
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

  private async read(file: string, projectId: string): Promise<ProjectMemoryRecord> {
    const text = await this.readBounded(file);
    return text === undefined
      ? { schemaVersion: 1, projectId, revision: 0, entries: [] }
      : parseRecord(text, projectId);
  }

  private async write(file: string, record: ProjectMemoryRecord): Promise<void> {
    const data = serializeRecord(record);
    if (Buffer.byteLength(data, 'utf8') > MAX_MEMORY_FILE_BYTES) throw full();
    await this.ensureDir();
    const tmp = join(this.dir, `.${file}.${randomHex().slice(0, 12)}.tmp`);
    const target = join(this.dir, file);
    try {
      const handle = await open(tmp, 'wx', 0o600);
      try {
        await handle.writeFile(data, 'utf8');
        await handle.sync();
      } finally {
        await handle.close();
      }
      // The destination is replaced, never removed first; Windows scanners may briefly deny it.
      await retrySharing(() => rename(tmp, target));
      await chmod(target, 0o600);
    } catch (error) {
      await unlink(tmp).catch(() => undefined);
      throw error;
    }
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

  /**
   * Reads a regular, single-link file inside the canonical directory without following links, and
   * confirms the opened handle is the file that was inspected. `undefined` when it does not exist.
   */
  private async readBounded(name: string): Promise<string | undefined> {
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
    const limit = BigInt(MAX_MEMORY_FILE_BYTES);
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
}
