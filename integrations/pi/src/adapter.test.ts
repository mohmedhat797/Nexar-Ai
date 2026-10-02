import { createModels, fauxAssistantMessage, fauxProvider, fauxText } from '@earendil-works/pi-ai';
import { NexarError, resourceId, taskId } from '@nexar/contracts';
import type {
  ExecutionContext,
  ExecutionEvent,
  ExecutionRequest,
  Logger,
  ResourceDescriptor,
  SecretResolver,
} from '@nexar/contracts';
import { describe, expect, it, vi } from 'vitest';
import { PiExecutionAdapter, piModelResource } from './index.js';
import type { PiModelsLike } from './index.js';

const KEY_ENV = 'TEST_PI_KEY';
const SECRET = 'sk-test-secret-value';

function silentLogger(): Logger {
  const logger: Logger = {
    debug: () => undefined,
    info: () => undefined,
    warn: () => undefined,
    error: () => undefined,
    child: () => logger,
  };
  return logger;
}

function setup(
  options: {
    env?: NodeJS.ProcessEnv;
    allowedProviders?: readonly string[];
    resolveSecret?: SecretResolver;
  } = {},
) {
  const faux = fauxProvider({
    models: [
      { id: 'faux-1', reasoning: true, cost: { input: 1, output: 2, cacheRead: 0, cacheWrite: 0 } },
    ],
  });
  const models = createModels();
  models.setProvider(faux.provider);
  const provider = faux.getModel().provider;
  const adapter = new PiExecutionAdapter({
    models,
    env: options.env ?? { [KEY_ENV]: SECRET },
    allowedProviders: options.allowedProviders ?? [provider],
    ...(options.resolveSecret === undefined ? {} : { resolveSecret: options.resolveSecret }),
    now: () => 1_700_000_000_000,
  });
  const resource = piModelResource({
    id: 'pi-faux',
    provider,
    model: 'faux-1',
    apiKeyEnv: KEY_ENV,
  });
  return { faux, adapter, resource, provider };
}

function request(resource: ResourceDescriptor): ExecutionRequest {
  return {
    resource,
    task: {
      id: taskId('t1'),
      kind: 'general',
      input: { prompt: 'Say hi', systemPrompt: 'Be brief' },
      requirements: { capabilities: ['text-generation'] },
      origin: { source: 'test' },
      createdAt: '2026-01-01T00:00:00.000Z',
    },
  };
}

function context(overrides: Partial<ExecutionContext> = {}): ExecutionContext {
  return { signal: new AbortController().signal, logger: silentLogger(), ...overrides };
}

async function failure(promise: Promise<unknown>): Promise<NexarError> {
  try {
    await promise;
  } catch (e) {
    expect(e).toBeInstanceOf(NexarError);
    return e as NexarError;
  }
  throw new Error('expected the call to reject');
}

describe('PiExecutionAdapter.supports', () => {
  it('accepts pi model resources only', () => {
    const { adapter, resource } = setup();
    expect(adapter.supports(resource)).toBe(true);
    expect(
      adapter.supports({ ...resource, runtime: { ...resource.runtime, adapter: adapter.id } }),
    ).toBe(true);
    const other = { ...resource, runtime: { adapter: 'other', locality: 'remote' } };
    expect(adapter.supports(other as unknown as ResourceDescriptor)).toBe(false);
    const agent: ResourceDescriptor = {
      ...resource,
      kind: { type: 'agent', agent: 'pi', interface: 'rpc' },
    };
    expect(adapter.supports(agent)).toBe(false);
  });
});

