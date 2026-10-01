import { createModels, createProvider } from '@earendil-works/pi-ai';
import type { Model } from '@earendil-works/pi-ai';
import { openAICompletionsApi } from '@earendil-works/pi-ai/api/openai-completions.lazy';

/**
 * Nexar-local structural view of the few pi-ai `Models` members this package calls.
 * pi-ai types are deliberately not re-exported: this file is the only one that imports
 * the upstream package, and everything else depends on these shapes.
 */
export interface PiModelLike {
  readonly id: string;
  readonly provider: string;
}

/** The request context handed to pi-ai (a single user turn; no tools in v0.1). */
export interface PiContextLike {
  readonly systemPrompt?: string;
  // Mutable array: pi-ai's own `Context.messages` is, and this must stay assignable to it.
  readonly messages: { role: 'user'; content: string; timestamp: number }[];
}

/** Reasoning effort levels accepted by the pi-ai simple options. */
export const PI_REASONING_LEVELS = ['minimal', 'low', 'medium', 'high', 'xhigh', 'max'] as const;

/** One of {@link PI_REASONING_LEVELS}. */
export type PiReasoningLevel = (typeof PI_REASONING_LEVELS)[number];

/** Per-request options passed to pi-ai. */
export interface PiRequestOptionsLike {
  readonly signal?: AbortSignal;
  readonly maxTokens?: number;
  readonly reasoning?: PiReasoningLevel;
  readonly apiKey?: string;
}

/** The subset of a pi-ai assistant message this package reads. */
export interface PiAssistantMessageLike {
  readonly content: readonly { readonly type: string; readonly text?: string }[];
  readonly usage: {
    readonly input: number;
    readonly output: number;
    readonly cacheRead: number;
    readonly cacheWrite: number;
    readonly cost: { readonly total: number };
  };
  readonly stopReason: string;
  readonly errorMessage?: string;
  readonly model: string;
  readonly provider: string;
}

/** The subset of a pi-ai `Models` collection this package calls; also the test injection seam. */
export interface PiModelsLike {
  getModel(provider: string, id: string): PiModelLike | undefined;
  completeSimple(
    model: PiModelLike,
    context: PiContextLike,
    options?: PiRequestOptionsLike,
  ): Promise<PiAssistantMessageLike>;
}

/** The pinned upstream version (kept in step with package.json's exact pin). */
export const PI_AI_VERSION = '0.99.2';

/** Recorded as `resolved.runtimeVersion`. */
export const PI_AI_RUNTIME_VERSION = `@earendil-works/pi-ai@${PI_AI_VERSION}`;

/**
 * pi-ai's OpenAI-completions API refuses to run without a key, even for servers that ignore
 * auth (Ollama, LM Studio). Keyless local endpoints get this inert placeholder per request.
 */
export const KEYLESS_LOCAL_PLACEHOLDER_KEY = 'not-required';

/** Providers reachable by default; anything else is rejected by policy. */
export const DEFAULT_ALLOWED_PROVIDERS: readonly string[] = [
  'anthropic',
  'openai',
  'google',
  'deepseek',
  'openrouter',
  'groq',
  'mistral',
  'xai',
];

type ProviderFactory = () => Promise<Parameters<ReturnType<typeof createModels>['setProvider']>[0]>;

// Per-provider subpaths keep the loaded code (and the SDKs behind it) limited to the allowlist.
const PROVIDER_FACTORIES: Readonly<Record<string, ProviderFactory>> = {
  anthropic: async () =>
    (await import('@earendil-works/pi-ai/providers/anthropic')).anthropicProvider(),
  openai: async () => (await import('@earendil-works/pi-ai/providers/openai')).openaiProvider(),
  google: async () => (await import('@earendil-works/pi-ai/providers/google')).googleProvider(),
  deepseek: async () =>
    (await import('@earendil-works/pi-ai/providers/deepseek')).deepseekProvider(),
  openrouter: async () =>
    (await import('@earendil-works/pi-ai/providers/openrouter')).openrouterProvider(),
  groq: async () => (await import('@earendil-works/pi-ai/providers/groq')).groqProvider(),
  mistral: async () => (await import('@earendil-works/pi-ai/providers/mistral')).mistralProvider(),
  xai: async () => (await import('@earendil-works/pi-ai/providers/xai')).xaiProvider(),
};

