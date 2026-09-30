import { NexarError } from '@nexar/contracts';
import type {
  ExecutionAdapter,
  ExecutionContext,
  ExecutionRequest,
  ExecutionResult,
  ResourceDescriptor,
  ResourceState,
} from '@nexar/contracts';
import {
  DEFAULT_ALLOWED_PROVIDERS,
  KEYLESS_LOCAL_PLACEHOLDER_KEY,
  PI_REASONING_LEVELS,
  createAllowlistedModels,
  createLocalEndpointModels,
} from './pi-models.js';
import type { PiModelLike, PiModelsLike, PiReasoningLevel } from './pi-models.js';
import { PI_ADAPTER_ID } from './resource.js';
import { toExecutionResult, toThrownNexarError } from './result.js';

/** Options for {@link PiExecutionAdapter}. */
export interface PiExecutionAdapterOptions {
  /** Injection seam for tests; defaults to a collection built lazily from the allowlist. */
  readonly models?: PiModelsLike;
  /** Environment used to resolve credential references. Defaults to `process.env`. */
  readonly env?: NodeJS.ProcessEnv;
  /** Providers this adapter may call. Defaults to {@link DEFAULT_ALLOWED_PROVIDERS}. */
  readonly allowedProviders?: readonly string[];
  /** Clock (epoch ms) for message and probe timestamps. Defaults to `Date.now`. */
  readonly now?: () => number;
}

interface PiRuntimeOptions {
  readonly baseUrl?: string;
  readonly maxTokens?: number;
  readonly reasoning?: PiReasoningLevel;
}

type ModelKind = Extract<ResourceDescriptor['kind'], { type: 'model' }>;
type ModelResource = ResourceDescriptor & { readonly kind: ModelKind };

function configError(message: string, details?: Record<string, unknown>): NexarError {
  return new NexarError('CONFIGURATION_ERROR', message, details ? { details } : {});
}

function parseRuntimeOptions(resource: ResourceDescriptor): PiRuntimeOptions {
  const raw = resource.runtime.options ?? {};
  const { baseUrl, maxTokens, reasoning } = raw;
  const out: { baseUrl?: string; maxTokens?: number; reasoning?: PiReasoningLevel } = {};
  if (baseUrl !== undefined) {
    let protocol: string | undefined;
    try {
      protocol = typeof baseUrl === 'string' ? new URL(baseUrl).protocol : undefined;
    } catch {
      protocol = undefined;
    }
    if (protocol !== 'http:' && protocol !== 'https:') {
      throw configError('runtime.options.baseUrl must be an http(s) URL', {
        resource: resource.id,
      });
    }
    out.baseUrl = baseUrl as string;
  }
  if (maxTokens !== undefined) {
    if (typeof maxTokens !== 'number' || !Number.isInteger(maxTokens) || maxTokens <= 0) {
      throw configError('runtime.options.maxTokens must be a positive integer', {
        resource: resource.id,
      });
    }
    out.maxTokens = maxTokens;
  }
  if (reasoning !== undefined) {
    if (!(PI_REASONING_LEVELS as readonly unknown[]).includes(reasoning)) {
      throw configError(
        `runtime.options.reasoning must be one of: ${PI_REASONING_LEVELS.join(', ')}`,
        { resource: resource.id },
      );
    }
    out.reasoning = reasoning as PiReasoningLevel;
  }
  return out;
}

/**
 * Executes `model` resources directly through pi-ai (API keys, gateways, local
 * OpenAI-compatible servers). Subscription/OAuth access is intentionally not offered here.
 */
export class PiExecutionAdapter implements ExecutionAdapter {
  readonly id = PI_ADAPTER_ID;
  readonly displayName = 'pi-ai direct model adapter';

  private readonly env: NodeJS.ProcessEnv;
  private readonly allowedProviders: readonly string[];
  private readonly now: () => number;
  private readonly injected: PiModelsLike | undefined;
  private defaultModels: Promise<PiModelsLike> | undefined;
  private readonly localModels = new Map<string, PiModelsLike>();

  constructor(options: PiExecutionAdapterOptions = {}) {
    this.injected = options.models;
    this.env = options.env ?? process.env;
    this.allowedProviders = options.allowedProviders ?? DEFAULT_ALLOWED_PROVIDERS;
    this.now = options.now ?? Date.now;
  }

  supports(resource: ResourceDescriptor): boolean {
    return resource.runtime.adapter === PI_ADAPTER_ID && resource.kind.type === 'model';
  }

  async probe(resource: ResourceDescriptor, signal: AbortSignal): Promise<ResourceState> {
    void signal; // Probing is local-only (catalog + env lookups); nothing to cancel.
    const observedAt = new Date(this.now()).toISOString();
    try {
      const target = this.requireModelResource(resource);
      const options = parseRuntimeOptions(resource);
      this.assertAuthModeAllowed(target);
      const { kind } = target;
      if (options.baseUrl === undefined) {
        this.assertProviderAllowed(kind.provider, resource);
        const models = await this.getDefaultModels();
        if (models.getModel(kind.provider, kind.model) === undefined) {
          return {
            availability: 'unavailable',
            auth: 'unknown',
            detail: `Model ${kind.provider}/${kind.model} is not in the pi-ai catalog`,
            observedAt,
          };
        }
      }
      const auth = target.auth;
      const authState =
        auth.mode === 'none'
          ? 'not-required'
          : this.readCredential(auth.credential) === undefined
            ? 'unauthenticated'
            : 'authenticated';
      return { availability: 'available', auth: authState, observedAt };
    } catch (e) {
      const message = e instanceof Error ? e.message : 'probe failed';
      return { availability: 'unavailable', auth: 'unknown', detail: message, observedAt };
    }
  }

