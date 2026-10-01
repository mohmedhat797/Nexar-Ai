import { timingSafeEqual } from 'node:crypto';
import { chmod, mkdir, open, readFile, rename, rm } from 'node:fs/promises';
import { basename, dirname, join } from 'node:path';
import { NexarError } from '@nexar/contracts';
import {
  generateToken,
  hashToken,
  isValidClientId,
  isWellFormedToken,
  tokenHint,
  type ClientIdentity,
  type ClientRecord,
  type ClientScopes,
  type PublicClient,
} from './credentials.js';

const FILE_VERSION = 1;
const SHA256_HEX = /^[0-9a-f]{64}$/;

function configError(message: string): NexarError {
  return new NexarError('CONFIGURATION_ERROR', message);
}

function authFailed(): NexarError {
  return new NexarError('AUTH_REQUIRED', 'Authentication failed');
}

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

function isIsoDate(v: unknown): v is string {
  return typeof v === 'string' && !Number.isNaN(Date.parse(v));
}

function parseStringList(v: unknown, field: string): readonly string[] {
  if (!Array.isArray(v) || !v.every((x) => typeof x === 'string' && x.length > 0)) {
    throw configError(`Invalid client registry: ${field} must be a list of strings`);
  }
  return Object.freeze([...(v as string[])]);
}

function parseScopes(v: unknown): ClientScopes {
  if (!isRecord(v)) throw configError('Invalid client registry: scopes must be an object');
  const scopes: ClientScopes = {
    tools: parseStringList(v.tools, 'scopes.tools'),
    taskKinds: parseStringList(v.taskKinds, 'scopes.taskKinds'),
    projects: parseStringList(v.projects, 'scopes.projects'),
    workflows: parseStringList(v.workflows, 'scopes.workflows'),
  };
  if (v.maxCostUsd === undefined) return Object.freeze(scopes);
  if (typeof v.maxCostUsd !== 'number' || !Number.isFinite(v.maxCostUsd) || v.maxCostUsd < 0) {
    throw configError('Invalid client registry: scopes.maxCostUsd must be a non-negative number');
  }
  return Object.freeze({ ...scopes, maxCostUsd: v.maxCostUsd });
}

function parseClient(v: unknown): ClientRecord {
  if (!isRecord(v)) throw configError('Invalid client registry: client must be an object');
  const { id, displayName, tokenSha256, tokenHint: hint, createdAt, revokedAt } = v;
  if (typeof id !== 'string' || !isValidClientId(id)) {
    throw configError('Invalid client registry: bad client id');
  }
  if (typeof tokenSha256 !== 'string' || !SHA256_HEX.test(tokenSha256)) {
    throw configError('Invalid client registry: bad token hash');
  }
  if (typeof hint !== 'string' || hint.length !== 4) {
    throw configError('Invalid client registry: bad token hint');
  }
  if (!isIsoDate(createdAt)) throw configError('Invalid client registry: bad createdAt');
  if (displayName !== undefined && typeof displayName !== 'string') {
    throw configError('Invalid client registry: bad displayName');
  }
  if (revokedAt !== undefined && !isIsoDate(revokedAt)) {
    throw configError('Invalid client registry: bad revokedAt');
  }
  return Object.freeze({
    id,
    ...(displayName === undefined ? {} : { displayName }),
    tokenSha256,
    tokenHint: hint,
    createdAt,
    ...(revokedAt === undefined ? {} : { revokedAt }),
    scopes: parseScopes(v.scopes),
  });
}

function parseFile(text: string): readonly ClientRecord[] {
  let data: unknown;
  try {
    data = JSON.parse(text);
  } catch {
    throw configError('Invalid client registry: not valid JSON');
  }
  if (!isRecord(data) || data.version !== FILE_VERSION || !Array.isArray(data.clients)) {
    throw configError('Invalid client registry: unexpected structure');
  }
  const clients = (data.clients as unknown[]).map(parseClient);
  if (new Set(clients.map((c) => c.id)).size !== clients.length) {
    throw configError('Invalid client registry: duplicate client id');
  }
  return clients;
}

function toPublic(record: ClientRecord): PublicClient {
  return Object.freeze({
    id: record.id,
    ...(record.displayName === undefined ? {} : { displayName: record.displayName }),
    tokenHint: record.tokenHint,
    createdAt: record.createdAt,
    ...(record.revokedAt === undefined ? {} : { revokedAt: record.revokedAt }),
    scopes: record.scopes,
  });
}

export interface AddClientOptions {
  readonly displayName?: string;
}

export interface RegistryOptions {
  readonly clock?: () => Date;
}

/**
 * Clients and their hashed credentials, persisted in a JSON file (dir 0700, file 0600, atomic
 * writes). A corrupt file fails closed with `CONFIGURATION_ERROR`; it never means "allow all".
 *
 * `authenticate` reads the in-memory snapshot. Long-lived servers (the MCP server) must call
 * {@link ClientRegistry.reload} before each request so that a revocation written by the CLI takes
 * effect at once.
 */
