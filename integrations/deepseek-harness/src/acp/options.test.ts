import { describe, expect, it } from 'vitest';
import { parseAcpOptions } from './options.js';

describe('parseAcpOptions', () => {
  it('defaults to ask, a 10 minute ttl and the DeepSeek API host', () => {
    expect(parseAcpOptions(undefined)).toEqual({
      permissions: { mode: 'ask', allowTools: [], ttlMs: 600_000 },
      allowHosts: ['api.deepseek.com'],
    });
  });

  it('accepts a full valid configuration', () => {
    expect(
      parseAcpOptions({
        permissions: { mode: 'allow-listed', allowTools: ['read_file'], ttlMs: 1000 },
        allowHosts: ['example.test'],
      }),
    ).toEqual({
      permissions: { mode: 'allow-listed', allowTools: ['read_file'], ttlMs: 1000 },
      allowHosts: ['example.test'],
    });
  });

  it.each([
    ['not an object', 'ask'],
    ['unknown top-level key', { surprise: true }],
    ['unknown permissions key', { permissions: { always: true } }],
    ['bad mode', { permissions: { mode: 'yolo' } }],
    ['allowTools without allow-listed', { permissions: { allowTools: ['x'] } }],
    ['allowTools with empty entry', { permissions: { mode: 'allow-listed', allowTools: [''] } }],
    ['non-integer ttl', { permissions: { ttlMs: 1.5 } }],
    ['zero ttl', { permissions: { ttlMs: 0 } }],
    ['bad allowHosts', { allowHosts: 'api.deepseek.com' }],
  ])('rejects %s with CONFIGURATION_ERROR', (_name, value) => {
    expect(() => parseAcpOptions(value)).toThrowError(
      expect.objectContaining({ code: 'CONFIGURATION_ERROR' }) as Error,
    );
  });
});
