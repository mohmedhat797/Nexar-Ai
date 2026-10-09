import { describe, expect, it } from 'vitest';
import { deepseekHarnessResource } from './index.js';

describe('deepseekHarnessResource connection', () => {
  it('declares the official DeepSeek API connection', () => {
    expect(deepseekHarnessResource().metadata).toEqual({
      connection: {
        id: 'deepseek.api',
        provider: 'deepseek',
        method: 'api',
        authClass: 'official-api',
        support: 'official',
      },
    });
  });
});
