import { describe, expect, it } from 'vitest';
import type { ProviderRow, ResourceRow, SubscriptionRow } from '../shared/api.js';
import { groupProviderCards } from './providers-model.js';

const key = (provider: ProviderRow['provider']): ProviderRow => ({
  provider,
  method: 'api-key',
  status: 'missing',
  keyCheckStatus: 'unchecked',
  usableBy: [],
  modelCount: 0,
});

const subscription = (runtime: SubscriptionRow['runtime']): SubscriptionRow => ({
  runtime,
  method: 'subscription',
  status: 'not-connected',
  authMode: 'none',
  loginSupported: true,
  loginState: 'idle',
  usableBy: runtime,
});

const resource = (id: string, connection: ResourceRow['connection']): ResourceRow => ({
  id,
  displayName: id,
  kind: 'model',
  adapter: 'pi',
  provenance: 'config',
  availability: 'available',
  auth: 'unknown',
  quota: { freshness: 'unknown', sources: [] },
  costModel: 'unknown',
  capabilities: [],
  control: { dsh: false },
  ...(connection === undefined ? {} : { connection }),
});

describe('groupProviderCards', () => {
  const cards = groupProviderCards({
    keys: [key('anthropic'), key('deepseek'), key('mistral')],
    subscriptions: [subscription('claude-code'), subscription('codex')],
    resources: [
      resource('pi:claude', { provider: 'anthropic', method: 'api', support: 'official' }),
      resource('claude-code', {
        provider: 'anthropic',
        method: 'subscription',
        support: 'official',
      }),
      resource('pi:local', { method: 'local', support: 'official' }),
      resource('unknown', undefined),
    ],
  });
  const card = (id: string) => cards.find((c) => c.id === id);

  it('lists the providers in a fixed order, Local / Custom last', () => {
    expect(cards.slice(0, 6).map((c) => c.id)).toEqual([
      'anthropic',
      'openai',
      'google',
      'deepseek',
      'mistral',
      'openrouter',
    ]);
    expect(cards.at(-1)?.id).toBe('local');
  });

  it('groups subscription and API key methods under their provider', () => {
    expect(card('anthropic')?.subscription?.runtime).toBe('claude-code');
    expect(card('anthropic')?.apiKey?.provider).toBe('anthropic');
    expect(card('openai')?.subscription?.runtime).toBe('codex');
    expect(card('openai')?.apiKey).toBeUndefined();
    expect(card('deepseek')?.subscription).toBeUndefined();
    expect(card('deepseek')?.apiKey?.provider).toBe('deepseek');
  });

  it('counts resources by their connection', () => {
    expect(card('anthropic')?.resourceCount).toBe(2);
    expect(card('local')?.resourceCount).toBe(1);
    expect(card('mistral')?.resourceCount).toBe(0);
  });

  it('offers the ChatGPT plan method on the OpenAI card only', () => {
    expect(cards.filter((c) => c.chatgptPlan).map((c) => c.id)).toEqual(['openai']);
    // Even without an API key or a Codex row, the card has a method.
    const bare = groupProviderCards({ keys: [], subscriptions: [], resources: [] });
    expect(bare.find((c) => c.id === 'openai')?.notAvailable).toBe(false);
  });

  it('marks a provider without any supported method as not available', () => {
    expect(card('openrouter')?.notAvailable).toBe(true);
    expect(card('google')?.notAvailable).toBe(true);
    expect(card('deepseek')?.notAvailable).toBe(false);
    expect(card('local')?.notAvailable).toBe(false);
    expect(card('local')?.local).toBe(true);
  });
});
