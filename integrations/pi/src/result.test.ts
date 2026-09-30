import { NexarError } from '@nexar/contracts';
import type { ExecutionEvent } from '@nexar/contracts';
import { describe, expect, it } from 'vitest';
import type { PiAssistantMessageLike } from './index.js';
import { PI_AI_VERSION, toExecutionResult } from './index.js';
import { redactSecrets, toThrownNexarError } from './result.js';

function message(overrides: Partial<PiAssistantMessageLike> = {}): PiAssistantMessageLike {
  return {
    content: [
      { type: 'text', text: 'Hello, ' },
      { type: 'thinking' },
      { type: 'text', text: 'world' },
    ],
    usage: { input: 10, output: 5, cacheRead: 3, cacheWrite: 2, cost: { total: 0.0042 } },
    stopReason: 'stop',
    model: 'm-1',
    provider: 'p-1',
    ...overrides,
  };
}

function thrown(fn: () => unknown): NexarError {
  try {
    fn();
  } catch (e) {
    expect(e).toBeInstanceOf(NexarError);
    return e as NexarError;
  }
  throw new Error('expected a throw');
}

describe('toExecutionResult', () => {
  it('joins text blocks only and maps usage to measured/estimated figures', () => {
    const result = toExecutionResult(message());
    expect(result.text).toBe('Hello, world');
    expect(result.artifacts).toEqual([]);
    expect(result.retries).toBe(0);
    expect(result.usage).toEqual({
      inputTokens: { status: 'measured', value: 10 },
      outputTokens: { status: 'measured', value: 5 },
      cacheReadTokens: { status: 'measured', value: 3 },
      cacheWriteTokens: { status: 'measured', value: 2 },
      costUsd: { status: 'estimated', value: 0.0042, basis: 'pi-ai catalog rates' },
    });
    expect(result.resolved).toEqual({
      provider: 'p-1',
      model: 'm-1',
      runtimeVersion: `@earendil-works/pi-ai@${PI_AI_VERSION}`,
    });
  });

  it('pins the documented upstream version', () => {
    expect(PI_AI_VERSION).toBe('0.99.2');
  });

  it('treats toolUse as success with the text so far', () => {
    expect(toExecutionResult(message({ stopReason: 'toolUse' })).text).toBe('Hello, world');
  });

  it('emits a status event on length and not on stop', () => {
    const events: ExecutionEvent[] = [];
    toExecutionResult(message({ stopReason: 'length' }), { onEvent: (e) => events.push(e) });
    toExecutionResult(message(), { onEvent: (e) => events.push(e) });
    expect(events).toEqual([{ type: 'status', message: 'output truncated' }]);
  });

  it('throws EXECUTION_CANCELLED for aborted', () => {
    expect(thrown(() => toExecutionResult(message({ stopReason: 'aborted' }))).code).toBe(
      'EXECUTION_CANCELLED',
    );
  });

  it.each([
    ['HTTP 401 from upstream', 'AUTH_REQUIRED'],
    ['Unauthorized', 'AUTH_REQUIRED'],
    ['Unauthorised request', 'AUTH_REQUIRED'],
    ['Invalid API key provided', 'AUTH_REQUIRED'],
    ['Provider is not configured: anthropic', 'AUTH_REQUIRED'],
    ['HTTP 429 too many requests', 'QUOTA_EXHAUSTED'],
    ['Rate limit reached', 'QUOTA_EXHAUSTED'],
    ['You exceeded your current quota', 'QUOTA_EXHAUSTED'],
    ['upstream exploded', 'PROVIDER_ERROR'],
  ])('maps error message %j to %s', (errorMessage, code) => {
    const error = thrown(() => toExecutionResult(message({ stopReason: 'error', errorMessage })));
    expect(error.code).toBe(code);
    expect(error.message).toBe(errorMessage);
  });

  it('truncates long error messages to 300 chars (plus an ellipsis) and supplies a default', () => {
    const long = thrown(() =>
      toExecutionResult(message({ stopReason: 'error', errorMessage: 'e'.repeat(1000) })),
    );
    expect(long.message).toHaveLength(301);
    const none = thrown(() => toExecutionResult(message({ stopReason: 'error' })));
    expect(none.code).toBe('PROVIDER_ERROR');
    expect(none.message.length).toBeGreaterThan(0);
  });

  it('redacts supplied secrets from error messages', () => {
    const error = thrown(() =>
      toExecutionResult(message({ stopReason: 'error', errorMessage: 'bad key sk-abc123' }), {
        secrets: ['sk-abc123'],
      }),
    );
    expect(error.message).toBe('bad key [redacted]');
  });
});

describe('toThrownNexarError', () => {
  const live = new AbortController().signal;

  it('passes NexarErrors through and wraps everything else as PROVIDER_ERROR', () => {
    const original = new NexarError('QUOTA_EXHAUSTED', 'x');
    expect(toThrownNexarError(original, live)).toBe(original);
    const wrapped = toThrownNexarError(new Error('kaput'), live);
    expect(wrapped.code).toBe('PROVIDER_ERROR');
    expect(wrapped.cause).toBeInstanceOf(Error);
    expect(toThrownNexarError('just a string', live).message).toBe('just a string');
  });

  it('maps abort-caused failures to EXECUTION_CANCELLED', () => {
    const controller = new AbortController();
    controller.abort();
    expect(toThrownNexarError(new Error('whatever'), controller.signal).code).toBe(
      'EXECUTION_CANCELLED',
    );
    const abortError = Object.assign(new Error('aborted'), { name: 'AbortError' });
    expect(toThrownNexarError(abortError, live).code).toBe('EXECUTION_CANCELLED');
  });
});

describe('redactSecrets', () => {
  it('ignores empty secrets and replaces every occurrence', () => {
    expect(redactSecrets('a s b s', ['s', ''])).toBe('a [redacted] b [redacted]');
  });
});
