import { describe, expect, it, vi } from 'vitest';
import { connectionOf, isControlCompatible } from '@nexar/contracts';
import { materializeInventory } from '@nexar/resource-registry';
import { chatGptPlanInventoryDefinition } from './chatgpt-plan-resources.js';
import type { ChatGptPlanStatus } from '../shared/chatgpt-plan.js';

const connected: ChatGptPlanStatus = {
  state: 'connected',
  planSharing: true,
  message: 'Connected. Sign out in Nexar to forget this sign-in on this computer.',
};
const catalog = (slug: string) =>
  new Response(
    JSON.stringify({
      models: [{ slug, display_name: slug, visibility: 'list', secret: 'MUST-NOT-CROSS' }],
    }),
  );

describe('ChatGPT account inventory source', () => {
  it('different selected accounts yield different route-scoped resources, without static catalog membership', async () => {
    for (const account of ['account-a-model', 'account-b-model', 'Returned.Model/2026']) {
      const source = chatGptPlanInventoryDefinition(
        {
          status: () => Promise.resolve(connected),
          accessToken: () => Promise.resolve(account),
        },
        {
          fetch: (_input, init) =>
            Promise.resolve(
              catalog(String(new Headers(init?.headers).get('authorization')).slice(7)),
            ),
        },
      );
      const result = await source.source.fetch(new AbortController().signal);
      expect(result.status).toBe('success');
      if (result.status !== 'success') throw new Error('Expected successful fixture');
      expect(result.entries[0]?.selection).toEqual({ kind: 'model', id: account });
      const first = result.entries[0]!;
      const resources = materializeInventory(
        {
          ...result,
          status: 'fresh',
          identity: source.identity,
          generation: 0,
          observedAt: '2026-10-07T00:00:00.000Z',
        },
        source.template(first),
      );
      expect(resources[0]?.kind).toMatchObject({
        type: 'model',
        provider: 'openai',
        model: account,
      });
      expect(connectionOf(resources[0]!)).toMatchObject({ authClass: 'official-account' });
      expect(isControlCompatible(resources[0]!, 'openworker')).toBe(true);
      expect(resources[0]?.limits).toBeUndefined();
      expect(JSON.stringify(resources)).not.toContain('MUST-NOT-CROSS');
    }
  });

  it.each<ChatGptPlanStatus>([
    { state: 'signed-out', message: 'Not connected.' },
    {
      state: 'signing-in',
      message: 'Waiting for you to finish signing in with ChatGPT in your browser.',
    },
    { ...connected, planSharing: false },
  ])('does not discover or invent models without connected plan sharing', async (status) => {
    const fetch = vi.fn<typeof globalThis.fetch>();
    const token = vi.fn(() => Promise.resolve('unused'));
    const source = chatGptPlanInventoryDefinition(
      { status: () => Promise.resolve(status), accessToken: token },
      { fetch },
    );
    expect(await source.source.fetch(new AbortController().signal)).toMatchObject({
      status: 'unavailable',
      reason: 'not-connected',
    });
    expect(fetch).not.toHaveBeenCalled();
    expect(token).not.toHaveBeenCalled();
  });

  it('does not list when token refresh loses plan sharing', async () => {
    let current = connected;
    const fetch = vi.fn<typeof globalThis.fetch>();
    const source = chatGptPlanInventoryDefinition(
      {
        status: () => Promise.resolve(current),
        accessToken: () => {
          current = { ...connected, planSharing: false };
          return Promise.resolve('fresh-token');
        },
      },
      { fetch },
    );
    expect(await source.source.fetch(new AbortController().signal)).toMatchObject({
      status: 'unavailable',
      reason: 'not-connected',
    });
    expect(fetch).not.toHaveBeenCalled();
  });

  it('refreshes credentials once for a catalog 401, with no inference call', async () => {
    const token = vi.fn((options?: { refresh?: boolean }) =>
      Promise.resolve(options?.refresh ? 'new-token' : 'old-token'),
    );
    const fetch = vi
      .fn<typeof globalThis.fetch>()
      .mockResolvedValueOnce(new Response('', { status: 401 }))
      .mockResolvedValueOnce(catalog('returned-model'));
    const source = chatGptPlanInventoryDefinition(
      { status: () => Promise.resolve(connected), accessToken: token },
      { fetch },
    );
    expect(await source.source.fetch(new AbortController().signal)).toMatchObject({
      status: 'success',
    });
    expect(token.mock.calls).toEqual([[], [{ refresh: true }]]);
    expect(fetch).toHaveBeenCalledTimes(2);
    expect(fetch.mock.calls.every(([url]) => url === 'https://api.openai.com/v1/models')).toBe(
      true,
    );
  });
});
