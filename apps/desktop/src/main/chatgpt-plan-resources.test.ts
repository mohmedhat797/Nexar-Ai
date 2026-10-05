import { describe, expect, it } from 'vitest';
import { isControlCompatible, connectionOf } from '@nexar/contracts';
import { chatGptPlanResources } from './chatgpt-plan-resources.js';
import type { ChatGptPlanStatus } from '../shared/chatgpt-plan.js';

const connected: ChatGptPlanStatus = {
  state: 'connected',
  planSharing: true,
  message: 'Connected. Sign out in Nexar to forget this sign-in on this computer.',
};
const settings = (models: readonly string[] | 'damaged') => ({
  getChatGptPlan: () =>
    Promise.resolve(
      models === 'damaged'
        ? ({ valid: false } as const)
        : ({ valid: true, value: { models } } as const),
    ),
});
const plan = (status: ChatGptPlanStatus) => ({ status: () => Promise.resolve(status) });

describe('chatGptPlanResources', () => {
  it('publishes one pi model resource per listed model while connected with plan sharing', async () => {
    const resources = await chatGptPlanResources(plan(connected), settings(['gpt-5.2', 'gpt-5.4']));
    expect(resources.map((r) => r.id)).toEqual(['chatgpt-plan:gpt-5.2', 'chatgpt-plan:gpt-5.4']);
    const [first] = resources;
    expect(first).toMatchObject({
      runtime: { adapter: 'pi' },
      kind: { type: 'model', provider: 'openai', model: 'gpt-5.2' },
      auth: { mode: 'subscription', credential: { source: 'connection', name: 'chatgpt-plan' } },
    });
    expect(first?.capabilities).toContain('model-turn');
    expect(connectionOf(first as NonNullable<typeof first>)).toEqual({
      id: 'openai.chatgpt-plan',
      provider: 'openai',
      method: 'subscription',
      authClass: 'official-account',
      support: 'official',
    });
    expect(isControlCompatible(first as NonNullable<typeof first>, 'openworker')).toBe(true);
    expect(JSON.stringify(resources)).not.toMatch(/token|secret/i);
  });

  it.each<[string, ChatGptPlanStatus]>([
    ['signed out', { state: 'signed-out', message: 'Not connected.' }],
    [
      'signing in',
      {
        state: 'signing-in',
        message: 'Waiting for you to finish signing in with ChatGPT in your browser.',
      },
    ],
    [
      'expired',
      {
        state: 'signed-out',
        reason: 'expired',
        message: 'The ChatGPT sign-in expired. Sign in again.',
      },
    ],
    ['error', { state: 'error', reason: 'failed', message: 'The sign-in could not be completed.' }],
    ['connected without plan sharing', { ...connected, planSharing: false }],
  ])('publishes nothing when %s', async (_label, status) => {
    expect(await chatGptPlanResources(plan(status), settings(['gpt-5.2']))).toEqual([]);
  });

  it('publishes nothing without a service or with damaged settings', async () => {
    expect(await chatGptPlanResources(undefined, settings(['gpt-5.2']))).toEqual([]);
    expect(await chatGptPlanResources(plan(connected), settings('damaged'))).toEqual([]);
  });
});
