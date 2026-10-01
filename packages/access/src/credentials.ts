import { createHash, randomBytes } from 'node:crypto';

/** Prefix that makes Nexar client tokens recognizable (e.g. by secret scanners). */
export const TOKEN_PREFIX = 'nxr_';

const TOKEN_PATTERN = /^nxr_[A-Za-z0-9_-]{43}$/;
const CLIENT_ID_PATTERN = /^[a-z][a-z0-9-]{1,62}$/;

/** `'*'` as the single element means "any". */
export const ANY_SCOPE = '*';

/** What a client may do. No implicit defaults: callers must state every dimension. */
export interface ClientScopes {
  readonly tools: readonly string[];
  readonly taskKinds: readonly string[];
  readonly projects: readonly string[];
  readonly workflows: readonly string[];
  readonly maxCostUsd?: number;
}

/** Stored client record. `tokenSha256` never leaves the registry (see {@link PublicClient}). */
export interface ClientRecord {
  readonly id: string;
  readonly displayName?: string;
  readonly tokenSha256: string;
  /** Last 4 characters of the token, to help a human tell credentials apart. */
  readonly tokenHint: string;
  readonly createdAt: string;
  readonly revokedAt?: string;
  readonly scopes: ClientScopes;
}

/** A client record without credential material. */
export type PublicClient = Omit<ClientRecord, 'tokenSha256'>;

/** The authenticated caller, as handed to authorization and audit. */
export interface ClientIdentity {
  readonly clientId: string;
  readonly scopes: ClientScopes;
}

/** True if `id` is a valid client slug. */
export function isValidClientId(id: string): boolean {
  return CLIENT_ID_PATTERN.test(id);
}

/** `nxr_` + base64url(32 random bytes): 256 bits of entropy. */
export function generateToken(): string {
  return TOKEN_PREFIX + randomBytes(32).toString('base64url');
}

/** True if `token` has the exact shape {@link generateToken} produces. */
export function isWellFormedToken(token: string): boolean {
  return TOKEN_PATTERN.test(token);
}

/**
 * SHA-256 hex digest of a token. Tokens are uniformly random 256-bit secrets, so they cannot be
 * guessed or dictionary-attacked; a slow password KDF (bcrypt/scrypt/argon2) would add latency per
 * request without adding security. The hash only ensures a leaked registry file is not a credential.
 */
export function hashToken(token: string): string {
  return createHash('sha256').update(token, 'utf8').digest('hex');
}

/** Last 4 characters of the token. */
export function tokenHint(token: string): string {
  return token.slice(-4);
}
