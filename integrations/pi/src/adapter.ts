import { NexarError, isNexarError } from '@nexar/contracts';
import type {
  ExecutionAdapter,
  ExecutionContext,
  ExecutionRequest,
  ExecutionResult,
  ResourceDescriptor,
  ConnectionCredentialResolver,
  ResourceState,
  SecretResolver,
} from '@nexar/contracts';
import {
  DEFAULT_ALLOWED_PROVIDERS,
  KEYLESS_LOCAL_PLACEHOLDER_KEY,
  createAllowlistedModels,
  createChatGptPlanModels,
  createLocalEndpointModels,
} from './pi-models.js';
import type { PiModelLike, PiModelsLike } from './pi-models.js';
import { usesChatGptPlan, withChatGptPlanToken } from './connection-credential.js';
import { PI_ADAPTER_ID } from './resource.js';
import { configError, parseRuntimeOptions, readPiCredential } from './runtime-options.js';
import type { PiRuntimeOptions } from './runtime-options.js';
import { toExecutionResult, toThrownNexarError } from './result.js';
import { planRequestError } from './result.js';
import { createPlanRequestGuard, notifyPlanModelRejected } from './plan-request.js';

/** Options for {@link PiExecutionAdapter}. */
export interface PiExecutionAdapterOptions {
  /** Injection seam for tests; defaults to a collection built lazily from the allowlist. */
  readonly models?: PiModelsLike;
  /** Environment used to resolve credential references. Defaults to `process.env`. */
  readonly env?: NodeJS.ProcessEnv;
  /**
   * Resolves `keystore` credential references (injected by the host). Without it, a keystore
   * reference counts as not stored; the environment is never consulted for it.
   */
  readonly resolveSecret?: SecretResolver;
  /**
   * Resolves the ChatGPT plan connection to a short-lived access token (Desktop main only). Without
   * it a connection credential is refused (POLICY_REJECTED), as every subscription mode is.
   */
  readonly resolveCredential?: ConnectionCredentialResolver;
  /** Test seam: the `fetch` pi-ai uses for plan calls. Production never sets it. */
  readonly fetch?: typeof fetch;
  readonly onPlanModelRejected?: (descriptor: ResourceDescriptor) => void;
  readonly isPlanModelAvailable?: (descriptor: ResourceDescriptor) => boolean;
  /** Providers this adapter may call. Defaults to {@link DEFAULT_ALLOWED_PROVIDERS}. */
  readonly allowedProviders?: readonly string[];
  /** Clock (epoch ms) for message and probe timestamps. Defaults to `Date.now`. */
  readonly now?: () => number;
}

type ModelKind = Extract<ResourceDescriptor['kind'], { type: 'model' }>;
type ModelResource = ResourceDescriptor & { readonly kind: ModelKind };

/**
 * Executes `model` resources directly through pi-ai (API keys, gateways, local
 * OpenAI-compatible servers). Subscription/OAuth access is intentionally not offered here.
 */
export class PiExecutionAdapter implements ExecutionAdapter {
  readonly id = PI_ADAPTER_ID;
  readonly displayName = 'pi-ai direct model adapter';

  private readonly env: NodeJS.ProcessEnv;
  private readonly resolveSecret: SecretResolver | undefined;
  private readonly resolveCredential: ConnectionCredentialResolver | undefined;
  private readonly fetchImpl: typeof fetch | undefined;
  private readonly onPlanModelRejected: PiExecutionAdapterOptions['onPlanModelRejected'];
  private readonly isPlanModelAvailable: PiExecutionAdapterOptions['isPlanModelAvailable'];
  /** Resources the provider refused as not eligible; the next probe reports them unauthenticated. */
  private readonly notEligible = new Set<string>();
  private readonly allowedProviders: readonly string[];
  private readonly now: () => number;
  private readonly injected: PiModelsLike | undefined;
  private defaultModels: Promise<PiModelsLike> | undefined;
  private readonly localModels = new Map<string, PiModelsLike>();

