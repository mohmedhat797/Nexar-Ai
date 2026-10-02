import { NexarError } from '@nexar/contracts';
import type { ResourceDescriptor } from '@nexar/contracts';
import { parseAcpOptions } from './acp/options.js';
import type { AcpOptions } from './acp/options.js';
import { validatePiAiProviders } from './overlay.js';
import type { PiAiProviderEntry, PiAiProviders } from './overlay.js';

export const DEFAULT_PROVIDER = 'deepseek-official';

/** Validated per-resource `runtime.options` for the DSH adapter. */
export interface DshRuntimeOptions {
  readonly provider: string;
  readonly model: string;
  readonly reasoningEffort?: string;
  readonly maxTokens?: number;
  readonly patches: readonly string[];
  readonly piAiProviders?: PiAiProviders;
  readonly timeoutMs?: number;
  /** Engineering-lane (ACP) settings; validated strictly, defaults applied by the ACP path. */
  readonly acp?: AcpOptions;
}

function bad(message: string): NexarError {
  return new NexarError('CONFIGURATION_ERROR', `deepseek-harness runtime.options: ${message}`);
}

function optionalString(raw: Record<string, unknown>, key: string): string | undefined {
  const value = raw[key];
  if (value === undefined) return undefined;
  if (typeof value !== 'string' || value.length === 0)
    throw bad(`'${key}' must be a non-empty string`);
  return value;
}

function optionalPositive(raw: Record<string, unknown>, key: string): number | undefined {
  const value = raw[key];
  if (value === undefined) return undefined;
  if (typeof value !== 'number' || !Number.isFinite(value) || value <= 0) {
    throw bad(`'${key}' must be a positive number`);
  }
  return value;
}

function parsePiAiProviders(value: unknown): PiAiProviders {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw bad(
      `'piAiProviders' must be an object mapping provider name to { apiKeyEnv } or { keystore }`,
    );
  }
  const out: Record<string, PiAiProviderEntry> = {};
  for (const [name, entry] of Object.entries(value)) {
    const { apiKeyEnv, keystore } = (entry ?? {}) as { apiKeyEnv?: unknown; keystore?: unknown };
    if ((apiKeyEnv === undefined) === (keystore === undefined)) {
      throw bad(`'piAiProviders.${name}' must set exactly one of 'apiKeyEnv' or 'keystore'`);
    }
    if (apiKeyEnv !== undefined) {
      if (typeof apiKeyEnv !== 'string')
        throw bad(`'piAiProviders.${name}.apiKeyEnv' must be a string`);
      out[name] = { apiKeyEnv };
    } else {
      if (typeof keystore !== 'string')
        throw bad(`'piAiProviders.${name}.keystore' must be a string`);
      out[name] = { keystore };
    }
  }
  validatePiAiProviders(out);
  return out;
}

/** Validates `resource.runtime.options`, applying defaults. Wrong types are `CONFIGURATION_ERROR`. */
export function parseRuntimeOptions(resource: ResourceDescriptor): DshRuntimeOptions {
  const raw: Record<string, unknown> = { ...resource.runtime.options };

  const provider = optionalString(raw, 'provider') ?? DEFAULT_PROVIDER;
  const fallbackModel =
    resource.kind.type === 'agent' ? resource.kind.underlying?.model : undefined;
  const model = optionalString(raw, 'model') ?? fallbackModel;
  if (model === undefined) {
    throw bad(`'model' is required (set it, or set kind.underlying.model)`);
  }

  const patchesRaw = raw.patches;
  let patches: string[] = [];
  if (patchesRaw !== undefined) {
    if (
      !Array.isArray(patchesRaw) ||
      !patchesRaw.every((p): p is string => typeof p === 'string' && p.length > 0)
    ) {
      throw bad(`'patches' must be an array of non-empty strings`);
    }
    patches = [...patchesRaw];
  }

  const reasoningEffort = optionalString(raw, 'reasoningEffort');
  const maxTokens = optionalPositive(raw, 'maxTokens');
  const timeoutMs = optionalPositive(raw, 'timeoutMs');
  if (maxTokens !== undefined && !Number.isInteger(maxTokens)) {
    throw bad(`'maxTokens' must be a positive integer`);
  }

  return {
    provider,
    model,
    patches,
    ...(reasoningEffort === undefined ? {} : { reasoningEffort }),
    ...(maxTokens === undefined ? {} : { maxTokens }),
    ...(timeoutMs === undefined ? {} : { timeoutMs }),
    ...(raw.acp === undefined ? {} : { acp: parseAcpOptions(raw.acp) }),
    ...(raw.piAiProviders === undefined
      ? {}
      : { piAiProviders: parsePiAiProviders(raw.piAiProviders) }),
  };
}