/**
 * Builds a `Models` collection holding only the allowlisted providers. Providers without a
 * dedicated subpath factory above fall back to the full built-in set, filtered by id.
 */
export async function createAllowlistedModels(
  allowedProviders: readonly string[],
): Promise<PiModelsLike> {
  const models = createModels();
  const fallback: string[] = [];
  for (const id of allowedProviders) {
    const factory = PROVIDER_FACTORIES[id];
    if (factory === undefined) {
      fallback.push(id);
    } else {
      models.setProvider(await factory());
    }
  }
  if (fallback.length > 0) {
    const { builtinProviders } = await import('@earendil-works/pi-ai/providers/all');
    for (const provider of builtinProviders()) {
      if (fallback.includes(provider.id)) models.setProvider(provider);
    }
  }
  return models;
}

/** Nexar-owned view of one static catalog chat model; rates are USD per 1M tokens. */
export interface CatalogModel {
  readonly id: string;
  readonly contextWindow: number;
  readonly maxTokens: number;
  readonly inputPerMillionTokens: number;
  readonly outputPerMillionTokens: number;
}

/**
 * The static pi-ai catalog's chat models for one provider. Reads no credentials and makes no
 * network call (`getModelsOfType` is the synchronous last-known list).
 */
export async function listCatalogModels(provider: string): Promise<readonly CatalogModel[]> {
  const models = createModels();
  const factory = PROVIDER_FACTORIES[provider];
  if (factory === undefined) {
    const { builtinProviders } = await import('@earendil-works/pi-ai/providers/all');
    for (const p of builtinProviders()) {
      if (p.id === provider) models.setProvider(p);
    }
  } else {
    models.setProvider(await factory());
  }
  return models.getModelsOfType('chat', provider).map((m) => ({
    id: m.id,
    contextWindow: m.contextWindow,
    maxTokens: m.maxTokens,
    inputPerMillionTokens: m.cost.input,
    outputPerMillionTokens: m.cost.output,
  }));
}

/** Describes an OpenAI-compatible endpoint to expose as a one-model collection. */
export interface LocalEndpoint {
  readonly provider: string;
  readonly model: string;
  readonly baseUrl: string;
  readonly contextWindowTokens?: number;
  readonly maxOutputTokens?: number;
}

const DEFAULT_LOCAL_CONTEXT_WINDOW = 128_000;
const DEFAULT_LOCAL_MAX_OUTPUT = 32_000;

/**
 * Builds a collection for one OpenAI-compatible (Ollama, vLLM, LM Studio, ...) endpoint using
 * pi-ai's documented `createProvider` + `openAICompletionsApi` custom-provider facility.
 * Keys are supplied per request, so provider-level auth resolves as configured without one.
 */
export function createLocalEndpointModels(endpoint: LocalEndpoint): PiModelsLike {
  const model: Model<'openai-completions'> = {
    id: endpoint.model,
    name: endpoint.model,
    api: 'openai-completions',
    provider: endpoint.provider,
    baseUrl: endpoint.baseUrl,
    reasoning: false,
    input: ['text'],
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    contextWindow: endpoint.contextWindowTokens ?? DEFAULT_LOCAL_CONTEXT_WINDOW,
    maxTokens: endpoint.maxOutputTokens ?? DEFAULT_LOCAL_MAX_OUTPUT,
  };
  const models = createModels();
  models.setProvider(
    createProvider({
      id: endpoint.provider,
      name: endpoint.provider,
      baseUrl: endpoint.baseUrl,
      auth: { apiKey: { name: endpoint.provider, resolve: () => Promise.resolve({ auth: {} }) } },
      models: [model],
      api: openAICompletionsApi(),
    }),
  );
  return models;
}
