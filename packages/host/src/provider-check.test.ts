import { describe, expect, it, vi } from 'vitest';
import { checkProviderApiKey } from '@nexar/integration-pi';
import type * as PiIntegration from '@nexar/integration-pi';
import { checkProviderCredential } from './provider-check.js';

vi.mock('@nexar/integration-pi', async (original) => ({
  ...(await original<typeof PiIntegration>()),
  checkProviderApiKey: vi.fn(() => Promise.resolve({ status: 'valid' })),
}));

describe('call-time Desktop provider resolution', () => {
  it('resolves only the chosen fixed name without environment fallback', async () => {
    const resolveSecret = vi.fn(() => 'fixture-value');
    expect(await checkProviderCredential('deepseek', { resolveSecret })).toEqual({
      status: 'valid',
    });
    expect(resolveSecret).toHaveBeenCalledExactlyOnceWith('DEEPSEEK_API_KEY');
    expect(checkProviderApiKey).toHaveBeenLastCalledWith('deepseek', 'fixture-value', {});
  });
  it('does not resolve unknown names or a missing resolver', async () => {
    const resolveSecret = vi.fn(() => 'fixture-value');
    expect(await checkProviderCredential('__proto__', { resolveSecret })).toEqual({
      status: 'unchecked',
    });
    expect(await checkProviderCredential('openai')).toEqual({ status: 'unchecked' });
    expect(resolveSecret).not.toHaveBeenCalled();
  });
  it('contains credential backend errors', async () => {
    expect(
      await checkProviderCredential('openai', {
        resolveSecret: () => {
          throw new Error('private-backend-error');
        },
      }),
    ).toEqual({ status: 'unavailable' });
  });
});
