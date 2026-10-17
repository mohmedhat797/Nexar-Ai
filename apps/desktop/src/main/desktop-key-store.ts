import { randomBytes } from 'node:crypto';
import {
  closeSync,
  constants,
  fstatSync,
  lstatSync,
  openSync,
  readSync,
  realpathSync,
} from 'node:fs';
import type { BigIntStats } from 'node:fs';
import { open, rename, unlink } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { NexarError, type SecretResolver } from '@nexar/contracts';

export const credentialNames = [
  'ANTHROPIC_API_KEY',
  'OPENAI_API_KEY',
  'GEMINI_API_KEY',
  'DEEPSEEK_API_KEY',
  'OPENROUTER_API_KEY',
  'GROQ_API_KEY',
  'MISTRAL_API_KEY',
  'XAI_API_KEY',
] as const;

/**
 * Structured secrets (a token record, base64url-encoded by its owner) live under their own names:
 * they are never readable through 
esolveSecret, so config cannot hand one to an adapter as a key.
 */
export const blobNames = ['chatgpt-plan'] as const;

type EntryName = string;
const NAMES: ReadonlySet<string> = new Set(credentialNames);
const BLOB_NAMES: ReadonlySet<string> = new Set(blobNames);

export const OWNER_KEY_PATTERN = /^[A-Z0-9_]+_API_KEY__C[A-Za-z0-9_-]+$/;
export const OWNER_BLOB_PATTERN = /^[a-z0-9_.:-]{3,64}$/;

export function isValidCredentialName(name: string): boolean {
  return NAMES.has(name) || OWNER_KEY_PATTERN.test(name);
}

export function isValidBlobName(name: string): boolean {
  return BLOB_NAMES.has(name) || OWNER_BLOB_PATTERN.test(name);
}

const KEY = /^[A-Za-z0-9_.:-]{16,4096}$/;
const LAST_FOUR = /^[A-Za-z0-9_.:-]{4}$/;
const BLOB = /^[A-Za-z0-9_-]{16,24576}$/;
/** Blobs record no part of their content as a hint. */
const BLOB_TAG = '----';
const LINUX_BACKENDS: ReadonlySet<string> = new Set([
  'gnome_libsecret',
  'kwallet',
  'kwallet5',
  'kwallet6',
]);
const MAX_FILE_BYTES = 256 * 1024;
const MAX_CIPHER_BYTES = 32 * 1024;
const queues = new Map<string, Promise<void>>();

export interface DesktopEncryption {
  isEncryptionAvailable: () => boolean;
  getSelectedStorageBackend?: () => string;
  encryptString: (value: string) => Buffer;
  decryptString: (value: Buffer) => string;
}

export interface DesktopKeyStoreOptions {
  readonly userData: string;
  readonly encryption: DesktopEncryption;
  readonly platform?: NodeJS.Platform;
}

/** Main-only atomic encrypted-store mutation. Undefined value means deletion. */
export interface CredentialChange {
  readonly kind: 'key' | 'blob';
  readonly name: string;
  readonly value?: string;
}

interface Entry {
  readonly ciphertext: string;
  readonly lastFour: string;
}

interface Document {
  readonly version: 1;
  readonly entries: Partial<Record<EntryName, Entry>>;
}

interface DirectoryIdentity {
  readonly path: string;
  readonly stats: BigIntStats;
}

interface Loaded {
  readonly document: Document;
  readonly directory?: DirectoryIdentity;
  readonly file?: BigIntStats;
}

function invalid(): NexarError {
  return new NexarError('VALIDATION_ERROR', 'Invalid Desktop credential');
}

function unavailable(): NexarError {
  return new NexarError('AUTH_REQUIRED', 'Desktop credential storage is unavailable');
}

function nameOf(name: string): string {
  if (!isValidCredentialName(name)) throw invalid();
  return name;
}

function blobNameOf(name: string): string {
  if (!isValidBlobName(name)) throw invalid();
  return name;
}

function errno(error: unknown): string | undefined {
  return (error as NodeJS.ErrnoException | null)?.code;
}

function sameFile(a: BigIntStats, b: BigIntStats): boolean {
  return a.dev === b.dev && a.ino === b.ino;
}

