import { NexarError, isChatGptPlanCredential, isNexarError } from '@nexar/contracts';
import type { ConnectionCredentialResolver, ResourceDescriptor } from '@nexar/contracts';

/** True when the resource authenticates through the ChatGPT plan connection. */
export function usesChatGptPlan(descriptor: ResourceDescriptor): boolean {
  const { auth } = descriptor;
  return (
    (auth.mode === 'subscription' || auth.mode === 'oauth') &&
    isChatGptPlanCredential(auth.credential)
  );
}

const notConnected = (): NexarError =>
  new NexarError('AUTH_REQUIRED', 'ChatGPT is not connected', {
    details: { reason: 'not-connected' },
  });

async function resolve(
  resolver: ConnectionCredentialResolver,
  descriptor: ResourceDescriptor,
  signal: AbortSignal,
  refresh: boolean,
): Promise<string> {
  let token: string | undefined;
  try {
    token = await resolver(descriptor, signal, refresh ? { refresh: true } : undefined);
  } catch (e) {
    // The host's own errors carry fixed text; anything else is reduced to "not connected".
    throw isNexarError(e) ? e : notConnected();
  }
  if (token === undefined || token === '') throw notConnected();
  return token;
}

/** A provider-side 401 (or equivalent): worth one forced refresh, unlike a plan-eligibility refusal. */
function isRefreshable(e: unknown): boolean {
  return (
    isNexarError(e) && e.code === 'AUTH_REQUIRED' && e.details?.['reason'] !== 'plan-not-eligible'
  );
}

/**
 * Runs `run` with the connection's short-lived access token. A rejected token is refreshed once and
 * the call retried; a second rejection is `AUTH_REQUIRED`. `run` owns redaction of the token in its
 * errors; the token is never stored or logged here.
 */
export async function withChatGptPlanToken<T>(
  resolver: ConnectionCredentialResolver,
  descriptor: ResourceDescriptor,
  signal: AbortSignal,
  run: (token: string) => Promise<T>,
): Promise<T> {
  const first = await resolve(resolver, descriptor, signal, false);
  try {
    return await run(first);
  } catch (e) {
    if (!isRefreshable(e) || signal.aborted) throw e;
  }
  const second = await resolve(resolver, descriptor, signal, true);
  try {
    return await run(second);
  } catch (e) {
    if (!isRefreshable(e)) throw e;
    throw new NexarError('AUTH_REQUIRED', 'The ChatGPT sign-in was rejected', {
      details: { reason: 'invalid-user' },
    });
  }
}
