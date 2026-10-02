import { describe, expect, it, vi } from 'vitest';
import type { DiscoveryContext, DiscoveryCredentialSource } from '@nexar/contracts';
import { deepseekHarnessCliDiscoverySource } from './discovery.js';
import { deepseekHarnessResource } from './resource.js';

const ctx: DiscoveryContext = {
  now: new Date('2026-10-02T00:00:00.000Z'),
  signal: new AbortController().signal,
};

describe('DeepSeek Harness CLI discovery credential references', () => {
  it.each([undefined, 'env', 'keystore'] as const)(
    'uses %s without reading credentials or running the binary',
    async (credentialSource: DiscoveryCredentialSource | undefined) => {
      const env = Object.defineProperty({ PATH: '/fake-bin' }, 'DEEPSEEK_API_KEY', {
        enumerable: true,
        get: () => {
          throw new Error('Discovery must never read a credential');
        },
      });
      const stat = vi.fn(() => Promise.resolve({ isFile: () => true, mode: 0o755 }));
      const found = await deepseekHarnessCliDiscoverySource({
        env,
        platform: 'linux',
        stat,
        ...(credentialSource === undefined ? {} : { credentialSource }),
      }).discover(ctx);
      expect(stat).toHaveBeenCalledExactlyOnceWith('/fake-bin/dsh');
      expect(found).toEqual([
        deepseekHarnessResource({
          auth: {
            mode: 'api-key',
            credential: { source: credentialSource ?? 'env', name: 'DEEPSEEK_API_KEY' },
          },
        }),
      ]);
      expect(found[0]).not.toHaveProperty('state');
    },
  );

  it('does not manufacture a candidate when only a credential is present', async () => {
    const stat = vi.fn(() => Promise.reject(new Error('missing')));
    const found = await deepseekHarnessCliDiscoverySource({
      env: { PATH: '/missing', DEEPSEEK_API_KEY: 'not-used' },
      platform: 'linux',
      stat,
      credentialSource: 'keystore',
    }).discover(ctx);
    expect(found).toEqual([]);
  });
});
