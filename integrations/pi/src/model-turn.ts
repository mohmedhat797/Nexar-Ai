import {
  NexarError,
  assertExtrasWithinBounds,
  measured,
  estimated,
  unavailable,
  type ControlTurnResult,
  type Measured,
  type ModelTurnMessage,
  type ModelTurnPort,
  type ModelTurnPortRequest,
  type ModelTurnTool,
  type ConnectionCredentialResolver,
  type ResourceDescriptor,
  type SecretResolver,
} from '@nexar/contracts';
import {
  DEFAULT_ALLOWED_PROVIDERS,
  KEYLESS_LOCAL_PLACEHOLDER_KEY,
  createAllowlistedModels,
  createChatGptPlanModels,
  createLocalEndpointModels,
} from './pi-models.js';
import type {
  PiAssistantMessageLike,
  PiContentBlockLike,
  PiContextLike,
  PiModelLike,
  PiModelsLike,
  PiRequestOptionsLike,
} from './pi-models.js';
import { usesChatGptPlan, withChatGptPlanToken } from './connection-credential.js';
import { PI_ADAPTER_ID } from './resource.js';
import { failureFor, toThrownNexarError } from './result.js';
import { planRequestError } from './result.js';
import { createPlanRequestGuard, notifyPlanModelRejected } from './plan-request.js';
import { configError, parseRuntimeOptions, readPiCredential } from './runtime-options.js';
import type { PiRuntimeOptions } from './runtime-options.js';

/** Options for {@link PiModelTurnPort}; the credential and model handling mirrors the adapter. */
export interface PiModelTurnPortOptions {
  /** Injection seam for tests; defaults to a collection built lazily from the allowlist. */
  readonly models?: PiModelsLike;
  readonly env?: NodeJS.ProcessEnv;
  readonly resolveSecret?: SecretResolver;
  /** The ChatGPT plan connection's token seam (Desktop main only); see the adapter option. */
  readonly resolveCredential?: ConnectionCredentialResolver;
  /** Test seam: the `fetch` pi-ai uses for plan calls. Production never sets it. */
  readonly fetch?: typeof fetch;
  readonly onPlanModelRejected?: (descriptor: ResourceDescriptor) => void;
  readonly isPlanModelAvailable?: (descriptor: ResourceDescriptor) => boolean;
  readonly allowedProviders?: readonly string[];
  /** Clock (epoch ms) for message timestamps. Defaults to `Date.now`. */
  readonly now?: () => number;
}

type TurnResult = Omit<ControlTurnResult, 'resourceId'>;
type ModelKind = Extract<ResourceDescriptor['kind'], { type: 'model' }>;

/** The provider-private layout of one assistant message, kept in `extras.pi`. */
interface SavedBlock {
  readonly type: 'text' | 'thinking' | 'toolCall';
  readonly text?: string;
  readonly textSignature?: string;
  readonly thinking?: string;
  readonly thinkingSignature?: string;
  readonly redacted?: boolean;
  readonly id?: string;
  readonly name?: string;
  readonly thoughtSignature?: string;
  readonly namespace?: string;
}

const EXTRAS_KEY = 'pi';
const MAX_SAVED_BLOCKS = 256;

const str = (v: unknown): v is string => typeof v === 'string';

function pick<T extends object, K extends keyof T>(
  source: T,
  keys: readonly K[],
): Partial<Pick<T, K>> {
  const out: Partial<Pick<T, K>> = {};
  for (const key of keys) if (source[key] !== undefined) out[key] = source[key];
  return out;
}

function toSavedBlocks(content: readonly PiContentBlockLike[]): SavedBlock[] {
  const saved: SavedBlock[] = [];
  for (const block of content.slice(0, MAX_SAVED_BLOCKS)) {
    if (block.type === 'text') {
      saved.push({ type: 'text', text: block.text ?? '', ...pick(block, ['textSignature']) });
    } else if (block.type === 'thinking') {
      saved.push({
        type: 'thinking',
        thinking: block.thinking ?? '',
        ...pick(block, ['thinkingSignature', 'redacted']),
      });
    } else if (block.type === 'toolCall') {
      saved.push({
        type: 'toolCall',
        id: block.id ?? '',
        name: block.name ?? '',
        ...pick(block, ['thoughtSignature', 'namespace']),
      });
    }
  }
  return saved;
}

