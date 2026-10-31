import { NexarError } from '@nexar/contracts';
import type {
  Capability,
  CostProfile,
  DiscoveryCredentialSource,
  DiscoveryContext,
  DiscoverySource,
  ConnectionDefinition,
  ResourceConnection,
  ResourceDescriptor,
} from '@nexar/contracts';
import { DEFAULT_ALLOWED_PROVIDERS, listCatalogModels } from './pi-models.js';
import type { CatalogModel } from './pi-models.js';
import { piModelResource } from './resource.js';

export const PI_CATALOG_SOURCE_ID = 'pi-catalog';

const DEFAULT_MAX_MODELS = 50;
const SLUG_LIMIT = 128;
const LONG_CONTEXT_TOKENS = 200_000;
// pi-ai carries tool schemas for its catalog providers; the execution port comes with NXR-062.
const BASE_CAPABILITIES: readonly Capability[] = [
  'text-generation',
  'reasoning',
  'knowledge-work',
  'model-turn',
];

/** Nexar-owned: the env var each allowlisted provider's key is conventionally read from. */
export const PI_PROVIDER_CREDENTIAL_NAMES: Readonly<Record<string, string>> = Object.freeze({
  anthropic: 'ANTHROPIC_API_KEY',
  openai: 'OPENAI_API_KEY',
  google: 'GEMINI_API_KEY',
  deepseek: 'DEEPSEEK_API_KEY',
  openrouter: 'OPENROUTER_API_KEY',
  groq: 'GROQ_API_KEY',
  mistral: 'MISTRAL_API_KEY',
  xai: 'XAI_API_KEY',
});

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
  /** Credential reference source only; default `env`. Discovery never reads either source. */
  readonly credentialSource?: DiscoveryCredentialSource;
  /** Per provider; default 50. */
  readonly maxModels?: number;
  /** Default: the adapter's default allowlist. */
  readonly allowedProviders?: readonly string[];
  /** Test seam; default reads the static pi-ai catalog. */
  readonly listModels?: (provider: string) => Promise<readonly CatalogModel[]>;
  /** Optional connection definition or identity reference (ADR-029). */
  readonly connection?: ConnectionDefinition;
  /** Optional credential name reference (e.g. owner key name in key store). */
  readonly credentialName?: string;
  /** Host injects the accepted registry materializer for connection-qualified owner resources. */
  readonly catalogResourceId?: (
    connection: ConnectionDefinition,
    provider: string,
    model: string,
  ) => string;
}

function toDescriptor(
  provider: string,
  model: CatalogModel,
  id: string,
  credentialSource: DiscoveryCredentialSource,
  credentialName?: string,
  connection?: ResourceConnection,
): ResourceDescriptor {
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
  const keyEnv = credentialName ?? PI_PROVIDER_CREDENTIAL_NAMES[provider] ?? '';
  const base = piModelResource({
    id,
    provider,
    model: model.id,
    // A reference to the variable's name only: its value is never read here.
    apiKeyEnv: keyEnv,
    capabilities:
      model.contextWindow >= LONG_CONTEXT_TOKENS
        ? [...BASE_CAPABILITIES, 'long-context']
        : BASE_CAPABILITIES,
  });
  return {
    ...base,
    auth: {
      mode: 'api-key',
      credential: {
        source: credentialSource,
        name: keyEnv,
      },
    },
    cost,
    limits: { contextWindowTokens: model.contextWindow, maxOutputTokens: model.maxTokens },
    metadata: {
      ...base.metadata,
      rates: 'catalog',
      connection: connection ?? {
        id: `${provider}.api`,
        provider,
        method: 'api',
        authClass: 'official-api',
        support: 'official',
      },
    },
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
        if (!allowed.includes(provider) || PI_PROVIDER_CREDENTIAL_NAMES[provider] === undefined) {
          throw new NexarError('POLICY_REJECTED', 'pi catalog discovery: provider not allowed', {
            details: { source: PI_CATALOG_SOURCE_ID },
          });
        }
        const c = options.connection;
        if (c !== undefined) {
          const suffix = new RegExp(`^${provider}\\.api\\.c([a-z2-7]{10})$`).exec(c.id)?.[1];
          const expected = c.builtIn
            ? PI_PROVIDER_CREDENTIAL_NAMES[provider]
            : suffix === undefined
              ? undefined
              : `${PI_PROVIDER_CREDENTIAL_NAMES[provider]}__C${suffix.toUpperCase()}`;
          if (
            c.provider !== provider ||
            c.method !== 'api' ||
            c.authClass !== 'official-api' ||
            c.credentialScope.kind !== 'keystore' ||
            c.credentialScope.name !== expected ||
            options.credentialName !== expected ||
            options.credentialSource !== 'keystore' ||
            (!c.builtIn && options.catalogResourceId === undefined)
          ) {
            throw new NexarError(
              'CONFIGURATION_ERROR',
              'Catalog connection credential scope is invalid',
            );
          }
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
          const id =
            options.connection !== undefined && !options.connection.builtIn
              ? options.catalogResourceId!(options.connection, provider, model.id)
              : slugifyResourceId(`pi.${provider}.${model.id}`);
          if (id === undefined || seen.has(id)) continue;
          seen.add(id);
          out.push(
            toDescriptor(
              provider,
              model,
              id,
              options.credentialSource ?? 'env',
              options.credentialName,
              options.connection === undefined
                ? undefined
                : {
                    id: options.connection.id,
                    provider: options.connection.provider,
                    method: options.connection.method,
                    authClass: options.connection.authClass,
                    support: options.connection.support,
                  },
            ),
          );
          count += 1;
        }
      }
      // Output is ordered by resource id, whatever the catalog order or casing.
      return out.sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
    },
  };
}
