import {
  BUILTIN_CONNECTIONS,
  adapterId,
  resourceId,
  type ConnectionDefinition,
  type ProviderModelEntry,
  type ProviderModelInventory,
  type ResourceDescriptor,
} from '@nexar/contracts';
import { describe, expect, it } from 'vitest';
import { catalogResourceId, inventoryResourceId, materializeInventory } from './materialize.js';

const entry: ProviderModelEntry = {
  selection: { kind: 'model', id: 'new-model' },
  displayName: 'New',
  availability: 'available',
  compatibility: 'native-agent',
};
const inventory: ProviderModelInventory = {
  identity: {
    provider: 'acme',
    connectionId: 'owner',
    runtimeId: 'native',
    routeId: 'cli',
    machine: 'desktop',
  },
  generation: 0,
  status: 'fresh',
  source: 'live-runtime',
  auth: 'authenticated',
  observedAt: '2026-10-07T00:00:00.000Z',
  entries: [entry],
};
const template: ResourceDescriptor = {
  id: resourceId('ignored'),
  displayName: 'Old',
  kind: {
    type: 'agent',
    agent: 'native',
    interface: 'cli',
    underlying: { provider: 'acme', model: 'old-model' },
  },
  capabilities: ['text-generation', 'repo-editing'],
  runtime: {
    adapter: adapterId('native'),
    locality: 'local',
    options: { model: 'old-model', safeOption: true },
  },
  auth: {
    mode: 'subscription',
    credential: { source: 'runtime-managed', description: 'Vendor-owned login' },
  },
  cost: { model: 'subscription' },
  limits: { contextWindowTokens: 100 },
  dataLocality: 'third-party',
};

describe('inventory resource materialization', () => {
  it('preserves native agent kind and uses the discovered opaque id on this invocation', () => {
    const [resource] = materializeInventory(inventory, template);
    expect(resource).toMatchObject({
      kind: { type: 'agent', underlying: { provider: 'acme', model: 'new-model' } },
      runtime: { options: { model: 'new-model', safeOption: true } },
    });
    expect(resource?.id).toMatch(/^inventory:[0-9a-f]{64}$/);
    expect(resource?.limits).toBeUndefined();
    expect(resource?.capabilities).not.toContain('model-turn');
    expect(template.runtime.options?.model).toBe('old-model');
    expect(Object.isFrozen(inventory.identity)).toBe(false);
    expect(Object.isFrozen(entry.selection)).toBe(false);
    expect(Object.isFrozen(resource?.metadata)).toBe(true);
  });

  it('removes both default model overrides without turning default into a concrete slug', () => {
    const defaultEntry: ProviderModelEntry = {
      ...entry,
      selection: { kind: 'provider-default' },
      displayName: 'Provider default',
      limits: { contextWindowTokens: 42 },
    };
    const [resource] = materializeInventory({ ...inventory, entries: [defaultEntry] }, template);
    expect(resource?.kind.type).toBe('agent');
    expect(resource?.runtime.options).toEqual({ safeOption: true });
    expect(resource?.limits).toBeUndefined();
    expect(resource?.kind).toEqual({
      type: 'agent',
      agent: 'native',
      interface: 'cli',
      underlying: { provider: 'acme' },
    });
    expect(resource?.id).not.toBe(inventoryResourceId(inventory.identity, entry.selection));
  });

  it('materializes model-turn access only through a model-turn template, with unknown old prices', () => {
    const modelTemplate: ResourceDescriptor = {
      ...template,
      kind: { type: 'model', provider: 'acme', model: 'old', access: 'subscription' },
      capabilities: ['text-generation', 'model-turn'],
      cost: {
        model: 'per-token',
        currency: 'USD',
        inputPerMillionTokens: 1,
        outputPerMillionTokens: 2,
      },
    };
    const modelEntry: ProviderModelEntry = {
      ...entry,
      compatibility: 'model-turn',
      limits: { contextWindowTokens: 42 },
    };
    expect(materializeInventory(inventory, modelTemplate)).toEqual([]);
    const [resource] = materializeInventory({ ...inventory, entries: [modelEntry] }, modelTemplate);
    expect(resource).toMatchObject({
      kind: { type: 'model', model: 'new-model', access: 'subscription' },
      capabilities: ['text-generation', 'model-turn'],
      cost: { model: 'unknown' },
      limits: { contextWindowTokens: 42 },
    });
    expect(
      materializeInventory(
        { ...inventory, entries: [{ ...modelEntry, selection: { kind: 'provider-default' } }] },
        modelTemplate,
      ),
    ).toEqual([]);
  });

  it('never promotes stale, unsupported, unavailable or static catalogs into eligible resources', () => {
    for (const status of ['stale', 'unavailable', 'unsupported'] as const)
      expect(materializeInventory({ ...inventory, status }, template)).toEqual([]);
    expect(materializeInventory({ ...inventory, source: 'static-verified' }, template)).toEqual([]);
    expect(
      materializeInventory(
        { ...inventory, entries: [{ ...entry, source: 'static-verified' }] },
        template,
      ),
    ).toEqual([]);
    expect(
      materializeInventory(
        { ...inventory, entries: [{ ...entry, availability: 'unavailable' }] },
        template,
      ),
    ).toEqual([]);
  });

  it('does not grant native agents model-turn from model metadata', () => {
    const [resource] = materializeInventory(
      { ...inventory, entries: [{ ...entry, capabilities: ['model-turn', 'reasoning'] }] },
      { ...template, capabilities: [...template.capabilities, 'model-turn'] },
    );
    expect(resource?.capabilities).toEqual(['text-generation', 'repo-editing', 'reasoning']);
  });

  it('keeps ids stable across label/time/generation changes and separates access routes', () => {
    const id = materializeInventory(inventory, template)[0]?.id;
    expect(
      materializeInventory(
        {
          ...inventory,
          generation: 7,
          observedAt: '2027-01-01T00:00:00.000Z',
          entries: [{ ...entry, displayName: 'Renamed' }],
        },
        template,
      )[0]?.id,
    ).toBe(id);
    for (const difference of [
      { connectionId: 'other' },
      { routeId: 'responses' },
      { runtimeId: 'other' },
      { machine: 'plane' as const },
    ]) {
      expect(
        inventoryResourceId({ ...inventory.identity, ...difference }, entry.selection),
      ).not.toBe(id);
    }
    expect(materializeInventory({ ...inventory, entries: [] }, template)).toEqual([]);
    expect(materializeInventory(inventory, template)[0]?.id).toBe(id);
  });

  it('honors only explicit legacy-id migration and rejects hook collisions', () => {
    expect(
      materializeInventory(inventory, template, {
        legacyId: (identity) =>
          identity.routeId === 'cli' ? resourceId('legacy:new-model') : undefined,
      })[0]?.id,
    ).toBe('legacy:new-model');
    expect(() =>
      materializeInventory(
        { ...inventory, entries: [entry, { ...entry, selection: { kind: 'model', id: 'other' } }] },
        template,
        { legacyId: () => resourceId('collision') },
      ),
    ).toThrow('Duplicate inventory resource identity');
  });
});

