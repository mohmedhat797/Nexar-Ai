import { describe, expect, it } from 'vitest';
import type { DiscoveryContext, ResourceConnection } from '@nexar/contracts';
import { piCatalogDiscoverySource } from './catalog-discovery.js';
import type { CatalogModel } from './pi-models.js';

const ctx = (): DiscoveryContext => ({ now: new Date(), signal: AbortSignal.timeout(5000) });

const model = (id: string, input = 3, output = 15, contextWindow = 200_000): CatalogModel => ({
  id,
  contextWindow,
  maxTokens: 8192,
  inputPerMillionTokens: input,
  outputPerMillionTokens: output,
});

describe('pi multi-connection catalog discovery & isolation (ADR-029 / NXR-070B′)', () => {
  const models = [model('claude-3-5-sonnet', 3, 15), model('claude-3-haiku', 0.25, 1.25)];

  it('reproduces canonical built-in resource IDs and connection metadata when connection is default', async () => {
    const source = piCatalogDiscoverySource({
      providers: ['anthropic'],
      listModels: () => Promise.resolve(models),
    });

    const resources = await source.discover(ctx());
    expect(resources.map((r) => r.id)).toEqual([
      'pi.anthropic.claude-3-5-sonnet',
      'pi.anthropic.claude-3-haiku',
    ]);

    for (const r of resources) {
      expect(r.auth.mode).toBe('api-key');
      if (r.auth.mode === 'api-key' && r.auth.credential.source === 'keystore') {
        expect(r.auth.credential.name).toBe('ANTHROPIC_API_KEY');
      }
      expect(r.metadata?.['connection']).toEqual({
        id: 'anthropic.api',
        provider: 'anthropic',
        method: 'api',
        authClass: 'official-api',
        support: 'official',
      });
    }
  });

  it('generates connection-qualified resource IDs and distinct credential scopes for owner connections', async () => {
    const ownerConnection: ResourceConnection = {
      id: 'anthropic.api.cworkteam12',
      provider: 'anthropic',
      method: 'api',
      authClass: 'official-api',
      support: 'official',
    };
    const ownerKeyName = 'ANTHROPIC_API_KEY__CWORKTEAM12';

    const source = piCatalogDiscoverySource({
      providers: ['anthropic'],
      connection: ownerConnection,
      credentialName: ownerKeyName,
      listModels: () => Promise.resolve(models),
    });

    const resources = await source.discover(ctx());
    expect(resources.map((r) => r.id)).toEqual([
      'pi.anthropic.api.cworkteam12.claude-3-5-sonnet',
      'pi.anthropic.api.cworkteam12.claude-3-haiku',
    ]);

    for (const r of resources) {
      expect(r.auth.mode).toBe('api-key');
      if (r.auth.mode === 'api-key' && r.auth.credential.source === 'keystore') {
        expect(r.auth.credential.name).toBe(ownerKeyName);
      }
      expect(r.metadata?.['connection']).toEqual(ownerConnection);
    }
  });

  it('prevents resource collisions between multiple accounts on the same provider', async () => {
    const conn1: ResourceConnection = {
      id: 'openai.api',
      provider: 'openai',
      method: 'api',
      authClass: 'official-api',
      support: 'official',
    };
    const conn2: ResourceConnection = {
      id: 'openai.api.cpersonal01',
      provider: 'openai',
      method: 'api',
      authClass: 'official-api',
      support: 'official',
    };

    const gptModels = [model('gpt-4o', 5, 15)];

    const source1 = piCatalogDiscoverySource({
      providers: ['openai'],
      connection: conn1,
      credentialName: 'OPENAI_API_KEY',
      listModels: () => Promise.resolve(gptModels),
    });
    const source2 = piCatalogDiscoverySource({
      providers: ['openai'],
      connection: conn2,
      credentialName: 'OPENAI_API_KEY__CPERSONAL01',
      listModels: () => Promise.resolve(gptModels),
    });

    const res1 = await source1.discover(ctx());
    const res2 = await source2.discover(ctx());

    expect(res1[0]?.id).toBe('pi.openai.gpt-4o');
    expect(res2[0]?.id).toBe('pi.openai.api.cpersonal01.gpt-4o');
    expect(res1[0]?.id).not.toBe(res2[0]?.id);

    const firstAuth = res1[0]?.auth;
    expect(firstAuth?.mode).toBe('api-key');
    if (firstAuth && firstAuth.mode === 'api-key' && firstAuth.credential.source === 'keystore') {
      expect(firstAuth.credential.name).toBe('OPENAI_API_KEY');
    }
    const secondAuth = res2[0]?.auth;
    expect(secondAuth?.mode).toBe('api-key');
    if (
      secondAuth &&
      secondAuth.mode === 'api-key' &&
      secondAuth.credential.source === 'keystore'
    ) {
      expect(secondAuth.credential.name).toBe('OPENAI_API_KEY__CPERSONAL01');
    }
  });
});
