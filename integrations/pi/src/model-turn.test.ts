import {
  createModels,
  fauxAssistantMessage,
  fauxProvider,
  fauxText,
  fauxThinking,
  fauxToolCall,
} from '@earendil-works/pi-ai';
import { NexarError } from '@nexar/contracts';
import type { ModelTurnMessage, ModelTurnPortRequest } from '@nexar/contracts';
import { describe, expect, it } from 'vitest';
import { PiModelTurnPort, piModelResource } from './index.js';
import type { PiAssistantMessageLike, PiModelsLike } from './index.js';

const KEY_ENV = 'TEST_PI_TURN_KEY';
const SECRET = 'sk-turn-secret-value';

function setup() {
  const faux = fauxProvider({
    models: [
      { id: 'faux-1', reasoning: true, cost: { input: 1, output: 2, cacheRead: 0, cacheWrite: 0 } },
    ],
  });
  const models = createModels();
  models.setProvider(faux.provider);
  const provider = faux.getModel().provider;
  const port = new PiModelTurnPort({
    models,
    env: { [KEY_ENV]: SECRET },
    allowedProviders: [provider],
    now: () => 1_700_000_000_000,
  });
  const descriptor = piModelResource({
    id: 'pi-faux',
    provider,
    model: 'faux-1',
    apiKeyEnv: KEY_ENV,
  });
  const request = (
    messages: readonly ModelTurnMessage[],
    patch: Partial<ModelTurnPortRequest> = {},
  ): ModelTurnPortRequest => ({
    descriptor,
    messages,
    signal: new AbortController().signal,
    ...patch,
  });
  return { faux, port, descriptor, request, provider };
}

const user = (content: string): ModelTurnMessage => ({ role: 'user', content });

