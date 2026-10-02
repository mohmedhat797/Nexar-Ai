import type { ProviderKeyCheck, SecretResolver } from '@nexar/contracts';
import { checkProviderApiKey, PI_PROVIDER_CREDENTIAL_NAMES } from '@nexar/integration-pi';

/** Resolve just the chosen Desktop credential at call time, without an environment fallback. */
export async function checkProviderCredential(
  provider: string,
  options: { readonly resolveSecret?: SecretResolver; readonly signal?: AbortSignal } = {},
): Promise<ProviderKeyCheck> {
  if (!Object.hasOwn(PI_PROVIDER_CREDENTIAL_NAMES, provider) || options.resolveSecret === undefined)
    return { status: 'unchecked' };
  try {
    const name = PI_PROVIDER_CREDENTIAL_NAMES[provider];
    if (name === undefined) return { status: 'unchecked' };
    return await checkProviderApiKey(provider, options.resolveSecret(name), {
      ...(options.signal === undefined ? {} : { signal: options.signal }),
    });
  } catch {
    return { status: 'unavailable' };
  }
}