/** Shape-guards extras that came back from the engine; anything unexpected is ignored. */
function readSavedBlocks(extras: ModelTurnMessage['extras']): SavedBlock[] | undefined {
  const raw = extras?.[EXTRAS_KEY];
  if (
    typeof raw !== 'object' ||
    raw === null ||
    !Array.isArray((raw as { blocks?: unknown }).blocks)
  ) {
    return undefined;
  }
  const blocks: SavedBlock[] = [];
  for (const item of (raw as { blocks: unknown[] }).blocks.slice(0, MAX_SAVED_BLOCKS)) {
    if (typeof item !== 'object' || item === null) return undefined;
    const b = item as Record<string, unknown>;
    const optional = (k: string): boolean => b[k] === undefined || str(b[k]);
    if (!['text', 'thinking', 'toolCall'].includes(b.type as string)) return undefined;
    if (
      ![
        'text',
        'textSignature',
        'thinking',
        'thinkingSignature',
        'id',
        'name',
        'thoughtSignature',
        'namespace',
      ].every(optional)
    ) {
      return undefined;
    }
    blocks.push(
      pick(b as unknown as SavedBlock, [
        'type',
        'text',
        'textSignature',
        'thinking',
        'thinkingSignature',
        'redacted',
        'id',
        'name',
        'thoughtSignature',
        'namespace',
      ]) as SavedBlock,
    );
  }
  return blocks;
}

/**
 * Rebuilds the assistant content. The saved layout (thinking blocks, signatures) is used only
 * when it still matches what the engine sends back; otherwise plain text and tool calls are used.
 */
function assistantContent(message: ModelTurnMessage): PiContentBlockLike[] {
  const calls = message.toolCalls ?? [];
  const plain: PiContentBlockLike[] = [
    ...(message.content === undefined || message.content === ''
      ? []
      : [{ type: 'text', text: message.content }]),
    ...calls.map((c) => ({ type: 'toolCall', id: c.id, name: c.name, arguments: c.arguments })),
  ];
  const saved = readSavedBlocks(message.extras);
  if (saved === undefined) return plain;
  const savedText = saved
    .filter((b) => b.type === 'text')
    .map((b) => b.text ?? '')
    .join('');
  const savedIds = saved.filter((b) => b.type === 'toolCall').map((b) => b.id);
  if (
    savedText !== (message.content ?? '') ||
    savedIds.length !== calls.length ||
    !calls.every((c, i) => c.id === savedIds[i])
  ) {
    return plain;
  }
  let callIndex = 0;
  return saved.map((b): PiContentBlockLike => {
    if (b.type === 'text')
      return { type: 'text', text: b.text ?? '', ...pick(b, ['textSignature']) };
    if (b.type === 'thinking') {
      return {
        type: 'thinking',
        thinking: b.thinking ?? '',
        ...pick(b, ['thinkingSignature', 'redacted']),
      };
    }
    const call = calls[callIndex++];
    return {
      type: 'toolCall',
      id: call?.id ?? '',
      name: call?.name ?? '',
      arguments: call?.arguments ?? {},
      ...pick(b, ['thoughtSignature', 'namespace']),
    };
  });
}

function toPiContext(
  request: ModelTurnPortRequest,
  model: PiModelLike,
  now: number,
): PiContextLike {
  const system: string[] = [];
  const messages: object[] = [];
  const toolNames = new Map<string, string>();
  for (const message of request.messages) {
    if (message.role === 'system') {
      if (message.content !== undefined) system.push(message.content);
    } else if (message.role === 'user') {
      messages.push({ role: 'user', content: message.content ?? '', timestamp: now });
    } else if (message.role === 'assistant') {
      for (const call of message.toolCalls ?? []) toolNames.set(call.id, call.name);
      messages.push({
        role: 'assistant',
        content: assistantContent(message),
        api: model.api ?? '',
        provider: model.provider,
        model: model.id,
        usage: {
          input: 0,
          output: 0,
          cacheRead: 0,
          cacheWrite: 0,
          totalTokens: 0,
          cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
        },
        stopReason: (message.toolCalls?.length ?? 0) > 0 ? 'toolUse' : 'stop',
        timestamp: now,
      });
    } else {
      messages.push({
        role: 'toolResult',
        toolCallId: message.toolCallId ?? '',
        toolName: toolNames.get(message.toolCallId ?? '') ?? '',
        content: [{ type: 'text', text: message.content ?? '' }],
        isError: false,
        timestamp: now,
      });
    }
  }
  const tools = request.tools?.map((t: ModelTurnTool) => ({
    name: t.name,
    description: t.description ?? '',
    parameters: t.parameters,
  }));
  return {
    ...(system.length === 0 ? {} : { systemPrompt: system.join('\n\n') }),
    messages,
    ...(tools === undefined || tools.length === 0 ? {} : { tools }),
  };
}

/** Reported counts are `measured`; a missing/zero count is `unavailable`, never a faked 0. */
function tokens(value: number): Measured<number> {
  return Number.isFinite(value) && value > 0
    ? measured(value)
    : unavailable('provider reported no token count');
}