describe('PiExecutionAdapter.execute', () => {
  it('returns text, measured usage and resolved model on success', async () => {
    const { faux, adapter, resource, provider } = setup();
    faux.setResponses([fauxAssistantMessage(fauxText('hello there'))]);

    const result = await adapter.execute(request(resource), context());

    expect(result.text).toBe('hello there');
    expect(result.usage.inputTokens.status).toBe('measured');
    expect(result.usage.outputTokens.status).toBe('measured');
    expect(result.usage.costUsd).toMatchObject({
      status: 'estimated',
      basis: 'pi-ai catalog rates',
    });
    expect(result.resolved).toEqual({
      provider,
      model: 'faux-1',
      runtimeVersion: '@earendil-works/pi-ai@0.99.2',
    });
    expect(faux.state.callCount).toBe(1);
  });

  it('sends the prompt, system prompt, key and request options to pi-ai', async () => {
    const { faux, adapter, resource } = setup();
    let seen: unknown;
    faux.setResponses([
      (ctx, opts) => {
        seen = { ctx, opts };
        return fauxAssistantMessage('ok');
      },
    ]);
    const withOptions = {
      ...resource,
      runtime: { ...resource.runtime, options: { maxTokens: 64, reasoning: 'low' } },
    };

    await adapter.execute(request(withOptions), context());

    const { ctx, opts } = seen as { ctx: { messages: unknown[] }; opts: Record<string, unknown> };
    expect(JSON.stringify(ctx)).toContain('Say hi');
    expect(JSON.stringify(ctx)).toContain('Be brief');
    expect(opts).toMatchObject({ apiKey: SECRET, maxTokens: 64 });
    expect(opts.signal).toBeInstanceOf(AbortSignal);
  });

  it('emits a status event and still succeeds when output is truncated', async () => {
    const { faux, adapter, resource } = setup();
    faux.setResponses([fauxAssistantMessage('partial', { stopReason: 'length' })]);
    const events: ExecutionEvent[] = [];

    const result = await adapter.execute(
      request(resource),
      context({ onEvent: (e) => events.push(e) }),
    );

    expect(result.text).toBe('partial');
    expect(events).toEqual([{ type: 'status', message: 'output truncated' }]);
  });

  it('maps a 401 error message to AUTH_REQUIRED', async () => {
    const { faux, adapter, resource } = setup();
    faux.setResponses([
      fauxAssistantMessage('', { stopReason: 'error', errorMessage: '401 Unauthorized' }),
    ]);
    const error = await failure(adapter.execute(request(resource), context()));
    expect(error.code).toBe('AUTH_REQUIRED');
  });

  it('maps a 429 error message to QUOTA_EXHAUSTED', async () => {
    const { faux, adapter, resource } = setup();
    faux.setResponses([
      fauxAssistantMessage('', { stopReason: 'error', errorMessage: '429 rate limit exceeded' }),
    ]);
    const error = await failure(adapter.execute(request(resource), context()));
    expect(error.code).toBe('QUOTA_EXHAUSTED');
    expect(error.retryable).toBe(true);
  });

  it('maps other error messages to PROVIDER_ERROR, truncated and without the key', async () => {
    const { faux, adapter, resource } = setup();
    faux.setResponses([
      fauxAssistantMessage('', {
        stopReason: 'error',
        errorMessage: `boom ${SECRET} ${'x'.repeat(500)}`,
      }),
    ]);
    const error = await failure(adapter.execute(request(resource), context()));
    expect(error.code).toBe('PROVIDER_ERROR');
    expect(error.message).not.toContain(SECRET);
    expect(error.message.length).toBeLessThanOrEqual(301);
  });

  it('maps an aborted message to EXECUTION_CANCELLED', async () => {
    const { faux, adapter, resource } = setup();
    faux.setResponses([fauxAssistantMessage('', { stopReason: 'aborted' })]);
    const error = await failure(adapter.execute(request(resource), context()));
    expect(error.code).toBe('EXECUTION_CANCELLED');
  });

  it('cancels when the signal fires during the call', async () => {
    const { faux, adapter, resource } = setup();
    const controller = new AbortController();
    faux.setResponses([
      async (_ctx, opts) => {
        await new Promise<void>((resolve) =>
          opts?.signal?.addEventListener('abort', () => resolve(), { once: true }),
        );
        return fauxAssistantMessage('late');
      },
    ]);
    const pending = adapter.execute(request(resource), context({ signal: controller.signal }));
    setTimeout(() => controller.abort(), 10);
    const error = await failure(pending);
    expect(error.code).toBe('EXECUTION_CANCELLED');
  });

  it('does not call the provider when the signal is already aborted', async () => {
    const { faux, adapter, resource } = setup();
    faux.setResponses([fauxAssistantMessage('never')]);
    const controller = new AbortController();
    controller.abort();
    const error = await failure(
      adapter.execute(request(resource), context({ signal: controller.signal })),
    );
    expect(error.code).toBe('EXECUTION_CANCELLED');
    expect(faux.state.callCount).toBe(0);
  });

  it('maps thrown pi-ai errors to PROVIDER_ERROR without leaking the key', async () => {
    const throwing: PiModelsLike = {
      getModel: (provider, id) => ({ provider, id }),
      completeSimple: () => Promise.reject(new Error(`network down for ${SECRET}`)),
    };
    const adapter = new PiExecutionAdapter({
      models: throwing,
      env: { [KEY_ENV]: SECRET },
      allowedProviders: ['anthropic'],
    });
    const resource = piModelResource({
      id: 'r',
      provider: 'anthropic',
      model: 'm',
      apiKeyEnv: KEY_ENV,
    });
    const error = await failure(adapter.execute(request(resource), context()));
    expect(error.code).toBe('PROVIDER_ERROR');
    expect(error.message).toContain('network down');
    expect(error.message).not.toContain(SECRET);
  });

  it('maps thrown abort errors to EXECUTION_CANCELLED', async () => {
    const controller = new AbortController();
    const throwing: PiModelsLike = {
      getModel: (provider, id) => ({ provider, id }),
      completeSimple: () => {
        controller.abort();
        return Promise.reject(new Error('The operation was aborted'));
      },
    };
    const adapter = new PiExecutionAdapter({ models: throwing, allowedProviders: ['anthropic'] });
    const resource = piModelResource({ id: 'r', provider: 'anthropic', model: 'm' });
    const error = await failure(
      adapter.execute(request(resource), context({ signal: controller.signal })),
    );
    expect(error.code).toBe('EXECUTION_CANCELLED');
  });

  it('throws AUTH_REQUIRED before any call when the env credential is missing or empty', async () => {
    for (const env of [{}, { [KEY_ENV]: '' }]) {
      const { faux, adapter, resource } = setup({ env });
      faux.setResponses([fauxAssistantMessage('never')]);
      const error = await failure(adapter.execute(request(resource), context()));
      expect(error.code).toBe('AUTH_REQUIRED');
      expect(error.details).toEqual({ env: KEY_ENV });
      expect(faux.state.callCount).toBe(0);
    }
  });

  it('runs keyless (mode none) resources without an apiKey', async () => {
    const { faux, adapter, provider } = setup({ env: {} });
    const resource = piModelResource({ id: 'nokey', provider, model: 'faux-1' });
    let apiKey: unknown = 'unset';
    faux.setResponses([
      (_ctx, opts) => {
        apiKey = opts?.apiKey;
        return fauxAssistantMessage('ok');
      },
    ]);
    await adapter.execute(request(resource), context());
    expect(apiKey).toBeUndefined();
  });

  it('rejects providers outside the allowlist with POLICY_REJECTED', async () => {
    const { faux, adapter, provider } = setup({ allowedProviders: ['anthropic'] });
    const resource = piModelResource({ id: 'x', provider, model: 'faux-1', apiKeyEnv: KEY_ENV });
    const error = await failure(adapter.execute(request(resource), context()));
    expect(error.code).toBe('POLICY_REJECTED');
    expect(faux.state.callCount).toBe(0);
  });

  it.each(['oauth', 'subscription'] as const)(
    'rejects %s auth with POLICY_REJECTED',
    async (mode) => {
      const { faux, adapter, resource } = setup();
      const subscription: ResourceDescriptor = {
        ...resource,
        auth: { mode, credential: { source: 'runtime-managed', description: 'login' } },
      };
      const error = await failure(adapter.execute(request(subscription), context()));
      expect(error.code).toBe('POLICY_REJECTED');
      expect(error.message).toContain('subscription auth via pi-ai is disabled in v0.1');
      expect(faux.state.callCount).toBe(0);
    },
  );

  it('reports unknown models as CONFIGURATION_ERROR with provider and model', async () => {
    const { adapter, provider } = setup();
    const resource = piModelResource({ id: 'x', provider, model: 'nope', apiKeyEnv: KEY_ENV });
    const error = await failure(adapter.execute(request(resource), context()));
    expect(error.code).toBe('CONFIGURATION_ERROR');
    expect(error.details).toEqual({ provider, model: 'nope' });
  });

  it('rejects resources it does not support', async () => {
    const { adapter, resource } = setup();
    const agent: ResourceDescriptor = {
      ...resource,
      kind: { type: 'agent', agent: 'pi', interface: 'rpc' },
    };
    const error = await failure(adapter.execute(request(agent), context()));
    expect(error.code).toBe('CONFIGURATION_ERROR');
  });

  it.each([
    [{ maxTokens: 0 }],
    [{ maxTokens: 1.5 }],
    [{ maxTokens: '10' }],
    [{ reasoning: 'extreme' }],
    [{ baseUrl: 'ftp://localhost' }],
    [{ baseUrl: 42 }],
    [{ baseUrl: 'not a url' }],
  ])('validates runtime.options %j', async (options) => {
    const { faux, adapter, resource } = setup();
    faux.setResponses([fauxAssistantMessage('never')]);
    const bad = { ...resource, runtime: { ...resource.runtime, options } };
    const error = await failure(adapter.execute(request(bad), context()));
    expect(error.code).toBe('CONFIGURATION_ERROR');
    expect(faux.state.callCount).toBe(0);
  });

  it('rejects a runtime-managed credential on an api-key resource', async () => {
    const { adapter, resource } = setup();
    const bad: ResourceDescriptor = {
      ...resource,
      auth: { mode: 'api-key', credential: { source: 'runtime-managed', description: 'x' } },
    };
    const error = await failure(adapter.execute(request(bad), context()));
    expect(error.code).toBe('CONFIGURATION_ERROR');
  });
});

