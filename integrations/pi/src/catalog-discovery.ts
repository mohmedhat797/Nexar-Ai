import { NexarError } from '@nexar/contracts';
import type {
  Capability,
  CostProfile,
  DiscoveryContext,
  DiscoverySource,
  ResourceDescriptor,
} from '@nexar/contracts';
import { DEFAULT_ALLOWED_PROVIDERS, listCatalogModels } from './pi-models.js';
import type { CatalogModel } from './pi-models.js';
import { piModelResource } from './resource.js';

export const PI_CATALOG_SOURCE_ID = 'pi-catalog';

const DEFAULT_MAX_MODELS = 50;
const SLUG_LIMIT = 128;
const LONG_CONTEXT_TOKENS = 200_000;
const BASE_CAPABILITIES: readonly Capability[] = ['text-generation', 'reasoning', 'knowledge-work'];

/** Nexar-owned: the env var each allowlisted provider's key is conventionally read from. */
const PROVIDER_API_KEY_ENV: Readonly<Record<string, string>> = {
  anthropic: 'ANTHROPIC_API_KEY',
  openai: 'OPENAI_API_KEY',
  google: 'GEMINI_API_KEY',
  deepseek: 'DEEPSEEK_API_KEY',
  openrouter: 'OPENROUTER_API_KEY',
  groq: 'GROQ_API_KEY',
  mistral: 'MISTRAL_API_KEY',
  xai: 'XAI_API_KEY',
};

/** Lowercases, replaces characters outside the id slug alphabet with `-`, truncates to the limit. */
export function slugifyResourceId(raw: string): string | undefined {
  const slug = raw
    .toLowerCase()
    .replace(/[^a-z0-9._:-]/g, '-')
    .replace(/^[^a-z0-9]+/, '')
    .slice(0, SLUG_LIMIT);
  return slug === '' ? undefined : slug;
}

export interface PiCatalogDiscoveryOptions {
  /** Owner-chosen providers; must be non-empty and within the allowed providers. */
  readonly providers: readonly string[];
  /** Per provider; default 50. */
  readonly maxModels?: number;
  /** Default: the adapter's default allowlist. */
  readonly allowedProviders?: readonly string[];
  /** Test seam; default reads the static pi-ai catalog. */
  readonly listModels?: (provider: string) => Promise<readonly CatalogModel[]>;
}

function toDescriptor(provider: string, model: CatalogModel, id: string): ResourceDescriptor {
  const free = model.inputPerMillionTokens === 0 && model.outputPerMillionTokens === 0;
  // A 0/0 catalog rate means free, plan-billed or unknown, and cannot be told apart.
  const cost: CostProfile = free
    ? { model: 'unknown' }
    : {
        model: 'per-token',
        currency: 'USD',
        inputPerMillionTokens: model.inputPerMillionTokens,
        outputPerMillionTokens: model.outputPerMillionTokens,
      };
  const base = piModelResource({
    id,
    provider,
    model: model.id,
    // A reference to the variable's name only: its value is never read here.
    apiKeyEnv: PROVIDER_API_KEY_ENV[provider] as string,
    capabilities:
      model.contextWindow >= LONG_CONTEXT_TOKENS
        ? [...BASE_CAPABILITIES, 'long-context']
        : BASE_CAPABILITIES,
  });
  return {
    ...base,
    cost,
    limits: { contextWindowTokens: model.contextWindow, maxOutputTokens: model.maxTokens },
    metadata: { rates: 'catalog' },
  };
}

/** Candidates from the static pi-ai catalog for the owner's providers; rates are labelled `catalog`. */
export function piCatalogDiscoverySource(options: PiCatalogDiscoveryOptions): DiscoverySource {
  const allowed = options.allowedProviders ?? DEFAULT_ALLOWED_PROVIDERS;
  const maxModels = options.maxModels ?? DEFAULT_MAX_MODELS;
  const list = options.listModels ?? listCatalogModels;
  return {
    id: PI_CATALOG_SOURCE_ID,
    async discover(ctx: DiscoveryContext): Promise<readonly ResourceDescriptor[]> {
      // Fails closed: without an owner allowlist nothing is enumerated.
      if (options.providers.length === 0) {
        throw new NexarError('CONFIGURATION_ERROR', 'pi catalog discovery needs a provider list');
      }
      for (const provider of options.providers) {
        if (!allowed.includes(provider) || PROVIDER_API_KEY_ENV[provider] === undefined) {
          throw new NexarError('POLICY_REJECTED', 'pi catalog discovery: provider not allowed', {
            details: { source: PI_CATALOG_SOURCE_ID },
          });
        }
      }
      const seen = new Set<string>();
      const out: ResourceDescriptor[] = [];
      for (const provider of [...new Set(options.providers)].sort()) {
        ctx.signal.throwIfAborted();
        const models = [...(await list(provider))].sort((a, b) => (a.id < b.id ? -1 : 1));
        let count = 0;
        for (const model of models) {
          if (count >= maxModels) break;
          const id = slugifyResourceId(`pi.${provider}.${model.id}`);
          if (id === undefined || seen.has(id)) continue;
          seen.add(id);
          out.push(toDescriptor(provider, model, id));
          count += 1;
        }
      }
      // Output is ordered by resource id, whatever the catalog order or casing.
      return out.sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
    },
  };
}
