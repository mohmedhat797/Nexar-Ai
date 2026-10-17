import { describe, expect, it } from 'vitest';
import type { ConnectionDefinition, DiscoveryContext } from '@nexar/contracts';
import { catalogResourceId } from '@nexar/resource-registry';
import { piCatalogDiscoverySource } from './catalog-discovery.js';

const ctx = (): DiscoveryContext => ({
  now: new Date(),
  signal: AbortSignal.timeout(5000),
});
const models = [
  {
    id: 'model-one',
    contextWindow: 32000,
    maxTokens: 1024,
    inputPerMillionTokens: 1,
    outputPerMillionTokens: 2,
  },
];
function owner(suffix: string): ConnectionDefinition {
  return {
    id: `openai.api.c${suffix}`,
    provider: 'openai',
    method: 'api',
    authClass: 'official-api',
    support: 'official',
    machine: 'desktop',
    label: 'Synthetic account',
    enabled: true,
    builtIn: false,
    credentialScope: {
      kind: 'keystore',
      name: `OPENAI_API_KEY__C${suffix.toUpperCase()}`,
    },
  };
}

describe('pi connection-qualified catalog contract', () => {
  it('preserves built-in literal IDs and explicitly checks its actual credential source', async () => {
    const resources = await piCatalogDiscoverySource({
      providers: ['openai'],
      credentialSource: 'keystore',
      listModels: () => Promise.resolve(models),
    }).discover(ctx());
    expect(resources[0]?.id).toBe('pi.openai.model-one');
    expect(resources[0]?.auth).toEqual({
      mode: 'api-key',
      credential: { source: 'keystore', name: 'OPENAI_API_KEY' },
    });
  });
  it('uses the accepted materializer for owner IDs and projects only public connection fields', async () => {
    const connection = owner('aaaaaaaaaa');
    const resources = await piCatalogDiscoverySource({
      providers: ['openai'],
      credentialSource: 'keystore',
      connection,
      credentialName: 'OPENAI_API_KEY__CAAAAAAAAAA',
      catalogResourceId,
      listModels: () => Promise.resolve(models),
    }).discover(ctx());
    expect(resources[0]?.id).toBe(catalogResourceId(connection, 'openai', 'model-one'));
    expect(resources[0]?.auth).toEqual({
      mode: 'api-key',
      credential: { source: 'keystore', name: 'OPENAI_API_KEY__CAAAAAAAAAA' },
    });
    expect(resources[0]?.metadata?.['connection']).toEqual({
      id: connection.id,
      provider: 'openai',
      method: 'api',
      authClass: 'official-api',
      support: 'official',
    });
    expect(resources[0]?.metadata?.['connection']).not.toHaveProperty('credentialScope');
  });
  it('separates two accounts using the same provider/model and keeps their references distinct', async () => {
    const resources = await Promise.all(
      ['aaaaaaaaaa', 'bbbbbbbbbb'].map(async (suffix) => {
        const connection = owner(suffix);
        return piCatalogDiscoverySource({
          providers: ['openai'],
          credentialSource: 'keystore',
          connection,
          credentialName: `OPENAI_API_KEY__C${suffix.toUpperCase()}`,
          catalogResourceId,
          listModels: () => Promise.resolve(models),
        }).discover(ctx());
      }),
    );
    expect(resources[0]![0]?.id).not.toBe(resources[1]![0]?.id);
    expect(resources[0]![0]?.auth).not.toEqual(resources[1]![0]?.auth);
  });
  it('rejects missing, built-in or other-account scope instead of silently falling back', async () => {
    for (const credentialName of [undefined, 'OPENAI_API_KEY', 'OPENAI_API_KEY__CBBBBBBBBBB']) {
      await expect(
        piCatalogDiscoverySource({
          providers: ['openai'],
          credentialSource: 'keystore',
          connection: owner('aaaaaaaaaa'),
          catalogResourceId,
          listModels: () => Promise.resolve(models),
          ...(credentialName === undefined ? {} : { credentialName }),
        }).discover(ctx()),
      ).rejects.toMatchObject({ code: 'CONFIGURATION_ERROR' });
    }
  });
});
