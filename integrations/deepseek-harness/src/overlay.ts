import { NexarError } from '@nexar/contracts';

const PROVIDER_NAME_PATTERN = /^[a-z0-9][a-z0-9._-]*$/;
const ENV_NAME_PATTERN = /^[A-Z][A-Z0-9_]*$/;

/** Extra LLM providers DSH's `llm-pi-ai` adapter may use, each naming the env var holding its key. */
export type PiAiProviders = Readonly<Record<string, { readonly apiKeyEnv: string }>>;

export interface PatchOverlayOptions {
  readonly piAiProviders?: PiAiProviders | undefined;
}

/** Throws `CONFIGURATION_ERROR` unless every provider and env var name is safe to render. */
export function validatePiAiProviders(providers: PiAiProviders): void {
  for (const [name, entry] of Object.entries(providers)) {
    if (!PROVIDER_NAME_PATTERN.test(name)) {
      throw new NexarError(
        'CONFIGURATION_ERROR',
        `piAiProviders: invalid provider name ${JSON.stringify(name)} (must match ${String(PROVIDER_NAME_PATTERN)})`,
      );
    }
    const env: unknown = entry.apiKeyEnv;
    if (typeof env !== 'string' || !ENV_NAME_PATTERN.test(env)) {
      throw new NexarError(
        'CONFIGURATION_ERROR',
        `piAiProviders.${name}.apiKeyEnv must be an environment variable name matching ${String(ENV_NAME_PATTERN)}`,
      );
    }
  }
}

/**
 * Renders the Nexar-owned DSH patch overlay (YAML). Hand-rendered; all interpolated
 * values are validated first and double-quoted so they can never change YAML structure.
 */
export function renderPatchOverlay(options: PatchOverlayOptions = {}): string {
  const lines = ['- id: session-log-deepseek', '  disabled: true'];
  const providers = options.piAiProviders;
  if (providers !== undefined && Object.keys(providers).length > 0) {
    validatePiAiProviders(providers);
    lines.push('- id: llm-pi-ai', '  config:', '    providers:');
    for (const [name, entry] of Object.entries(providers)) {
      lines.push(`      "${name}":`, `        apiKeyEnv: "${entry.apiKeyEnv}"`);
    }
  }
  return `${lines.join('\n')}\n`;
}