  constructor(options: PiExecutionAdapterOptions = {}) {
    this.injected = options.models;
    this.env = options.env ?? process.env;
    this.resolveSecret = options.resolveSecret;
    this.resolveCredential = options.resolveCredential;
    this.fetchImpl = options.fetch;
    this.onPlanModelRejected = options.onPlanModelRejected;
    this.isPlanModelAvailable = options.isPlanModelAvailable;
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
      if (options.baseUrl === undefined) this.assertProviderAllowed(kind.provider, resource);
      if (usesChatGptPlan(target) && !this.planAvailable(target)) {
        return {
          availability: 'unavailable',
          auth: 'unknown',
          detail: 'model-unavailable',
          observedAt,
        };
      }
      if (options.baseUrl === undefined && !usesChatGptPlan(target)) {
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
      if (usesChatGptPlan(target)) {
        // Probes never call the model or the token endpoint: connected means the host offers the seam.
        if (this.notEligible.has(resource.id)) {
          return {
            availability: 'available',
            auth: 'unauthenticated',
            detail: 'plan-not-eligible',
            observedAt,
          };
        }
        return {
          availability: 'available',
          auth: this.resolveCredential === undefined ? 'unauthenticated' : 'authenticated',
          observedAt,
        };
      }
      const authState =
        auth.mode === 'none'
          ? 'not-required'
          : readPiCredential(auth.credential, this.env, this.resolveSecret) === undefined
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
    if (this.resolveCredential !== undefined && usesChatGptPlan(target)) {
      if (!this.planAvailable(target)) throw planRequestError('model-unavailable');
      const resolver = this.resolveCredential;
      try {
        return await withChatGptPlanToken(resolver, resource, context.signal, (token) =>
          this.runModel(target, request, context, options, token, true),
        );
      } catch (e) {
        if (isPlanNotEligible(e)) this.notEligible.add(resource.id);
        throw e;
      }
    }

    let apiKey: string | undefined;
    if (target.auth.mode === 'api-key') {
      apiKey = readPiCredential(target.auth.credential, this.env, this.resolveSecret);
      if (apiKey === undefined) {
        const { credential } = target.auth;
        if (credential.source === 'keystore') {
          throw new NexarError(
            'AUTH_REQUIRED',
            `Credential ${credential.name} is not stored in the Nexar key store`,
            { details: { keystore: credential.name } },
          );
        }
        const name = credential.source === 'env' ? credential.name : '';
        throw new NexarError(
          'AUTH_REQUIRED',
          `Credential environment variable ${name} is not set`,
          {
            details: { env: name },
          },
        );
      }
    }
    return this.runModel(target, request, context, options, apiKey, false);
  }

  private async runModel(
    target: ModelResource,
    request: ExecutionRequest,
    context: ExecutionContext,
    options: PiRuntimeOptions,
    apiKey: string | undefined,
    plan: boolean,
  ): Promise<ExecutionResult> {
    const { kind } = target;
    let availabilityFailure: NexarError | undefined;
    const assertPlanAvailable = (): void => {
      if (plan && !this.planAvailable(target)) {
        availabilityFailure = planRequestError('model-unavailable');
        throw availabilityFailure;
      }
    };
    // Credential resolution can yield to disconnect/refresh; recheck before loading or calling.
    assertPlanAvailable();
    const secrets = apiKey === undefined ? [] : [apiKey];
    const guard = plan ? createPlanRequestGuard(this.fetchImpl, context.signal) : undefined;
    try {
      const models = await this.modelsFor(target, options);
      assertPlanAvailable();
      const model = models.getModel(kind.provider, kind.model);
      if (model === undefined) {
        throw configError(`Unknown model ${kind.provider}/${kind.model}`, {
          provider: kind.provider,
          model: kind.model,
        });
      }
      assertPlanAvailable();
      const message = await this.complete(
        models,
        model,
        request,
        context,
        options,
        apiKey,
        plan,
        guard,
      );
      if (guard !== undefined && message.stopReason === 'error') throw guard.failure();
      return toExecutionResult(message, {
        secrets,
        ...(plan ? { costMode: 'unavailable' as const } : {}),
        ...(context.onEvent === undefined ? {} : { onEvent: context.onEvent }),
      });
    } catch (e) {
      if (availabilityFailure !== undefined && e === availabilityFailure) throw e;
      if (guard !== undefined) {
        if (guard.rejectedModel) notifyPlanModelRejected(this.onPlanModelRejected, target);
        throw guard.failure();
      }
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
    plan: boolean,
    guard?: ReturnType<typeof createPlanRequestGuard>,
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
        // The plan route rejects `max_output_tokens`; pi-ai omits it there, and so does Nexar.
        ...(options.maxTokens === undefined || plan ? {} : { maxTokens: options.maxTokens }),
        ...(options.reasoning === undefined || plan ? {} : { reasoning: options.reasoning }),
        ...(guard === undefined
          ? {}
          : {
              fetch: guard.fetch,
              onProviderStreamEvent: guard.onProviderStreamEvent,
              onPayload: guard.onPayload,
            }),
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
    if (this.resolveCredential !== undefined && usesChatGptPlan(resource)) return;
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
    if (usesChatGptPlan(resource)) {
      if (this.injected !== undefined) return Promise.resolve(this.injected);
      const key = `chatgpt-plan\u0000${resource.kind.model}`;
      let models = this.localModels.get(key);
      if (models === undefined) {
        models = createChatGptPlanModels(resource.kind.model);
        this.localModels.set(key, models);
      }
      return Promise.resolve(models);
    }
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

  private planAvailable(resource: ModelResource): boolean {
    try {
      return resource.kind.provider === 'openai' && (this.isPlanModelAvailable?.(resource) ?? true);
    } catch {
      return false;
    }
  }
}

function isPlanNotEligible(e: unknown): boolean {
  return isNexarError(e) && e.details?.['reason'] === 'plan-not-eligible';
}
