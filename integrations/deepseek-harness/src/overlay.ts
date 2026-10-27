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

/** The route name, model id and credential variable of Nexar's control route (ADR-027 section 9b). */
export const NEXAR_ROUTE = 'nexar';
export const NEXAR_CONTROL_MODEL = 'nexar-control';
export const NEXAR_CONTROL_TOKEN_ENV = 'NEXAR_CONTROL_TOKEN';
const NEXAR_ROUTE_BASE_URL = /^http:\/\/127\.0\.0\.1:\d{1,5}\/v1$/;

export interface PatchOverlayOptions {
  readonly piAiProviders?: PiAiProviders | undefined;
  /** The in-sandbox Control Model Gateway; renders the pi-ai route `nexar`. */
  readonly nexarRoute?: { readonly baseURL: string } | undefined;
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
  const lines = [
    '- id: session-log-deepseek',
    '  disabled: true',
    // SDK execution also inherits dsh-base; new capabilities require Nexar authorization.
    '- id: tool-working-directory',
    '  disabled: true',
    '- id: web-deepseek-api',
    '  disabled: true',
  ];
  const providers = options.piAiProviders;
  const route = options.nexarRoute;
  const hasProviders = providers !== undefined && Object.keys(providers).length > 0;
  if (hasProviders) validatePiAiProviders(providers);
  if (route !== undefined && !NEXAR_ROUTE_BASE_URL.test(route.baseURL)) {
    throw new NexarError(
      'CONFIGURATION_ERROR',
      `nexarRoute.baseURL must match ${String(NEXAR_ROUTE_BASE_URL)}`,
    );
  }
  if (route !== undefined && providers !== undefined && NEXAR_ROUTE in providers) {
    throw new NexarError(
      'CONFIGURATION_ERROR',
      `piAiProviders must not declare the reserved route ${NEXAR_ROUTE}`,
    );
  }
  if (hasProviders || route !== undefined) {
    lines.push('- id: llm-pi-ai', '  config:', '    providers:');
    for (const [name, entry] of Object.entries(providers ?? {})) {
      lines.push(`      "${name}":`, `        apiKeyEnv: "${piAiProviderVariable(entry).name}"`);
    }
    if (route !== undefined) {
      lines.push(
        `      "${NEXAR_ROUTE}":`,
        '        api: "openai-completions"',
        `        baseURL: "${route.baseURL}"`,
        `        apiKeyEnv: "${NEXAR_CONTROL_TOKEN_ENV}"`,
        '        models:',
        `          - id: "${NEXAR_CONTROL_MODEL}"`,
      );
    }
  }
  return `${lines.join('\n')}\n`;
}