  async execute(request: ExecutionRequest, context: ExecutionContext): Promise<ExecutionResult> {
    const { resource } = request;
    const target = this.requireModelResource(resource);
    const options = parseRuntimeOptions(resource);
    this.assertAuthModeAllowed(target);
    const { kind } = target;
    if (options.baseUrl === undefined) this.assertProviderAllowed(kind.provider, resource);
    if (context.signal.aborted) {
      throw new NexarError('EXECUTION_CANCELLED', 'Execution was cancelled');
    }

    let apiKey: string | undefined;
    if (target.auth.mode === 'api-key') {
      apiKey = this.readCredential(target.auth.credential);
      if (apiKey === undefined) {
        const name = target.auth.credential.source === 'env' ? target.auth.credential.name : '';
        throw new NexarError(
          'AUTH_REQUIRED',
          `Credential environment variable ${name} is not set`,
          {
            details: { env: name },
          },
        );
      }
    }
    const secrets = apiKey === undefined ? [] : [apiKey];

    try {
      const models = await this.modelsFor(target, options);
      const model = models.getModel(kind.provider, kind.model);
      if (model === undefined) {
        throw configError(`Unknown model ${kind.provider}/${kind.model}`, {
          provider: kind.provider,
          model: kind.model,
        });
      }
      const message = await this.complete(models, model, request, context, options, apiKey);
      return toExecutionResult(message, {
        secrets,
        ...(context.onEvent === undefined ? {} : { onEvent: context.onEvent }),
      });
    } catch (e) {
      throw toThrownNexarError(e, context.signal, secrets);
    }
  }

  // TODO(v0.2): expose a streaming path (models.streamSimple) to emit `text-delta` events.
  private complete(
    models: PiModelsLike,
    model: PiModelLike,
    request: ExecutionRequest,
    context: ExecutionContext,
    options: PiRuntimeOptions,
    apiKey: string | undefined,
  ): ReturnType<PiModelsLike['completeSimple']> {
    const { input } = request.task;
    return models.completeSimple(
      model,
      {
        ...(input.systemPrompt === undefined ? {} : { systemPrompt: input.systemPrompt }),
        messages: [{ role: 'user', content: input.prompt, timestamp: this.now() }],
      },
      {
        signal: context.signal,
        ...(options.maxTokens === undefined ? {} : { maxTokens: options.maxTokens }),
        ...(options.reasoning === undefined ? {} : { reasoning: options.reasoning }),
        ...(apiKey !== undefined
          ? { apiKey }
          : options.baseUrl !== undefined
            ? { apiKey: KEYLESS_LOCAL_PLACEHOLDER_KEY }
            : {}),
      },
    );
  }

  private requireModelResource(resource: ResourceDescriptor): ModelResource {
    if (!this.supports(resource) || resource.kind.type !== 'model') {
      throw configError(`Resource ${resource.id} is not a pi model resource`, {
        resource: resource.id,
      });
    }
    return resource as ModelResource;
  }

  private assertAuthModeAllowed(resource: ResourceDescriptor): void {
    if (resource.auth.mode === 'oauth' || resource.auth.mode === 'subscription') {
      throw new NexarError(
        'POLICY_REJECTED',
        'subscription auth via pi-ai is disabled in v0.1; use a native agent resource',
        { details: { resource: resource.id, mode: resource.auth.mode } },
      );
    }
  }

  private assertProviderAllowed(provider: string, resource: ResourceDescriptor): void {
    if (!this.allowedProviders.includes(provider)) {
      throw new NexarError('POLICY_REJECTED', `Provider ${provider} is not allowed for pi-ai`, {
        details: { provider, resource: resource.id, allowed: this.allowedProviders },
      });
    }
  }

  /** Reads the referenced env var; empty or absent means "no credential". Never logs the value. */
  private readCredential(
    credential: Extract<ResourceDescriptor['auth'], { mode: 'api-key' }>['credential'],
  ): string | undefined {
    if (credential.source !== 'env') {
      throw configError('pi-ai resources need an env credential reference', {
        source: credential.source,
      });
    }
    const value = this.env[credential.name];
    return value === undefined || value === '' ? undefined : value;
  }

  private getDefaultModels(): Promise<PiModelsLike> {
    if (this.injected !== undefined) return Promise.resolve(this.injected);
    this.defaultModels ??= createAllowlistedModels(this.allowedProviders).catch((e: unknown) => {
      this.defaultModels = undefined;
      throw new NexarError('INTEGRATION_UNAVAILABLE', 'Failed to load pi-ai providers', {
        cause: e,
      });
    });
    return this.defaultModels;
  }

  private modelsFor(resource: ModelResource, options: PiRuntimeOptions): Promise<PiModelsLike> {
    if (options.baseUrl === undefined) return this.getDefaultModels();
    const { provider, model } = resource.kind;
    const key = `${provider}\u0000${model}\u0000${options.baseUrl}`;
    let models = this.localModels.get(key);
    if (models === undefined) {
      models = createLocalEndpointModels({
        provider,
        model,
        baseUrl: options.baseUrl,
        ...(resource.limits?.contextWindowTokens === undefined
          ? {}
          : { contextWindowTokens: resource.limits.contextWindowTokens }),
        ...(resource.limits?.maxOutputTokens === undefined
          ? {}
          : { maxOutputTokens: resource.limits.maxOutputTokens }),
      });
      this.localModels.set(key, models);
    }
    return Promise.resolve(models);
  }
}
