import { describe, expect, it } from 'vitest';
import {
  KNOWN_CAPABILITIES,
  NexarError,
  adapterId,
  taskId,
  type ExecutionContext,
  type ExecutionEvent,
  type ExecutionRequest,
  type Logger,
} from '@nexar/contracts';
import { ECHO_ADAPTER_ID, EchoExecutionAdapter, echoResource } from './index.js';

const logger: Logger = {
  debug: () => undefined,
  info: () => undefined,
  warn: () => undefined,
  error: () => undefined,
  child: () => logger,
};

function request(prompt: string): ExecutionRequest {
  return {
    resource: echoResource(),
    task: {
      id: taskId('t1'),
      kind: 'general',
      input: { prompt },
      requirements: { capabilities: [] },
      origin: { source: 'test' },
      createdAt: '2026-01-01T00:00:00.000Z',
    },
  };
}

function context(signal = new AbortController().signal, events: ExecutionEvent[] = []) {
  const ctx: ExecutionContext = { signal, logger, onEvent: (e) => events.push(e) };
  return ctx;
}

describe('echoResource', () => {
  it('describes a local free model with all known capabilities', () => {
    const r = echoResource();
    expect(r.id).toBe('local-echo');
    expect(r.capabilities).toEqual([...KNOWN_CAPABILITIES]);
    expect(r.runtime.adapter).toBe(ECHO_ADAPTER_ID);
    expect(r.dataLocality).toBe('local');
  });

  it('applies overrides', () => {
    expect(echoResource({ displayName: 'X' }).displayName).toBe('X');
  });
});

describe('EchoExecutionAdapter', () => {
  it('supports only echo-bound resources', () => {
    const adapter = new EchoExecutionAdapter();
    expect(adapter.supports(echoResource())).toBe(true);
    const other = echoResource({
      runtime: { adapter: adapterId('other'), locality: 'local' },
    });
    expect(adapter.supports(other)).toBe(false);
  });

  it('probes as available without auth', async () => {
    const state = await new EchoExecutionAdapter().probe();
    expect(state).toMatchObject({ availability: 'available', auth: 'not-required' });
  });

  it('echoes the prompt, streams events and reports usage', async () => {
    const events: ExecutionEvent[] = [];
    const result = await new EchoExecutionAdapter().execute(
      request('hello world'),
      context(undefined, events),
    );
    expect(result.text).toBe('[echo:local-echo] hello world');
    expect(events.map((e) => e.type)).toEqual(['status', 'text-delta']);
    expect(result.usage.inputTokens).toEqual({
      status: 'estimated',
      value: 3,
      basis: 'chars/4 heuristic',
    });
    expect(result.usage.outputTokens).toMatchObject({ status: 'estimated', value: 8 });
    expect(result.usage.costUsd).toEqual({ status: 'measured', value: 0 });
    expect(result.usage.turns).toEqual({ status: 'measured', value: 1 });
    expect(result.resolved).toEqual({ provider: 'nexar', model: 'echo' });
    expect(result.retries).toBe(0);
  });

  it('injects failures', async () => {
    const adapter = new EchoExecutionAdapter({ failWith: 'PROVIDER_ERROR' });
    await expect(adapter.execute(request('x'), context())).rejects.toMatchObject({
      code: 'PROVIDER_ERROR',
    });
  });

  it('rejects with EXECUTION_CANCELLED when aborted during the delay', async () => {
    const controller = new AbortController();
    const pending = new EchoExecutionAdapter({ delayMs: 10_000 }).execute(
      request('x'),
      context(controller.signal),
    );
    controller.abort();
    const error = await pending.catch((e: unknown) => e);
    expect(error).toBeInstanceOf(NexarError);
    expect(error).toMatchObject({ code: 'EXECUTION_CANCELLED' });
  });

  it('rejects immediately when already aborted', async () => {
    await expect(
      new EchoExecutionAdapter().execute(request('x'), context(AbortSignal.abort())),
    ).rejects.toMatchObject({ code: 'EXECUTION_CANCELLED' });
  });
});