function toTurnResult(message: PiAssistantMessageLike, plan: boolean): TurnResult {
  const text = message.content
    .filter((b) => b.type === 'text')
    .map((b) => b.text ?? '')
    .join('');
  const toolCalls = message.content
    .filter((b) => b.type === 'toolCall')
    .map((b) => ({ id: b.id ?? '', name: b.name ?? '', arguments: b.arguments ?? {} }));
  const finishReason: ControlTurnResult['finishReason'] =
    message.stopReason === 'length'
      ? 'length'
      : toolCalls.length > 0 || message.stopReason === 'toolUse'
        ? 'tool-calls'
        : message.stopReason === 'stop'
          ? 'stop'
          : 'error';
  const extras = { [EXTRAS_KEY]: { blocks: toSavedBlocks(message.content) } };
  let withExtras = true;
  try {
    assertExtrasWithinBounds(extras);
  } catch {
    withExtras = false; // Oversize provider-private data is dropped rather than forwarded.
  }
  return {
    ...(text === '' ? {} : { text }),
    toolCalls,
    finishReason,
    usage: {
      inputTokens: tokens(message.usage.input),
      outputTokens: tokens(message.usage.output),
      cacheReadTokens: tokens(message.usage.cacheRead),
      cacheWriteTokens: tokens(message.usage.cacheWrite),
      costUsd: plan
        ? unavailable('ChatGPT plan usage has no reported cash cost')
        : Number.isFinite(message.usage.cost.total) && message.usage.cost.total > 0
          ? estimated(message.usage.cost.total, 'pi-ai catalog rates')
          : unavailable('provider has no reported cash cost'),
    },
    ...(withExtras ? { extras } : {}),
  };
}

/**
 * One model turn on a `pi` model resource (API key, gateway or local endpoint) for the Control
 * Model Gateway. Tool calls are returned, never executed. pi-ai types stay inside `pi-models.ts`.
 */
export class PiModelTurnPort implements ModelTurnPort {
  private readonly env: NodeJS.ProcessEnv;
  private readonly resolveSecret: SecretResolver | undefined;
  private readonly resolveCredential: ConnectionCredentialResolver | undefined;
  private readonly fetchImpl: typeof fetch | undefined;
  private readonly onPlanModelRejected: PiModelTurnPortOptions['onPlanModelRejected'];
  private readonly isPlanModelAvailable: PiModelTurnPortOptions['isPlanModelAvailable'];
  private readonly allowedProviders: readonly string[];
  private readonly now: () => number;
  private readonly injected: PiModelsLike | undefined;
  private defaultModels: Promise<PiModelsLike> | undefined;
  private readonly localModels = new Map<string, PiModelsLike>();