describe('PiExecutionAdapter.probe', () => {
  const signal = new AbortController().signal;

  it('is available and authenticated for a catalog model with its credential present', async () => {
    const { faux, adapter, resource } = setup();
    const state = await adapter.probe(resource, signal);
    expect(state).toMatchObject({ availability: 'available', auth: 'authenticated' });
    expect(state.observedAt).toBe('2023-11-14T22:13:20.000Z');
    expect(faux.state.callCount).toBe(0);
  });

  it('is unauthenticated when the credential is absent', async () => {
    const { adapter, resource } = setup({ env: {} });
    expect(await adapter.probe(resource, signal)).toMatchObject({
      availability: 'available',
      auth: 'unauthenticated',
    });
  });

  it('reports not-required for mode none', async () => {
    const { adapter, provider } = setup({ env: {} });
    const resource = piModelResource({ id: 'k', provider, model: 'faux-1' });
    expect(await adapter.probe(resource, signal)).toMatchObject({
      availability: 'available',
      auth: 'not-required',
    });
  });

  it('is unavailable for unknown models, non-allowlisted providers and subscription auth', async () => {
    const { adapter, resource, provider } = setup();
    const unknown = piModelResource({ id: 'u', provider, model: 'nope', apiKeyEnv: KEY_ENV });
    const state = await adapter.probe(unknown, signal);
    expect(state.availability).toBe('unavailable');
    expect(state.detail).toContain('nope');

    const blocked = piModelResource({ id: 'b', provider: 'togetherai', model: 'm' });
    expect((await adapter.probe(blocked, signal)).availability).toBe('unavailable');

    const subscription: ResourceDescriptor = {
      ...resource,
      id: resourceId('s'),
      auth: {
        mode: 'subscription',
        credential: { source: 'runtime-managed', description: 'login' },
      },
    };
    const sub = await adapter.probe(subscription, signal);
    expect(sub.availability).toBe('unavailable');
    expect(sub.detail).toContain('subscription auth');
  });

  it('treats a baseUrl resource as available without consulting the catalog', async () => {
    const getModel = vi.fn();
    const adapter = new PiExecutionAdapter({
      models: { getModel, completeSimple: vi.fn() },
      env: {},
    });
    const resource = piModelResource({
      id: 'loc',
      provider: 'ollama',
      model: 'llama',
      baseUrl: 'http://localhost:11434/v1',
    });
    expect(await adapter.probe(resource, signal)).toMatchObject({
      availability: 'available',
      auth: 'not-required',
    });
    expect(getModel).not.toHaveBeenCalled();
  });

  it('finds real catalog models in the default allowlisted collection (offline)', async () => {
    const adapter = new PiExecutionAdapter({ env: { ANTHROPIC_API_KEY: 'x' } });
    const resource = piModelResource({
      id: 'claude',
      provider: 'anthropic',
      model: 'claude-sonnet-4-5',
      apiKeyEnv: 'ANTHROPIC_API_KEY',
    });
    const state = await adapter.probe(resource, signal);
    expect(state).toMatchObject({ availability: 'available', auth: 'authenticated' });
    const missing = piModelResource({ id: 'nope', provider: 'anthropic', model: 'no-such-model' });
    expect((await adapter.probe(missing, signal)).availability).toBe('unavailable');
  });
});

