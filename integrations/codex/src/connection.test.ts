import { describe, expect, it } from 'vitest';
import { codexResource } from './index.js';

describe('codexResource connection', () => {
  it('declares the vendor-native OpenAI subscription', () => {
    expect(codexResource().metadata).toEqual({
      connection: {
        id: 'openai.subscription',
        provider: 'openai',
        method: 'subscription',
        authClass: 'vendor-native',
        support: 'official',
      },
    });
  });
});