describe('PiModelTurnPort', () => {
  it('runs a text turn', async () => {
    const { faux, port, request } = setup();
    faux.setResponses([fauxAssistantMessage('hello there')]);
    const result = await port.turn(request([{ role: 'system', content: 'be brief' }, user('hi')]));
    expect(result.text).toBe('hello there');
    expect(result.toolCalls).toEqual([]);
    expect(result.finishReason).toBe('stop');
    expect(result.usage.inputTokens.status).toBe('measured');
    expect(result.usage.outputTokens.status).toBe('measured');
    expect(result.usage.costUsd?.status).toBe('unavailable');
    expect(result.usage.cacheReadTokens?.status).toBe('unavailable');
  });

  it('sends system messages as the system prompt and tools in the context', async () => {
    const { faux, port, request } = setup();
    let seen: { system?: string; tools: string[]; roles: string[] } | undefined;
    faux.setResponses([
      (context) => {
        // pi-ai hands providers a transcript: the system prompt and tools ride on a system message.
        const messages = (
          context as unknown as {
            messages: { role: string; content?: string; toolsAdded?: { name: string }[] }[];
          }
        ).messages;
        const head = messages.find((m) => m.role === 'system');
        seen = {
          ...(head?.content === undefined ? {} : { system: head.content }),
          tools: (head?.toolsAdded ?? []).map((t) => t.name),
          roles: messages.filter((m) => m.role !== 'system').map((m) => m.role),
        };
        return fauxAssistantMessage('ok');
      },
    ]);
    await port.turn(
      request([{ role: 'system', content: 'sys' }, user('hi')], {
        tools: [
          {
            name: 'read_file',
            description: 'Reads',
            parameters: { type: 'object', properties: {} },
          },
        ],
      }),
    );
    expect(seen).toEqual({ system: 'sys', tools: ['read_file'], roles: ['user'] });
  });

  it('returns tool calls without executing them', async () => {
    const { faux, port, request } = setup();
    faux.setResponses([
      fauxAssistantMessage(
        [fauxText('calling'), fauxToolCall('read_file', { path: 'a.txt' }, { id: 'call-1' })],
        { stopReason: 'toolUse' },
      ),
    ]);
    const result = await port.turn(
      request([user('read it')], {
        tools: [{ name: 'read_file', parameters: { type: 'object' } }],
      }),
    );
    expect(result.finishReason).toBe('tool-calls');
    expect(result.text).toBe('calling');
    expect(result.toolCalls).toEqual([
      { id: 'call-1', name: 'read_file', arguments: { path: 'a.txt' } },
    ]);
  });

  it('accepts a tool result follow-up and maps it to a tool-result message', async () => {
    const { faux, port, request } = setup();
    let roles: string[] = [];
    let toolName: string | undefined;
    faux.setResponses([
      (context) => {
        const messages = (context as unknown as { messages: { role: string; toolName?: string }[] })
          .messages;
        roles = messages.map((m) => m.role);
        toolName = messages.find((m) => m.role === 'toolResult')?.toolName;
        return fauxAssistantMessage('done');
      },
    ]);
    const result = await port.turn(
      request([
        user('read it'),
        {
          role: 'assistant',
          toolCalls: [{ id: 'call-1', name: 'read_file', arguments: { path: 'a.txt' } }],
        },
        { role: 'tool', toolCallId: 'call-1', content: 'file body' },
      ]),
    );
    expect(roles).toEqual(['user', 'assistant', 'toolResult']);
    expect(toolName).toBe('read_file');
    expect(result.text).toBe('done');
  });

  it('round-trips provider-private signatures through extras', async () => {
    const { faux, port, request } = setup();
    const thinking = { ...fauxThinking('pondering'), thinkingSignature: 'sig-think' };
    const text = { ...fauxText('answer'), textSignature: 'sig-text' };
    const call = { ...fauxToolCall('t', { x: 1 }, { id: 'c1' }), thoughtSignature: 'sig-call' };
    faux.setResponses([fauxAssistantMessage([thinking, text, call], { stopReason: 'toolUse' })]);
    const first = await port.turn(
      request([user('go')], { tools: [{ name: 't', parameters: {} }] }),
    );
    expect(first.extras).toBeDefined();
    // Extras carry the private fields; the neutral fields stay free of them.
    expect(first.text).toBe('answer');
    expect(JSON.stringify(first.toolCalls)).not.toContain('sig-call');

    let sent: { role: string; content: Record<string, unknown>[] } | undefined;
    faux.setResponses([
      (context) => {
        const messages = (
          context as unknown as { messages: { role: string; content: Record<string, unknown>[] }[] }
        ).messages;
        sent = messages.find((m) => m.role === 'assistant');
        return fauxAssistantMessage('next');
      },
    ]);
    await port.turn(
      request([
        user('go'),
        {
          role: 'assistant',
          content: first.text ?? '',
          toolCalls: first.toolCalls,
          extras: first.extras as Record<string, unknown>,
        },
        { role: 'tool', toolCallId: 'c1', content: 'r' },
      ]),
    );
    expect(sent?.content.map((b) => b.type)).toEqual(['thinking', 'text', 'toolCall']);
    expect(sent?.content[0]).toMatchObject({
      thinking: 'pondering',
      thinkingSignature: 'sig-think',
    });
    expect(sent?.content[1]).toMatchObject({ textSignature: 'sig-text' });
    expect(sent?.content[2]).toMatchObject({ id: 'c1', thoughtSignature: 'sig-call' });
  });

  it('ignores extras that no longer match the message and malformed extras', async () => {
    const { faux, port, request } = setup();
    let sent: Record<string, unknown>[] = [];
    const capture = (context: unknown) => {
      const messages = (
        context as { messages: { role: string; content: Record<string, unknown>[] }[] }
      ).messages;
      sent = messages.find((m) => m.role === 'assistant')?.content ?? [];
      return fauxAssistantMessage('ok');
    };
    faux.setResponses([capture, capture]);
    const stale = {
      pi: {
        blocks: [
          { type: 'thinking', thinking: 'x', thinkingSignature: 's' },
          { type: 'text', text: 'old' },
        ],
      },
    };
    await port.turn(
      request([user('a'), { role: 'assistant', content: 'new', extras: stale }, user('b')]),
    );
    expect(sent.map((b) => b.type)).toEqual(['text']);
    await port.turn(
      request([
        user('a'),
        { role: 'assistant', content: 'new', extras: { pi: { blocks: [{ type: 5 }] } } },
        user('b'),
      ]),
    );
    expect(sent.map((b) => b.type)).toEqual(['text']);
  });

  it('streams text deltas when onDelta is given', async () => {
    const { faux, port, request } = setup();
    faux.setResponses([fauxAssistantMessage('streamed text')]);
    const deltas: string[] = [];
    const result = await port.turn(request([user('hi')], { onDelta: (t) => deltas.push(t) }));
    expect(deltas.join('')).toBe('streamed text');
    expect(result.text).toBe('streamed text');
  });

  it('reports usage as unavailable instead of faking zero', async () => {
    const message = (input: number, output: number): PiAssistantMessageLike => ({
      content: [{ type: 'text', text: 'x' }],
      usage: { input, output, cacheRead: 0, cacheWrite: 0, cost: { total: 0 } },
      stopReason: 'stop',
      model: 'm',
      provider: 'p',
    });
    const fake = (m: PiAssistantMessageLike): PiModelsLike => ({
      getModel: (provider, id) => ({ provider, id }),
      completeSimple: () => Promise.resolve(m),
    });
    const { descriptor, request, provider } = setup();
    for (const [m, input, output] of [
      [message(0, 0), 'unavailable', 'unavailable'],
      [message(12, 5), 'measured', 'measured'],
    ] as const) {
      const port = new PiModelTurnPort({
        models: fake(m),
        env: { [KEY_ENV]: SECRET },
        allowedProviders: [provider],
      });
      const result = await port.turn({ ...request([user('hi')]), descriptor });
      expect(result.usage.inputTokens.status).toBe(input);
      expect(result.usage.outputTokens.status).toBe(output);
    }
  });

  it('preserves measured cache tokens and distinguishes catalog cost estimates', async () => {
    const { descriptor, request, provider } = setup();
    const message: PiAssistantMessageLike = {
      content: [{ type: 'text', text: 'accounted' }],
      stopReason: 'stop',
      model: 'm',
      provider,
      usage: { input: 12, output: 5, cacheRead: 3, cacheWrite: 2, cost: { total: 0.0042 } },
    };
    const port = new PiModelTurnPort({
      models: {
        getModel: (p, id) => ({ provider: p, id }),
        completeSimple: () => Promise.resolve(message),
      },
      env: { [KEY_ENV]: SECRET },
      allowedProviders: [provider],
    });
    expect((await port.turn({ ...request([user('hi')]), descriptor })).usage).toEqual({
      inputTokens: { status: 'measured', value: 12 },
      outputTokens: { status: 'measured', value: 5 },
      cacheReadTokens: { status: 'measured', value: 3 },
      cacheWriteTokens: { status: 'measured', value: 2 },
      costUsd: { status: 'estimated', value: 0.0042, basis: 'pi-ai catalog rates' },
    });
  });

  it('maps length and error stop reasons', async () => {
    const { faux, port, request } = setup();
    faux.setResponses([fauxAssistantMessage('cut', { stopReason: 'length' })]);
    expect((await port.turn(request([user('hi')]))).finishReason).toBe('length');

    faux.setResponses([
      fauxAssistantMessage('', { stopReason: 'error', errorMessage: `429 rate limit ${SECRET}` }),
    ]);
    const error = await port.turn(request([user('hi')])).catch((e: unknown) => e as NexarError);
    expect(error).toBeInstanceOf(NexarError);
    expect((error as NexarError).code).toBe('QUOTA_EXHAUSTED');
    expect((error as NexarError).message).not.toContain(SECRET);
  });

  it('aborts through the signal', async () => {
    const { faux, port, request } = setup();
    faux.setResponses([fauxAssistantMessage('never')]);
    const controller = new AbortController();
    controller.abort();
    const error = await port
      .turn(request([user('hi')], { signal: controller.signal }))
      .catch((e: unknown) => e as NexarError);
    expect((error as NexarError).code).toBe('EXECUTION_CANCELLED');
  });

  it('requires the credential and refuses subscription auth', async () => {
    const { descriptor, request, provider } = setup();
    const noKey = new PiModelTurnPort({
      models: createModels(),
      env: {},
      allowedProviders: [provider],
    });
    const missing = await noKey
      .turn({ ...request([user('hi')]), descriptor })
      .catch((e: unknown) => e as NexarError);
    expect((missing as NexarError).code).toBe('AUTH_REQUIRED');
    expect((missing as NexarError).message).not.toContain(KEY_ENV);

    const oauth = { ...descriptor, auth: { mode: 'oauth' } } as unknown as typeof descriptor;
    const { port } = setup();
    const refused = await port
      .turn({ ...request([user('hi')]), descriptor: oauth })
      .catch((e: unknown) => e as NexarError);
    expect((refused as NexarError).code).toBe('POLICY_REJECTED');
  });
});