describe('PiExecutionAdapter keystore credentials', () => {
  const signal = new AbortController().signal;
  const NAME = 'DEEPSEEK_API_KEY';
  const KEYSTORE_SECRET = 'sk-keystore-secret-value';

  function keystoreResource(base: ResourceDescriptor): ResourceDescriptor {
    return { ...base, auth: { mode: 'api-key', credential: { source: 'keystore', name: NAME } } };
  }

  function capturingLogger(lines: string[]): Logger {
    const record = (message: string, fields?: unknown): void => {
      lines.push(JSON.stringify({ message, fields }));
    };
    const logger: Logger = {
      debug: record,
      info: record,
      warn: record,
      error: record,
      child: () => logger,
    };
    return logger;
  }

  it('resolves the key through the resolver by name and sends it to pi-ai', async () => {
    const seenNames: string[] = [];
    const { faux, adapter, resource } = setup({
      env: {},
      resolveSecret: (name) => {
        seenNames.push(name);
        return KEYSTORE_SECRET;
      },
    });
    let seen: unknown;
    faux.setResponses([
      (_ctx, opts) => {
        seen = opts;
        return fauxAssistantMessage('ok');
      },
    ]);

    const result = await adapter.execute(request(keystoreResource(resource)), context());

    expect(result.text).toBe('ok');
    expect(seen).toMatchObject({ apiKey: KEYSTORE_SECRET });
    expect(new Set(seenNames)).toEqual(new Set([NAME]));
  });

  it('does not satisfy a keystore reference from the environment', async () => {
    const { faux, adapter, resource } = setup({
      env: { [NAME]: SECRET },
      resolveSecret: () => undefined,
    });
    faux.setResponses([fauxAssistantMessage('never')]);

    const error = await failure(adapter.execute(request(keystoreResource(resource)), context()));

    expect(error.code).toBe('AUTH_REQUIRED');
    expect(faux.state.callCount).toBe(0);
    expect(await adapter.probe(keystoreResource(resource), signal)).toMatchObject({
      auth: 'unauthenticated',
    });
  });

  it.each([
    ['no resolver', undefined],
    ['an unknown name', () => undefined],
    ['an empty value', () => ''],
  ])('is AUTH_REQUIRED without leaking anything for %s', async (_label, resolveSecret) => {
    const { faux, adapter, resource } = setup({
      env: { [NAME]: SECRET, [KEY_ENV]: SECRET },
      ...(resolveSecret === undefined ? {} : { resolveSecret }),
    });
    faux.setResponses([fauxAssistantMessage('never')]);

    const error = await failure(adapter.execute(request(keystoreResource(resource)), context()));

    expect(error.code).toBe('AUTH_REQUIRED');
    expect(error.message).toBe(`Credential ${NAME} is not stored in the Nexar key store`);
    expect(error.details).toEqual({ keystore: NAME });
    const serialized = JSON.stringify({ message: error.message, details: error.details });
    expect(serialized).not.toContain(SECRET);
    expect(serialized.toLowerCase()).not.toContain('environment');
    expect(faux.state.callCount).toBe(0);
  });

  it('keeps env references working when a resolver is present', async () => {
    const resolveSecret = vi.fn<SecretResolver>(() => KEYSTORE_SECRET);
    const { faux, adapter, resource } = setup({ resolveSecret });
    let seen: unknown;
    faux.setResponses([
      (_ctx, opts) => {
        seen = opts;
        return fauxAssistantMessage('ok');
      },
    ]);

    await adapter.execute(request(resource), context());

    expect(seen).toMatchObject({ apiKey: SECRET });
    expect(resolveSecret).not.toHaveBeenCalled();
  });

  it('probes authenticated only when the resolver holds the key', async () => {
    const stored = setup({ env: {}, resolveSecret: () => KEYSTORE_SECRET });
    expect(await stored.adapter.probe(keystoreResource(stored.resource), signal)).toMatchObject({
      availability: 'available',
      auth: 'authenticated',
    });
    const missing = setup({ env: {}, resolveSecret: () => undefined });
    expect(await missing.adapter.probe(keystoreResource(missing.resource), signal)).toMatchObject({
      availability: 'available',
      auth: 'unauthenticated',
    });
    const none = setup({ env: {} });
    expect(await none.adapter.probe(keystoreResource(none.resource), signal)).toMatchObject({
      availability: 'available',
      auth: 'unauthenticated',
    });
  });

  it('never exposes the key in errors, details or logs', async () => {
    const lines: string[] = [];
    const { faux, adapter, resource } = setup({ env: {}, resolveSecret: () => KEYSTORE_SECRET });
    faux.setResponses([
      fauxAssistantMessage('', {
        stopReason: 'error',
        errorMessage: `boom ${KEYSTORE_SECRET}`,
      }),
    ]);

    const error = await failure(
      adapter.execute(
        request(keystoreResource(resource)),
        context({ logger: capturingLogger(lines) }),
      ),
    );

    const serialized = JSON.stringify({
      code: error.code,
      message: error.message,
      details: error.details,
      lines,
    });
    expect(serialized).not.toContain(KEYSTORE_SECRET);
  });
});