  constructor(options: PiModelTurnPortOptions = {}) {
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

  /** True for `pi` model resources; the gateway's port lookup can use it. */
  supports(descriptor: ResourceDescriptor): boolean {
    return descriptor.runtime.adapter === PI_ADAPTER_ID && descriptor.kind.type === 'model';
  }

  async turn(request: ModelTurnPortRequest): Promise<TurnResult> {
    const { descriptor, signal } = request;
    if (!this.supports(descriptor) || descriptor.kind.type !== 'model') {
      throw configError('Resource is not a pi model resource', { resource: descriptor.id });
    }
    const kind: ModelKind = descriptor.kind;
    const plan = this.resolveCredential !== undefined && usesChatGptPlan(descriptor);
    if (!plan && (descriptor.auth.mode === 'oauth' || descriptor.auth.mode === 'subscription')) {
      throw new NexarError(
        'POLICY_REJECTED',
        'subscription auth via pi-ai is disabled; use a native agent resource',
        { details: { resource: descriptor.id, mode: descriptor.auth.mode } },
      );
    }
    const options = parseRuntimeOptions(descriptor);
    if (options.baseUrl === undefined && !this.allowedProviders.includes(kind.provider)) {
      throw new NexarError(
        'POLICY_REJECTED',
        `Provider ${kind.provider} is not allowed for pi-ai`,
        {
          details: { provider: kind.provider, resource: descriptor.id },
        },
      );
    }
    if (signal.aborted) throw new NexarError('EXECUTION_CANCELLED', 'Turn was cancelled');

    if (plan && this.resolveCredential !== undefined) {
      if (!this.planAvailable(descriptor)) throw planRequestError('model-unavailable');
      return withChatGptPlanToken(this.resolveCredential, descriptor, signal, (token) =>
        this.attempt(request, kind, options, token, true),
      );
    }
    let apiKey: string | undefined;
    if (descriptor.auth.mode === 'api-key') {
      apiKey = readPiCredential(descriptor.auth.credential, this.env, this.resolveSecret);
      if (apiKey === undefined) {
        throw new NexarError('AUTH_REQUIRED', 'The control resource credential is not available', {
          details: { resource: descriptor.id },
        });
      }
    }
    return this.attempt(request, kind, options, apiKey, false);
  }

  private async attempt(
    request: ModelTurnPortRequest,
    kind: ModelKind,
    options: PiRuntimeOptions,
    apiKey: string | undefined,
    plan: boolean,
  ): Promise<TurnResult> {
    const { descriptor, signal } = request;
    let availabilityFailure: NexarError | undefined;
    const assertPlanAvailable = (): void => {
      if (plan && !this.planAvailable(descriptor)) {
        availabilityFailure = planRequestError('model-unavailable');
        throw availabilityFailure;
      }
    };
    assertPlanAvailable();
    const secrets = apiKey === undefined ? [] : [apiKey];
    const guard = plan ? createPlanRequestGuard(this.fetchImpl, signal) : undefined;
    try {
      const models = await this.modelsFor(descriptor, kind, options);
      assertPlanAvailable();
      const model = models.getModel(kind.provider, kind.model);
      if (model === undefined) {
        throw configError(`Unknown model ${kind.provider}/${kind.model}`, {
          provider: kind.provider,
          model: kind.model,
        });
      }
      // The plan route rejects `max_output_tokens` and `temperature`; neither is sent there.
      const maxTokens = plan ? undefined : (request.settings?.maxOutputTokens ?? options.maxTokens);
      const temperature = plan ? undefined : request.settings?.temperature;
      const requestOptions: PiRequestOptionsLike = {
        signal,
        ...(maxTokens === undefined ? {} : { maxTokens }),
        ...(temperature === undefined ? {} : { temperature }),
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
      };
      const context = toPiContext(request, model, this.now());
      assertPlanAvailable();
      const message = await this.run(models, model, context, requestOptions, request.onDelta);
      if (message.stopReason === 'aborted') {
        throw new NexarError('EXECUTION_CANCELLED', 'Turn was cancelled');
      }
      if (message.stopReason === 'error')
        throw guard === undefined ? failureFor(message, secrets) : guard.failure();
      return toTurnResult(message, plan);
    } catch (e) {
      if (availabilityFailure !== undefined && e === availabilityFailure) throw e;
      if (guard !== undefined) {
        if (guard.rejectedModel) notifyPlanModelRejected(this.onPlanModelRejected, descriptor);
        throw guard.failure();
      }
      throw toThrownNexarError(e, signal, secrets);
    }
  }

  private planAvailable(descriptor: ResourceDescriptor): boolean {
    try {
      return (
        descriptor.kind.type === 'model' &&
        descriptor.kind.provider === 'openai' &&
        (this.isPlanModelAvailable?.(descriptor) ?? true)
      );
    } catch {
      return false;
    }
  }

  private async run(
    models: PiModelsLike,
    model: PiModelLike,
    context: PiContextLike,
    options: PiRequestOptionsLike,
    onDelta: ((text: string) => void) | undefined,
  ): Promise<PiAssistantMessageLike> {
    if (onDelta === undefined || models.streamSimple === undefined) {
      const message = await models.completeSimple(model, context, options);
      const text = message.content
        .filter((b) => b.type === 'text')
        .map((b) => b.text ?? '')
        .join('');
      if (onDelta !== undefined && text !== '') onDelta(text);
      return message;
    }
    const stream = models.streamSimple(model, context, options);
    for await (const event of stream) {
      if (event.type === 'text_delta' && event.delta !== undefined) onDelta(event.delta);
    }
    return stream.result();
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

  private modelsFor(
    descriptor: ResourceDescriptor,
    kind: ModelKind,
    options: PiRuntimeOptions,
  ): Promise<PiModelsLike> {
    if (usesChatGptPlan(descriptor)) {
      if (this.injected !== undefined) return Promise.resolve(this.injected);
      const key = `chatgpt-plan\u0000${kind.model}`;
      let models = this.localModels.get(key);
      if (models === undefined) {
        models = createChatGptPlanModels(kind.model);
        this.localModels.set(key, models);
      }
      return Promise.resolve(models);
    }
    if (options.baseUrl === undefined) return this.getDefaultModels();
    const key = `${kind.provider}\u0000${kind.model}\u0000${options.baseUrl}`;
    let models = this.localModels.get(key);
    if (models === undefined) {
      models = createLocalEndpointModels({
        provider: kind.provider,
        model: kind.model,
        baseUrl: options.baseUrl,
        ...(descriptor.limits?.contextWindowTokens === undefined
          ? {}
          : { contextWindowTokens: descriptor.limits.contextWindowTokens }),
        ...(descriptor.limits?.maxOutputTokens === undefined
          ? {}
          : { maxOutputTokens: descriptor.limits.maxOutputTokens }),
      });
      this.localModels.set(key, models);
    }
    return Promise.resolve(models);
  }
}
