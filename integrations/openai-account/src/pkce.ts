import { createHash, randomBytes } from 'node:crypto';

export interface Pkce {
  readonly verifier: string;
  readonly challenge: string;
}

/** An unguessable URL-safe value for `state`, `nonce` and the PKCE verifier. */
export function randomToken(bytes = 32): string {
  return randomBytes(bytes).toString('base64url');
}

export function challengeFor(verifier: string): string {
  return createHash('sha256').update(verifier).digest('base64url');
}

/** PKCE (RFC 7636), method `S256`; the verifier is 43 URL-safe characters. */
export function createPkce(): Pkce {
  const verifier = randomToken(32);
  return { verifier, challenge: challengeFor(verifier) };
}
