import { NexarError, isChatGptPlanCredential, taskId } from '@nexar/contracts';
import type {
  ConnectionCredentialResolver,
  ExecutionContext,
  ExecutionRequest,
  Logger,
  ModelTurnPortRequest,
  ResourceDescriptor,
} from '@nexar/contracts';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { startFakeResponsesServer, type FakeResponsesServer } from './fake-responses-server.js';
import {
  PiExecutionAdapter,
  PiModelTurnPort,
  chatGptPlanModelResource,
  piModelResource,
} from './index.js';

const TOKEN = 'plan-token-sentinel-1';
const FRESH = 'plan-token-sentinel-2';
const BODY_SENTINEL = 'response-body-sentinel';
const OPENAI = 'https://api.openai.com/v1';

let server: FakeResponsesServer;

beforeAll(async () => {
  server = await startFakeResponsesServer();
});
afterAll(async () => {
  await server.close();
});
beforeEach(() => {
  server.requests.length = 0;
  server.replies = [];
});

/** Plan calls go to the fake server; pi-ai still sees the real base URL (so its plan-token rules apply). */
const toFake: typeof fetch = (input, init) => {
  const target = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
  if (!target.startsWith(`${OPENAI}/`)) return Promise.reject(new Error('unexpected host'));
  return fetch(`${server.url}/v1/${target.slice(OPENAI.length + 1)}`, init);
};

function resolver(): { resolve: ConnectionCredentialResolver; calls: { refresh: boolean }[] } {
  const calls: { refresh: boolean }[] = [];
  return {
    calls,
    resolve: (_descriptor, _signal, options) => {
      calls.push({ refresh: options?.refresh === true });
      return Promise.resolve(options?.refresh === true ? FRESH : TOKEN);
    },
  };
}

const logger: Logger = {
  debug: () => undefined,
  info: () => undefined,
  warn: () => undefined,
  error: () => undefined,
  child: () => logger,
};

const resource = chatGptPlanModelResource('gpt-5.2');