describe('catalogResourceId (TST-01, TST-02, TST-03, TST-05)', () => {
  it('reproduces built-in pi.<provider>.<model> IDs byte-for-byte (TST-01)', () => {
    const builtinAnthropic = BUILTIN_CONNECTIONS['anthropic.subscription'];
    const id = catalogResourceId(builtinAnthropic, 'anthropic', 'claude-3-5-sonnet-20241022');
    expect(id).toBe('pi.anthropic.claude-3-5-sonnet-20241022');

    const builtinDeepseek = BUILTIN_CONNECTIONS['deepseek.api'];
    const dsId = catalogResourceId(builtinDeepseek, 'deepseek', 'deepseek-chat');
    expect(dsId).toBe('pi.deepseek.deepseek-chat');

    const builtinOpenai = BUILTIN_CONNECTIONS['openai.subscription'];
    const oaiId = catalogResourceId(builtinOpenai, 'openai', 'gpt-4o');
    expect(oaiId).toBe('pi.openai.gpt-4o');
  });

  it('generates distinct IDs for two owner connections using the same provider and model (TST-02)', () => {
    const connA: ConnectionDefinition = {
      id: 'openai.caaaaaaaaa',
      provider: 'openai',
      method: 'api',
      authClass: 'official-api',
      support: 'official',
      machine: 'desktop',
      label: 'Work Account',
      enabled: true,
      builtIn: false,
      credentialScope: { kind: 'keystore', name: 'OPENAI_API_KEY__CAAAAAAAAA' },
    };
    const connB: ConnectionDefinition = {
      ...connA,
      id: 'openai.cbbbbbbbbb',
      label: 'Personal Account',
      credentialScope: { kind: 'keystore', name: 'OPENAI_API_KEY__CBBBBBBBBB' },
    };

    const idA = catalogResourceId(connA, 'openai', 'gpt-5');
    const idB = catalogResourceId(connB, 'openai', 'gpt-5');

    expect(idA).toMatch(/^catalog:[0-9a-f]{64}$/);
    expect(idB).toMatch(/^catalog:[0-9a-f]{64}$/);
    expect(idA).not.toBe(idB);
  });

  it('maintains ID stability across label, credential, and preference changes (TST-03)', () => {
    const original: ConnectionDefinition = {
      id: 'anthropic.caaaaaaaaa',
      provider: 'anthropic',
      method: 'api',
      authClass: 'official-api',
      support: 'official',
      machine: 'desktop',
      label: 'Old Label',
      enabled: true,
      builtIn: false,
      credentialScope: { kind: 'keystore', name: 'ANTHROPIC_API_KEY__CAAAAAAAAA' },
    };
    const modified: ConnectionDefinition = {
      ...original,
      label: 'New Renamed Label',
      enabled: false,
      credentialScope: { kind: 'keystore', name: 'ROTATED_KEY' },
    };

    expect(catalogResourceId(modified, 'anthropic', 'claude-3-5-haiku')).toBe(
      catalogResourceId(original, 'anthropic', 'claude-3-5-haiku'),
    );
  });

  it('distinguishes desktop and plane host origins for identical connectionId and model (TST-05)', () => {
    const desktopConn: ConnectionDefinition = {
      id: 'openai.caaaaaaaaa',
      provider: 'openai',
      method: 'api',
      authClass: 'official-api',
      support: 'official',
      machine: 'desktop',
      label: 'Desktop Conn',
      enabled: true,
      builtIn: false,
      credentialScope: { kind: 'none' },
    };
    const planeConn: ConnectionDefinition = {
      ...desktopConn,
      machine: 'plane',
      label: 'Plane Conn',
    };

    const desktopId = catalogResourceId(desktopConn, 'openai', 'gpt-5');
    const planeId = catalogResourceId(planeConn, 'openai', 'gpt-5');

    expect(desktopId).not.toBe(planeId);
  });

  it('rejects invalid or empty provider and model selections', () => {
    const conn = BUILTIN_CONNECTIONS['anthropic.subscription'];
    expect(() => catalogResourceId(conn, '', 'model')).toThrow(
      'Invalid catalog resource selection',
    );
    expect(() => catalogResourceId(conn, 'anthropic', '')).toThrow(
      'Invalid catalog resource selection',
    );
  });
});