function object(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function exactKeys(value: Record<string, unknown>, expected: readonly string[]): boolean {
  const keys = Object.keys(value);
  return keys.length === expected.length && keys.every((key) => expected.includes(key));
}

function decodeCipher(value: unknown): Buffer {
  if (
    typeof value !== 'string' ||
    value.length === 0 ||
    value.length > 4 * Math.ceil(MAX_CIPHER_BYTES / 3)
  ) {
    throw unavailable();
  }
  const buffer = Buffer.from(value, 'base64');
  if (
    buffer.length === 0 ||
    buffer.length > MAX_CIPHER_BYTES ||
    buffer.toString('base64') !== value
  ) {
    throw unavailable();
  }
  return buffer;
}

function parseDocument(text: string): Document {
  const value: unknown = JSON.parse(text);
  if (
    !object(value) ||
    !exactKeys(value, ['version', 'entries']) ||
    value['version'] !== 1 ||
    !object(value['entries'])
  ) {
    throw unavailable();
  }
  const entries: Document['entries'] = {};
  for (const [name, entry] of Object.entries(value['entries'])) {
    if (
      !(isValidCredentialName(name) || isValidBlobName(name)) ||
      !object(entry) ||
      !exactKeys(entry, ['ciphertext', 'lastFour']) ||
      typeof entry['lastFour'] !== 'string' ||
      !LAST_FOUR.test(entry['lastFour'])
    ) {
      throw unavailable();
    }
    decodeCipher(entry['ciphertext']);
    entries[name] = {
      ciphertext: entry['ciphertext'] as string,
      lastFour: entry['lastFour'],
    };
  }
  return { version: 1, entries };
}

/**
 * Main-process only: encrypted state under the already-private Desktop userData directory.
 * No plaintext cache, startup decryption or environment fallback. Files are bounded, regular,
 * single-link and identity checked; POSIX reads use O_NOFOLLOW. Path checks do not claim
 * handle-based containment against a concurrent process running as the same OS user.
 */
export class DesktopKeyStore {
  private readonly dir: string;
  private readonly platform: NodeJS.Platform;
  private readonly encryption: DesktopEncryption;
  private identity: DirectoryIdentity | undefined;

  constructor(options: DesktopKeyStoreOptions) {
    this.dir = resolve(options.userData);
    this.platform = options.platform ?? process.platform;
    this.encryption = options.encryption;
  }

  availability(): boolean {
    try {
      if (!this.encryption.isEncryptionAvailable()) return false;
      if (this.platform === 'linux') {
        const backend = this.encryption.getSelectedStorageBackend?.();
        if (backend === undefined || !LINUX_BACKENDS.has(backend)) return false;
      }
      return true;
    } catch {
      return false;
    }
  }

  readonly resolveSecret: SecretResolver = (requestedName) => {
    const name = nameOf(requestedName);
    try {
      const entry = this.load().document.entries[name];
      if (entry === undefined) return undefined;
      if (!this.availability()) throw unavailable();
      const value = this.encryption.decryptString(decodeCipher(entry.ciphertext));
      if (typeof value !== 'string' || !KEY.test(value) || value.slice(-4) !== entry.lastFour) {
        throw unavailable();
      }
      return value;
    } catch {
      throw unavailable();
    }
  };

  metadata(requestedName: string): { present: boolean; lastFour?: string } {
    const name = nameOf(requestedName);
    try {
      const entry = this.load().document.entries[name];
      return entry === undefined ? { present: false } : { present: true, lastFour: entry.lastFour };
    } catch {
      throw unavailable();
    }
  }

  async save(requestedName: string, key: string): Promise<void> {
    const name = nameOf(requestedName);
    if (typeof key !== 'string' || !KEY.test(key)) throw invalid();
    await this.put(name, key, key.slice(-4));
  }

  async remove(requestedName: string): Promise<void> {
    await this.delete(nameOf(requestedName));
  }

  /** Stores a structured secret (base64url text) atomically, replacing any previous value. */
  async saveBlob(requestedName: string, value: string): Promise<void> {
    const name = blobNameOf(requestedName);
    if (typeof value !== 'string' || !BLOB.test(value)) throw invalid();
    await this.put(name, value, BLOB_TAG);
  }

  /** Decrypts on demand; `undefined` when nothing is stored. Never cached. */
  readBlob(requestedName: string): string | undefined {
    const name = blobNameOf(requestedName);
    try {
      const entry = this.load().document.entries[name];
      if (entry === undefined) return undefined;
      if (!this.availability()) throw unavailable();
      const value = this.encryption.decryptString(decodeCipher(entry.ciphertext));
      if (typeof value !== 'string' || !BLOB.test(value)) throw unavailable();
      return value;
    } catch {
      throw unavailable();
    }
  }

  async removeBlob(requestedName: string): Promise<void> {
    await this.delete(blobNameOf(requestedName));
  }

  /** Credentials and a reference-only recovery journal commit in the same guarded file replacement. */
  async batch(changes: readonly CredentialChange[]): Promise<void> {
    await this.serialized(async () => {
      const loaded = this.load();
      const entries = { ...loaded.document.entries };
      for (const change of changes) {
        const name = change.kind === 'key' ? nameOf(change.name) : blobNameOf(change.name);
        if (change.value === undefined) {
          delete entries[name];
          continue;
        }
        if (!(change.kind === 'key' ? KEY : BLOB).test(change.value)) throw invalid();
        if (!this.availability()) throw unavailable();
        let encrypted: Buffer;
        try {
          encrypted = this.encryption.encryptString(change.value);
        } catch {
          throw unavailable();
        }
        if (
          !Buffer.isBuffer(encrypted) ||
          encrypted.length === 0 ||
          encrypted.length > MAX_CIPHER_BYTES
        )
          throw unavailable();
        entries[name] = {
          ciphertext: encrypted.toString('base64'),
          lastFour: change.kind === 'key' ? change.value.slice(-4) : BLOB_TAG,
        };
      }
      await this.write({ ...loaded, document: { version: 1, entries } });
    });
  }

  private async put(name: EntryName, secret: string, lastFour: string): Promise<void> {
    let entry: Entry;
    try {
      if (!this.availability()) throw unavailable();
      const encrypted = this.encryption.encryptString(secret);
      if (
        !Buffer.isBuffer(encrypted) ||
        encrypted.length === 0 ||
        encrypted.length > MAX_CIPHER_BYTES
      ) {
        throw unavailable();
      }
      entry = { ciphertext: encrypted.toString('base64'), lastFour };
    } catch {
      throw unavailable();
    }
    await this.serialized(async () => {
      const loaded = this.load();
      loaded.document.entries[name] = entry;
      await this.write(loaded);
    });
  }

  private async delete(name: EntryName): Promise<void> {
    await this.serialized(async () => {
      const loaded = this.load();
      if (loaded.document.entries[name] === undefined) return;
      delete loaded.document.entries[name];
      await this.write(loaded);
    });
  }

  private privateMode(stats: BigIntStats): boolean {
    if (this.platform === 'win32') return true; // Existing Desktop guard supplies the inherited DACL.
    const uid = process.getuid?.();
    return (stats.mode & 0o077n) === 0n && (uid === undefined || stats.uid === BigInt(uid));
  }

  private directory(): DirectoryIdentity | undefined {
    let stats: BigIntStats;
    try {
      stats = lstatSync(this.dir, { bigint: true });
    } catch (error) {
      if (errno(error) === 'ENOENT' && this.identity === undefined) return undefined;
      throw unavailable();
    }
    if (!stats.isDirectory() || stats.isSymbolicLink() || !this.privateMode(stats))
      throw unavailable();
    const path = realpathSync(this.dir);
    if (
      this.identity !== undefined &&
      (!sameFile(stats, this.identity.stats) || path !== this.identity.path)
    ) {
      throw unavailable();
    }
    const result = { path, stats };
    this.identity ??= result;
    return result;
  }

  private validFile(stats: BigIntStats): boolean {
    return (
      stats.isFile() &&
      !stats.isSymbolicLink() &&
      stats.nlink === 1n &&
      stats.size <= BigInt(MAX_FILE_BYTES) &&
      this.privateMode(stats)
    );
  }

  private fileStats(path: string): BigIntStats | undefined {
    try {
      const stats = lstatSync(path, { bigint: true });
      if (!this.validFile(stats)) throw unavailable();
      return stats;
    } catch (error) {
      if (errno(error) === 'ENOENT') return undefined;
      throw error;
    }
  }

  private noFollow(): number {
    return this.platform === 'win32' ? 0 : constants.O_NOFOLLOW;
  }

  private load(): Loaded {
    const empty: Document = { version: 1, entries: {} };
    const directory = this.directory();
    if (directory === undefined) return { document: empty };
    const path = join(directory.path, 'credentials.json');
    const before = this.fileStats(path);
    if (before === undefined) return { document: empty, directory };
    const descriptor = openSync(path, constants.O_RDONLY | this.noFollow());
    try {
      const opened = fstatSync(descriptor, { bigint: true });
      if (!this.validFile(opened) || !sameFile(before, opened) || realpathSync(path) !== path) {
        throw unavailable();
      }
      const buffer = Buffer.alloc(Number(opened.size));
      let filled = 0;
      while (filled < buffer.length) {
        const count = readSync(descriptor, buffer, filled, buffer.length - filled, filled);
        if (count === 0) throw unavailable();
        filled += count;
      }
      const after = fstatSync(descriptor, { bigint: true });
      const current = this.fileStats(path);
      if (
        current === undefined ||
        !sameFile(opened, current) ||
        !this.validFile(after) ||
        after.size !== opened.size ||
        after.mtimeNs !== opened.mtimeNs ||
        current.mtimeNs !== after.mtimeNs ||
        this.directory()?.path !== directory.path
      ) {
        throw unavailable();
      }
      return { document: parseDocument(buffer.toString('utf8')), directory, file: after };
    } finally {
      closeSync(descriptor);
    }
  }

  private serialized(operation: () => Promise<void>): Promise<void> {
    const key = this.platform === 'win32' ? this.dir.toLowerCase() : this.dir;
    const previous = queues.get(key) ?? Promise.resolve();
    const run = previous.then(operation).catch(() => {
      throw unavailable();
    });
    const tail = run.then(
      () => undefined,
      () => undefined,
    );
    queues.set(key, tail);
    void tail.then(() => {
      if (queues.get(key) === tail) queues.delete(key);
    });
    return run;
  }

  private assertTarget(loaded: Loaded, target: string): void {
    if (this.directory()?.path !== loaded.directory?.path) throw unavailable();
    const current = this.fileStats(target);
    if (
      loaded.file === undefined
        ? current !== undefined
        : current === undefined ||
          !sameFile(current, loaded.file) ||
          current.mtimeNs !== loaded.file.mtimeNs ||
          current.size !== loaded.file.size
    ) {
      throw unavailable();
    }
  }

  private async write(loaded: Loaded): Promise<void> {
    if (loaded.directory === undefined) throw unavailable();
    const data = Buffer.from(JSON.stringify(loaded.document) + '\n', 'utf8');
    if (data.length > MAX_FILE_BYTES) throw unavailable();
    const target = join(loaded.directory.path, 'credentials.json');
    const temp = join(loaded.directory.path, `.credentials-${randomBytes(12).toString('hex')}.tmp`);
    let tempIdentity: BigIntStats | undefined;
    try {
      this.assertTarget(loaded, target);
      const handle = await open(
        temp,
        constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | this.noFollow(),
        0o600,
      );
      try {
        tempIdentity = await handle.stat({ bigint: true });
        if (!this.validFile(tempIdentity)) throw unavailable();
        this.assertTarget(loaded, target);
        await handle.writeFile(data);
        await handle.sync();
        const after = await handle.stat({ bigint: true });
        if (
          !this.validFile(after) ||
          !sameFile(after, tempIdentity) ||
          after.size !== BigInt(data.length)
        ) {
          throw unavailable();
        }
        tempIdentity = after;
      } finally {
        await handle.close();
      }
      const deadline = Date.now() + 1_000;
      for (;;) {
        this.assertTarget(loaded, target);
        const currentTemp = this.fileStats(temp);
        if (currentTemp === undefined || !sameFile(currentTemp, tempIdentity)) throw unavailable();
        try {
          await rename(temp, target);
          break;
        } catch (error) {
          if (
            this.platform !== 'win32' ||
            !['EPERM', 'EACCES', 'EBUSY'].includes(errno(error) ?? '') ||
            Date.now() >= deadline
          ) {
            throw error;
          }
          await new Promise((done) => setTimeout(done, 10));
        }
      }
      if (this.directory()?.path !== loaded.directory.path) throw unavailable();
      const final = this.fileStats(target);
      if (final === undefined || !sameFile(final, tempIdentity)) throw unavailable();
    } catch {
      // Only remove our own encrypted temp file, and only inside the unchanged private parent.
      try {
        if (tempIdentity !== undefined && this.directory()?.path === loaded.directory.path) {
          const current = this.fileStats(temp);
          if (current !== undefined && sameFile(current, tempIdentity)) await unlink(temp);
        }
      } catch {
        /* Best effort; never remove a redirected or replaced path. */
      }
      throw unavailable();
    }
  }
}
