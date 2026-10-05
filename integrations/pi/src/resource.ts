import { adapterId, resourceId } from '@nexar/contracts';
import type { Capability, ResourceDescriptor } from '@nexar/contracts';

/** Identifies this adapter in `RuntimeBinding.adapter`. */
export const PI_ADAPTER_ID = adapterId('pi');

const DEFAULT_CAPABILITIES: readonly Capability[] = [
  'text-generation',
  'reasoning',
  'knowledge-work',
];
const LOOPBACK_HOSTS: ReadonlySet<string> = new Set(['localhost', '127.0.0.1', '[::1]']);

/** True when the URL's host is a loopback name or address. */
export function isLoopbackUrl(url: string): boolean {
  return LOOPBACK_HOSTS.has(new URL(url).hostname);
}

/** Input for {@link piModelResource}. */
export interface PiModelResourceInput {
  readonly id: string;
  readonly provider: string;
  readonly model: string;
  readonly apiKeyEnv?: string;
  readonly capabilities?: readonly Capability[];
  readonly contextWindowTokens?: number;
  /** An OpenAI-compatible endpoint (Ollama, vLLM, LM Studio, ...); marks the resource local-access. */
  readonly baseUrl?: string;
}

/** Builds a valid descriptor for a model executed directly through this adapter. */
export function piModelResource(input: PiModelResourceInput): ResourceDescriptor {
  const isLoopback =
    input.baseUrl !== undefined && LOOPBACK_HOSTS.has(new URL(input.baseUrl).hostname);
  return {
    id: resourceId(input.id),
    displayName: `${input.provider}/${input.model}`,
    kind: {
      type: 'model',
      provider: input.provider,
      model: input.model,
      access: input.baseUrl === undefined ? 'api' : 'local',
    },
    capabilities: input.capabilities ?? DEFAULT_CAPABILITIES,
    runtime: {
      adapter: PI_ADAPTER_ID,
      locality: input.baseUrl === undefined ? 'remote' : 'local',
      ...(input.baseUrl === undefined ? {} : { options: { baseUrl: input.baseUrl } }),
    },
    auth:
      input.apiKeyEnv === undefined
        ? { mode: 'none' }
        : { mode: 'api-key', credential: { source: 'env', name: input.apiKeyEnv } },
    cost: { model: 'unknown' },
    ...(input.contextWindowTokens === undefined
      ? {}
      : { limits: { contextWindowTokens: input.contextWindowTokens } }),
    dataLocality: isLoopback ? 'local' : 'third-party',
  };
}

/** The pi-ai model a connected ChatGPT plan serves when the owner lists none (in pi-ai's catalog). */
export const DEFAULT_CHATGPT_PLAN_MODEL = 'gpt-5.2';

/**
 * A model the owner's connected ChatGPT plan can run (ADR-022 amendment 2026-10-05): `model-turn`
 * (the route is the standard Responses API), plan-billed, no cash cost reported. The credential is a
 * reference to the Desktop connection; the token is resolved per call by the host's seam.
 */
export function chatGptPlanModelResource(model: string): ResourceDescriptor {
  return {
    id: resourceId(`chatgpt-plan:${model}`),
    displayName: `ChatGPT plan / ${model}`,
    kind: { type: 'model', provider: 'openai', model, access: 'subscription' },
    capabilities: ['text-generation', 'reasoning', 'knowledge-work', 'model-turn'],
    runtime: { adapter: PI_ADAPTER_ID, locality: 'remote' },
    auth: {
      mode: 'subscription',
      credential: { source: 'connection', name: 'chatgpt-plan' },
    },
    cost: { model: 'subscription', plan: 'chatgpt' },
    dataLocality: 'third-party',
    metadata: {
      connection: {
        id: 'openai.chatgpt-plan',
        provider: 'openai',
        method: 'subscription',
        authClass: 'official-account',
        support: 'official',
      },
    },
  };
}
