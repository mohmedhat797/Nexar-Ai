import { CREDENTIAL_NAME_MAX_LENGTH, CREDENTIAL_NAME_PATTERN, NexarError } from '@nexar/contracts';

const PROVIDER_NAME_PATTERN = /^[a-z0-9][a-z0-9._-]*$/;

/**
 * Extra LLM providers DSH's `llm-pi-ai` adapter may use. Each entry names the variable holding its
 * key and where that value comes from: the adapter environment (`apiKeyEnv`) or the Nexar key store
 * (`keystore`). Exactly one of the two; there is no fallback between them.
 */
export type PiAiProviderEntry =
  | { readonly apiKeyEnv: string; readonly keystore?: undefined }
  | { readonly keystore: string; readonly apiKeyEnv?: undefined };
export type PiAiProviders = Readonly<Record<string, PiAiProviderEntry>>;

export interface PatchOverlayOptions {
  readonly piAiProviders?: PiAiProviders | undefined;
}

/** Where a credential variable's value comes from. */
export interface CredentialVariable {
  readonly source: 'env' | 'keystore';
  readonly name: string;
}

/** The variable (and its source) a `piAiProviders` entry reads its key from. */
export function piAiProviderVariable(entry: PiAiProviderEntry): CredentialVariable {
  return entry.keystore === undefined
    ? { source: 'env', name: entry.apiKeyEnv }
    : { source: 'keystore', name: entry.keystore };
}

/** Throws `CONFIGURATION_ERROR` unless every provider and variable name is safe to render. */
export function validatePiAiProviders(providers: PiAiProviders): void {
  for (const [name, entry] of Object.entries(providers)) {
    if (!PROVIDER_NAME_PATTERN.test(name)) {
      throw new NexarError(
        'CONFIGURATION_ERROR',
        `piAiProviders: invalid provider name ${JSON.stringify(name)} (must match ${String(PROVIDER_NAME_PATTERN)})`,
      );
    }
    const env: unknown = entry.apiKeyEnv;
    const keystore: unknown = entry.keystore;
    if ((env === undefined) === (keystore === undefined)) {
      throw new NexarError(
        'CONFIGURATION_ERROR',
        `piAiProviders.${name} must set exactly one of apiKeyEnv or keystore`,
      );
    }
    if (env !== undefined && (typeof env !== 'string' || !CREDENTIAL_NAME_PATTERN.test(env))) {
      throw new NexarError(
        'CONFIGURATION_ERROR',
        `piAiProviders.${name}.apiKeyEnv must be an environment variable name matching ${String(CREDENTIAL_NAME_PATTERN)}`,
      );
    }
    if (
      keystore !== undefined &&
      (typeof keystore !== 'string' ||
        keystore.length > CREDENTIAL_NAME_MAX_LENGTH ||
        !CREDENTIAL_NAME_PATTERN.test(keystore))
    ) {
      throw new NexarError(
        'CONFIGURATION_ERROR',
        `piAiProviders.${name}.keystore must be a key store name matching ${String(CREDENTIAL_NAME_PATTERN)} (at most ${CREDENTIAL_NAME_MAX_LENGTH} characters)`,
      );
    }
  }
}

/**
 * Renders the Nexar-owned DSH patch overlay (YAML). Hand-rendered; all interpolated
 * values are validated first and double-quoted so they can never change YAML structure.
 * DSH is always told the variable NAME to read (never a value); for a keystore entry that
 * name is the keystore name, which the adapter places in the child environment.
 */
export function renderPatchOverlay(options: PatchOverlayOptions = {}): string {
  const lines = ['- id: session-log-deepseek', '  disabled: true'];
  const providers = options.piAiProviders;
  if (providers !== undefined && Object.keys(providers).length > 0) {
    validatePiAiProviders(providers);
    lines.push('- id: llm-pi-ai', '  config:', '    providers:');
    for (const [name, entry] of Object.entries(providers)) {
      lines.push(`      "${name}":`, `        apiKeyEnv: "${piAiProviderVariable(entry).name}"`);
    }
  }
  return `${lines.join('\n')}\n`;
}