export class ClientRegistry {
  private clients: readonly ClientRecord[];
  private writes: Promise<unknown> = Promise.resolve();

  private constructor(
    private readonly filePath: string,
    clients: readonly ClientRecord[],
    private readonly clock: () => Date,
  ) {
    this.clients = clients;
  }

  /** Opens the registry; a missing file is an empty registry, a corrupt one is an error. */
  static async open(filePath: string, options: RegistryOptions = {}): Promise<ClientRegistry> {
    const clock = options.clock ?? (() => new Date());
    return new ClientRegistry(filePath, await ClientRegistry.read(filePath), clock);
  }

  private static async read(filePath: string): Promise<readonly ClientRecord[]> {
    let text: string;
    try {
      text = await readFile(filePath, 'utf8');
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return [];
      throw new NexarError('CONFIGURATION_ERROR', 'Cannot read client registry', { cause: error });
    }
    return parseFile(text);
  }

  /** Re-reads the file so external changes (revocations) apply to subsequent `authenticate` calls. */
  async reload(): Promise<void> {
    this.clients = await ClientRegistry.read(this.filePath);
  }

  /** Creates a client. The returned token is the only time the plaintext credential is available. */
  async add(
    id: string,
    scopes: ClientScopes,
    options: AddClientOptions = {},
  ): Promise<{ client: PublicClient; token: string }> {
    if (!isValidClientId(id)) throw configError('Invalid client id');
    const validated = parseScopes(scopes);
    return this.mutate((current) => {
      if (current.some((c) => c.id === id)) throw configError('Client already exists');
      const token = generateToken();
      const record: ClientRecord = Object.freeze({
        id,
        ...(options.displayName === undefined ? {} : { displayName: options.displayName }),
        tokenSha256: hashToken(token),
        tokenHint: tokenHint(token),
        createdAt: this.clock().toISOString(),
        scopes: validated,
      });
      return { next: [...current, record], result: { client: toPublic(record), token } };
    });
  }

  /** Marks a client revoked. Already-revoked clients keep their original `revokedAt`. */
  async revoke(id: string): Promise<PublicClient> {
    return this.mutate((current) => {
      const existing = current.find((c) => c.id === id);
      if (existing === undefined) throw configError('Unknown client');
      const updated: ClientRecord =
        existing.revokedAt === undefined
          ? Object.freeze({ ...existing, revokedAt: this.clock().toISOString() })
          : existing;
      return {
        next: current.map((c) => (c.id === id ? updated : c)),
        result: toPublic(updated),
      };
    });
  }

  /** Clients without credential material. */
  list(): PublicClient[] {
    return this.clients.map(toPublic);
  }

  /**
   * Verifies a presented token. Every failure (missing, malformed, unknown, revoked) throws the
   * same `AUTH_REQUIRED` error with no details, and every stored hash is compared in constant time
   * with no early exit, so neither the error nor the timing reveals which clients exist.
   */
  authenticate(token: string | undefined): ClientIdentity {
    const wellFormed = token !== undefined && isWellFormedToken(token);
    const presented = Buffer.from(hashToken(wellFormed ? token : ''), 'hex');
    let matched: ClientRecord | undefined;
    for (const client of this.clients) {
      const equal = timingSafeEqual(presented, Buffer.from(client.tokenSha256, 'hex'));
      if (equal && wellFormed && client.revokedAt === undefined) matched = client;
    }
    if (matched === undefined) throw authFailed();
    return Object.freeze({ clientId: matched.id, scopes: matched.scopes });
  }

  /** Serializes read-modify-write cycles so concurrent calls cannot lose updates. */
  private mutate<T>(
    change: (current: readonly ClientRecord[]) => { next: readonly ClientRecord[]; result: T },
  ): Promise<T> {
    const run = async (): Promise<T> => {
      // Start from disk so changes made by other processes are not overwritten.
      const current = await ClientRegistry.read(this.filePath);
      const { next, result } = change(current);
      await this.persist(next);
      this.clients = next;
      return result;
    };
    const result = this.writes.then(run);
    this.writes = result.catch(() => undefined);
    return result;
  }

  private async persist(clients: readonly ClientRecord[]): Promise<void> {
    const dir = dirname(this.filePath);
    await mkdir(dir, { recursive: true, mode: 0o700 });
    await chmod(dir, 0o700);
    const tmp = join(dir, `.${basename(this.filePath)}.${process.pid}.${Date.now()}.tmp`);
    const body = JSON.stringify({ version: FILE_VERSION, clients }, null, 2) + '\n';
    try {
      const handle = await open(tmp, 'wx', 0o600);
      try {
        await handle.writeFile(body, 'utf8');
        await handle.sync();
      } finally {
        await handle.close();
      }
      await chmod(tmp, 0o600);
      await rename(tmp, this.filePath);
    } catch (error) {
      await rm(tmp, { force: true });
      throw new NexarError('CONFIGURATION_ERROR', 'Cannot write client registry', { cause: error });
    }
  }
}
