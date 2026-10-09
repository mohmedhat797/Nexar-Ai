import { describe, expect, it } from 'vitest';
import { antigravityResource } from './index.js';

describe('antigravityResource connection', () => {
  it('declares the experimental Google subscription', () => {
    expect(antigravityResource().metadata).toEqual({
      connection: {
        id: 'google.subscription',
        provider: 'google',
        method: 'subscription',
        authClass: 'vendor-native',
        support: 'experimental',
      },
    });
  });
});
