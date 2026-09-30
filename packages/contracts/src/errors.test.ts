import { describe, expect, it } from 'vitest';

import { NEXAR_ERROR_CODES, NexarError, isNexarError, toNexarError } from './index.js';

describe('NexarError', () => {
  it('defaults retryable per code', () => {
    const retryable = [
      'RESOURCE_UNAVAILABLE',
      'PROVIDER_ERROR',
      'EXECUTION_TIMEOUT',
      'QUOTA_EXHAUSTED',
    ];
    for (const code of NEXAR_ERROR_CODES) {
      expect(new NexarError(code, 'm').retryable).toBe(retryable.includes(code));
    }
    expect(new NexarError('AUTH_REQUIRED', 'm', { retryable: true }).retryable).toBe(true);
  });

  it('serializes without stack or cause', () => {
    const e = new NexarError('PROVIDER_ERROR', 'boom', {
      details: { a: 1 },
      cause: new Error('x'),
    });
    const json = e.toJSON();
    expect(json).toEqual({
      name: 'NexarError',
      code: 'PROVIDER_ERROR',
      message: 'boom',
      retryable: true,
      details: { a: 1 },
    });
    expect(Object.keys(json)).not.toContain('stack');
    expect(Object.keys(json)).not.toContain('cause');
  });

  it('isNexarError recognizes instances and duck-typed clones', () => {
    expect(isNexarError(new NexarError('INTERNAL_ERROR', 'm'))).toBe(true);
    const clone = Object.assign(Object.create(null) as object, {
      name: 'NexarError',
      code: 'INTERNAL_ERROR',
    });
    expect(isNexarError(clone)).toBe(true);
    expect(isNexarError(new Error('x'))).toBe(false);
    expect(isNexarError({ name: 'NexarError', code: 'NOPE' })).toBe(false);
    expect(isNexarError(null)).toBe(false);
    expect(isNexarError('NexarError')).toBe(false);
  });

  it('toNexarError wraps foreign errors preserving cause and passes Nexar errors through', () => {
    const cause = new Error('upstream');
    const wrapped = toNexarError(cause);
    expect(wrapped.code).toBe('INTERNAL_ERROR');
    expect(wrapped.message).toBe('upstream');
    expect(wrapped.cause).toBe(cause);
    expect(toNexarError('str', 'PROVIDER_ERROR').code).toBe('PROVIDER_ERROR');
    const original = new NexarError('AUTH_REQUIRED', 'm');
    expect(toNexarError(original)).toBe(original);
  });
});