function execution(descriptor: ResourceDescriptor = resource): ExecutionRequest {
  return {
    resource: descriptor,
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

const context = (): ExecutionContext => ({ signal: new AbortController().signal, logger });

async function failure(promise: Promise<unknown>): Promise<NexarError> {
  try {
    await promise;
  } catch (e) {
    if (e instanceof NexarError) return e;
    throw e;
  }
  throw new Error('expected a NexarError');
}

function adapterWith(seam = resolver()) {
  return {
    seam,
    adapter: new PiExecutionAdapter({ resolveCredential: seam.resolve, fetch: toFake }),
  };
}

function bearer(index: number): string | undefined {
  return server.requests[index]?.headers['authorization'];
}

describe('chatGptPlanModelResource', () => {
  it('describes a plan-billed model-turn resource with the connection credential', () => {
    expect(resource).toMatchObject({
      id: 'chatgpt-plan:gpt-5.2',
      kind: { type: 'model', provider: 'openai', model: 'gpt-5.2', access: 'subscription' },
      runtime: { adapter: 'pi' },
      auth: { mode: 'subscription', credential: { source: 'connection', name: 'chatgpt-plan' } },
      cost: { model: 'subscription' },
      metadata: {
        connection: {
          provider: 'openai',
          method: 'subscription',
          authClass: 'official-account',
          support: 'official',
        },
      },
    });
    expect(resource.capabilities).toContain('model-turn');
    expect(
      resource.auth.mode === 'subscription' && isChatGptPlanCredential(resource.auth.credential),
    ).toBe(true);
  });
});

describe('PiExecutionAdapter with the ChatGPT plan', () => {
  it('passes the connection token as the API key and sends only fields the route accepts', async () => {
    const { adapter, seam } = adapterWith();
    server.replies = [{ kind: 'text', text: 'hello from the plan' }];
    const result = await adapter.execute(execution(), context());
    expect(result.text).toBe('hello from the plan');
    expect(seam.calls).toEqual([{ refresh: false }]);
    expect(bearer(0)).toBe(`Bearer ${TOKEN}`);
    const body = server.requests[0]?.body ?? {};
    expect(body['model']).toBe('gpt-5.2');
    expect(body['store']).toBe(false);
    expect(body['stream']).toBe(true);
    for (const rejected of [
      'max_output_tokens',
      'temperature',
      'prompt_cache_retention',
      'prompt_cache_options',
    ]) {
      expect(body).not.toHaveProperty(rejected);
    }
    // Measured counts come from the provider's usage; no cash figure is reported for plan usage.
    expect(result.usage.inputTokens.status).toBe('measured');
    expect(JSON.stringify(result)).not.toContain(TOKEN);
  });

  it('does not send the resource maxTokens option on the plan route', async () => {
    const { adapter } = adapterWith();
    const withMax: ResourceDescriptor = {
      ...resource,
      runtime: { ...resource.runtime, options: { maxTokens: 64 } },
    };
    await adapter.execute(execution(withMax), context());
    expect(server.requests[0]?.body).not.toHaveProperty('max_output_tokens');
  });

  it('refreshes once after a 401 and retries with the new token', async () => {
    const { adapter, seam } = adapterWith();
    server.replies = [
      { kind: 'error', status: 401, code: 'subscription_sharing_invalid_user' },
      { kind: 'text', text: 'second try' },
    ];
    expect((await adapter.execute(execution(), context())).text).toBe('second try');
    expect(seam.calls).toEqual([{ refresh: false }, { refresh: true }]);
    expect([bearer(0), bearer(1)]).toEqual([`Bearer ${TOKEN}`, `Bearer ${FRESH}`]);
  });

  it('turns a second 401 into AUTH_REQUIRED without a third attempt', async () => {
    const { adapter, seam } = adapterWith();
    server.replies = [
      { kind: 'error', status: 401, code: 'subscription_sharing_invalid_user' },
      { kind: 'error', status: 401, code: 'subscription_sharing_invalid_user' },
    ];
    const error = await failure(adapter.execute(execution(), context()));
    expect(error.code).toBe('AUTH_REQUIRED');
    expect(seam.calls).toHaveLength(2);
    expect(server.requests).toHaveLength(2);
  });

  it.each([
    [429, 'subscription_sharing_usage_limit_exceeded', 'QUOTA_EXHAUSTED', 'usage-limit-exceeded'],
    [403, 'subscription_sharing_user_not_eligible', 'AUTH_REQUIRED', 'plan-not-eligible'],
    [
      400,
      'subscription_sharing_unsupported_capability',
      'PROVIDER_ERROR',
      'unsupported-capability',
    ],
    [503, 'subscription_sharing_usage_unavailable', 'PROVIDER_ERROR', 'usage-unavailable'],
    [403, 'subscription_sharing_route_not_supported', 'PROVIDER_ERROR', 'route-not-supported'],
    [403, 'chatpass_v2_scope_not_authorized', 'PROVIDER_ERROR', 'route-not-supported'],
  ] as const)('maps %i %s to %s without echoing the body', async (status, code, nexar, reason) => {
    const { adapter, seam } = adapterWith();
    // The SDK retries 429/5xx itself (bounded); give it enough failures to finish.
    server.replies = Array.from({ length: 4 }, () => ({
      kind: 'error' as const,
      status,
      code,
      message: BODY_SENTINEL,
    }));
    const error = await failure(adapter.execute(execution(), context()));
    expect(error.code).toBe(nexar);
    expect(error.details?.['reason']).toBe(reason);
    const text = JSON.stringify(error.toJSON());
    expect(text).not.toContain(BODY_SENTINEL);
    expect(text).not.toContain(TOKEN);
    // Only a 401 asks for a refreshed token.
    expect(seam.calls.every((call) => !call.refresh)).toBe(true);
  });

  it('points a usage limit at ChatGPT settings with a fixed message', async () => {
    const { adapter } = adapterWith();
    server.replies = Array.from({ length: 4 }, () => ({
      kind: 'error' as const,
      status: 429,
      code: 'subscription_sharing_usage_limit_exceeded',
    }));
    const error = await failure(adapter.execute(execution(), context()));
    expect(error.message).toBe(
      'The ChatGPT plan usage limit was reached. Check your usage in ChatGPT settings.',
    );
    expect(error.retryable).toBe(false);
  });

  it('refuses a connection resource when the host offers no seam', async () => {
    const adapter = new PiExecutionAdapter({ fetch: toFake });
    const error = await failure(adapter.execute(execution(), context()));
    expect(error.code).toBe('POLICY_REJECTED');
    expect(server.requests).toHaveLength(0);
  });

  it('is AUTH_REQUIRED when the connection yields no token, and never calls the server', async () => {
    const adapter = new PiExecutionAdapter({
      resolveCredential: () => Promise.resolve(undefined),
      fetch: toFake,
    });
    expect((await failure(adapter.execute(execution(), context()))).code).toBe('AUTH_REQUIRED');
    expect(server.requests).toHaveLength(0);
  });

  it('keeps the seam out of the API-key path', async () => {
    const resolve = vi.fn<ConnectionCredentialResolver>(() => Promise.resolve(TOKEN));
    const adapter = new PiExecutionAdapter({
      resolveCredential: resolve,
      env: {},
      resolveSecret: () => undefined,
    });
    const apiKey = piModelResource({
      id: 'openai-key',
      provider: 'openai',
      model: 'gpt-5.2',
      apiKeyEnv: 'OPENAI_API_KEY',
    });
    const error = await failure(adapter.execute(execution(apiKey), context()));
    expect(error.code).toBe('AUTH_REQUIRED');
    expect(resolve).not.toHaveBeenCalled();
  });

  it('probes without calling the model or the token seam', async () => {
    const resolve = vi.fn<ConnectionCredentialResolver>(() => Promise.resolve(TOKEN));
    const signal = new AbortController().signal;
    const connected = new PiExecutionAdapter({ resolveCredential: resolve, fetch: toFake });
    expect(await connected.probe(resource, signal)).toMatchObject({
      availability: 'available',
      auth: 'authenticated',
    });
    // Without the host's seam the connection cannot be used at all.
    expect(await new PiExecutionAdapter().probe(resource, signal)).toMatchObject({
      availability: 'unavailable',
    });
    expect(resolve).not.toHaveBeenCalled();
    expect(server.requests).toHaveLength(0);
  });

  it('reports the resource unauthenticated after the plan was refused as not eligible', async () => {
    const { adapter } = adapterWith();
    server.replies = [
      { kind: 'error', status: 403, code: 'subscription_sharing_user_not_eligible' },
    ];
    await failure(adapter.execute(execution(), context()));
    expect(await adapter.probe(resource, new AbortController().signal)).toMatchObject({
      auth: 'unauthenticated',
      detail: 'plan-not-eligible',
    });
  });
});

describe('PiModelTurnPort with the ChatGPT plan', () => {
  const turn = (patch: Partial<ModelTurnPortRequest> = {}): ModelTurnPortRequest => ({
    descriptor: resource,
    messages: [
      { role: 'system', content: 'sys' },
      { role: 'user', content: 'hi' },
    ],
    signal: new AbortController().signal,
    ...patch,
  });

  it('sends tools, no sampling fields and the connection token; returns tool calls', async () => {
    const seam = resolver();
    const port = new PiModelTurnPort({ resolveCredential: seam.resolve, fetch: toFake });
    server.replies = [{ kind: 'tool-call', name: 'read_file', arguments: '{"path":"a.txt"}' }];
    const result = await port.turn(
      turn({
        tools: [
          {
            name: 'read_file',
            description: 'Reads',
            parameters: { type: 'object', properties: { path: { type: 'string' } } },
          },
        ],
        settings: { maxOutputTokens: 100, temperature: 0.2 },
      }),
    );
    expect(result.finishReason).toBe('tool-calls');
    expect(result.toolCalls).toEqual([
      {
        id: expect.stringContaining('call_1') as string,
        name: 'read_file',
        arguments: { path: 'a.txt' },
      },
    ]);
    expect(bearer(0)).toBe(`Bearer ${TOKEN}`);
    const body = server.requests[0]?.body ?? {};
    expect(body['tools']).toHaveLength(1);
    expect(body['store']).toBe(false);
    expect(body).not.toHaveProperty('max_output_tokens');
    expect(body).not.toHaveProperty('temperature');
    expect(JSON.stringify(result)).not.toContain(TOKEN);
  });

  it('retries a 401 once and maps unsupported capability to a provider error', async () => {
    const seam = resolver();
    const port = new PiModelTurnPort({ resolveCredential: seam.resolve, fetch: toFake });
    server.replies = [
      { kind: 'error', status: 401, code: 'subscription_sharing_invalid_user' },
      {
        kind: 'error',
        status: 400,
        code: 'subscription_sharing_unsupported_capability',
        message: BODY_SENTINEL,
      },
    ];
    const error = await failure(port.turn(turn()));
    expect(seam.calls).toEqual([{ refresh: false }, { refresh: true }]);
    expect(error.code).toBe('PROVIDER_ERROR');
    expect(error.details?.['reason']).toBe('unsupported-capability');
    expect(JSON.stringify(error.toJSON())).not.toContain(BODY_SENTINEL);
  });

  it('refuses the resource without a seam', async () => {
    const error = await failure(new PiModelTurnPort({ fetch: toFake }).turn(turn()));
    expect(error.code).toBe('POLICY_REJECTED');
  });
});
