import { describe, expect, it } from 'vitest';
import { claudeCodeResource } from './index.js';

describe('claudeCodeResource connection', () => {
  it('declares the vendor-native Anthropic subscription and keeps overrides', () => {
    expect(claudeCodeResource().metadata).toEqual({
      connection: {
        id: 'anthropic.subscription',
        provider: 'anthropic',
        method: 'subscription',
        authClass: 'vendor-native',
        support: 'official',
      },
    });
    expect(claudeCodeResource({ displayName: 'x' }).metadata?.['connection']).toBeDefined();
  });
});
