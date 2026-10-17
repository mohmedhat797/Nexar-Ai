import { describe, expect, it } from 'vitest';
import {
  BUILTIN_CONNECTIONS,
  ENGINE_CONTROL_REQUIREMENTS,
  KNOWN_CAPABILITIES,
  adapterId,
  canConnectionAdmit,
  connectionKey,
  connectionOf,
  generateConnectionId,
  isConnectionTombstoned,
  isControlCompatible,
  resourceId,
  type ConnectionHost,
  type PersistentConnectionRecord,
  type ResourceConnection,
  type ResourceDescriptor,
} from './index.js';

function descriptor(
  kind: ResourceDescriptor['kind'],
  extra: Partial<ResourceDescriptor> = {},
): ResourceDescriptor {
  return {
    id: resourceId('r'),
    displayName: 'r',
    kind,
    capabilities: ['text-generation'],
    runtime: { adapter: adapterId('a'), locality: 'local' },
    auth: { mode: 'none' },
    cost: { model: 'unknown' },
    dataLocality: 'local',
    ...extra,
  };
}
const agent = (name: string): ResourceDescriptor =>
  descriptor({ type: 'agent', agent: name, interface: 'cli' });
const model = (
  provider: string,
  access: 'api' | 'subscription' | 'local',
  extra: Partial<ResourceDescriptor> = {},
): ResourceDescriptor => descriptor({ type: 'model', provider, model: 'm', access }, extra);

describe('capabilities', () => {
  it('adds model-turn without touching tool-use', () => {
    expect(KNOWN_CAPABILITIES).toContain('model-turn');
    expect(KNOWN_CAPABILITIES.filter((c) => c === 'tool-use')).toHaveLength(1);
    expect(KNOWN_CAPABILITIES.slice(0, 11)).toEqual([
      'text-generation',
      'reasoning',
      'knowledge-work',
      'coding',
      'repo-editing',
      'code-review',
      'tool-use',
      'shell-execution',
      'long-context',
      'web-research',
      'vision',
    ]);
  });
});

describe('connectionOf', () => {
  it('prefers well-formed explicit metadata and copies only the known fields', () => {
    const explicit = {
      id: 'x.api',
      provider: 'x',
      method: 'custom',
      authClass: 'official-account',
      support: 'experimental',
    };
    const found = connectionOf(
      model('anthropic', 'api', { metadata: { connection: { ...explicit, token: 'SENTINEL' } } }),
    );
    expect(found).toEqual(explicit);
  });

  it.each([
    ['not an object', 'x'],
    ['an array', []],
    ['missing field', { id: 'a', provider: 'a', method: 'api', authClass: 'none' }],
    [
      'bad method',
      { id: 'a', provider: 'a', method: 'tcp', authClass: 'none', support: 'official' },
    ],
    ['bad class', { id: 'a', provider: 'a', method: 'api', authClass: 'x', support: 'official' }],
    ['bad support', { id: 'a', provider: 'a', method: 'api', authClass: 'none', support: 'beta' }],
    ['empty id', { id: '', provider: 'a', method: 'api', authClass: 'none', support: 'official' }],
  ])('ignores malformed metadata (%s) and infers instead', (_name, connection) => {
    expect(connectionOf(model('openai', 'api', { metadata: { connection } }))?.id).toBe(
      'openai.api',
    );
  });

  const table: [string, ResourceDescriptor, ResourceConnection | undefined][] = [
    [
      'claude-code',
      agent('claude-code'),
      {
        id: 'anthropic.subscription',
        provider: 'anthropic',
        method: 'subscription',
        authClass: 'vendor-native',
        support: 'official',
      },
    ],
    [
      'codex',
      agent('codex'),
      {
        id: 'openai.subscription',
        provider: 'openai',
        method: 'subscription',
        authClass: 'vendor-native',
        support: 'official',
      },
    ],
    [
      'antigravity',
      agent('antigravity'),
      {
        id: 'google.subscription',
        provider: 'google',
        method: 'subscription',
        authClass: 'vendor-native',
        support: 'experimental',
      },
    ],
    [
      'deepseek-harness',
      agent('deepseek-harness'),
      {
        id: 'deepseek.api',
        provider: 'deepseek',
        method: 'api',
        authClass: 'official-api',
        support: 'official',
      },
    ],
    [
      'api model',
      model('mistral', 'api'),
      {
        id: 'mistral.api',
        provider: 'mistral',
        method: 'api',
        authClass: 'official-api',
        support: 'official',
      },
    ],
    [
      'keyless local model',
      model('lab', 'local'),
      {
        id: 'local.lab',
        provider: 'local',
        method: 'local',
        authClass: 'none',
        support: 'official',
      },
    ],
    [
      'local model with a key',
      model('lab', 'local', {
        auth: { mode: 'api-key', credential: { source: 'env', name: 'LAB_KEY' } },
      }),
      {
        id: 'local.lab',
        provider: 'local',
        method: 'local',
        authClass: 'official-api',
        support: 'official',
      },
    ],
    ['subscription model', model('openai', 'subscription'), undefined],
    ['unknown agent', agent('pi'), undefined],
    ['inherited name', agent('constructor'), undefined],
    ['tool runtime', descriptor({ type: 'tool-runtime', tool: 't', interface: 'cli' }), undefined],
  ];
  it.each(table)('infers for %s', (_name, d, expected) => {
    expect(connectionOf(d)).toEqual(expected);
  });
});

describe('isControlCompatible', () => {
  it('is a capability check only, for the one control engine', () => {
    expect(ENGINE_CONTROL_REQUIREMENTS).toEqual({ dsh: ['model-turn'] });
    const turn = model('openai', 'api', { capabilities: ['model-turn'] });
    expect(isControlCompatible(turn, 'dsh')).toBe(true);
    // A native agent executes tools itself and does not accept caller tool schemas.
    const native = descriptor(
      { type: 'agent', agent: 'claude-code', interface: 'cli' },
      { capabilities: ['tool-use', 'coding'], auth: { mode: 'none' } },
    );
    expect(isControlCompatible(native, 'dsh')).toBe(false);
    // Connection method and auth never grant compatibility.
    expect(isControlCompatible(model('openai', 'api'), 'dsh')).toBe(false);
  });
});

describe('connectionKey (TST-05)', () => {
  it('combines host and connectionId with strict validation', () => {
    expect(connectionKey('desktop', 'anthropic.subscription')).toBe(
      'desktop:anthropic.subscription',
    );
    expect(connectionKey('plane', 'anthropic.subscription')).toBe('plane:anthropic.subscription');
    expect(connectionKey('desktop', 'openai.chatgpt-plan')).toBe('desktop:openai.chatgpt-plan');
  });

  it('rejects invalid or unauthorized host literals', () => {
    expect(() => connectionKey('wsl' as unknown as ConnectionHost, 'c1')).toThrow(
      'Invalid connection host',
    );
    expect(() => connectionKey('remote' as unknown as ConnectionHost, 'c1')).toThrow(
      'Invalid connection host',
    );
    expect(() => connectionKey('' as unknown as ConnectionHost, 'c1')).toThrow(
      'Invalid connection host',
    );
  });

  it('rejects empty, untrimmed or invalid connectionId values', () => {
    expect(() => connectionKey('desktop', '')).toThrow('Invalid connectionId');
    expect(() => connectionKey('desktop', '   ')).toThrow('Invalid connectionId');
    expect(() => connectionKey('desktop', ' c1 ')).toThrow('Invalid connectionId');
    expect(() => connectionKey('desktop', null as unknown as string)).toThrow(
      'Invalid connectionId',
    );
  });
});

describe('BUILTIN_CONNECTIONS (TST-01)', () => {
  it('reproduces accepted main identities byte-for-byte with frozen immutability', () => {
    expect(Object.isFrozen(BUILTIN_CONNECTIONS)).toBe(true);
    const keys = Object.keys(BUILTIN_CONNECTIONS).sort();
    expect(keys).toEqual([
      'anthropic.subscription',
      'deepseek.api',
      'google.subscription',
      'openai.chatgpt-plan',
      'openai.subscription',
    ]);

    for (const def of Object.values(BUILTIN_CONNECTIONS)) {
      expect(Object.isFrozen(def)).toBe(true);
      expect(def.builtIn).toBe(true);
      expect(def.enabled).toBe(true);
      expect(def.machine).toBe('desktop');
      expect(Object.isFrozen(def.credentialScope)).toBe(true);
    }

    expect(BUILTIN_CONNECTIONS['anthropic.subscription']).toEqual({
      id: 'anthropic.subscription',
      provider: 'anthropic',
      method: 'subscription',
      authClass: 'vendor-native',
      support: 'official',
      machine: 'desktop',
      label: 'Claude Code (subscription)',
      enabled: true,
      builtIn: true,
      credentialScope: {
        kind: 'native-home',
        runtimeId: 'claude-code',
        home: 'default',
      },
    });

    expect(BUILTIN_CONNECTIONS['openai.subscription']).toEqual({
      id: 'openai.subscription',
      provider: 'openai',
      method: 'subscription',
      authClass: 'vendor-native',
      support: 'official',
      machine: 'desktop',
      label: 'Codex (subscription)',
      enabled: true,
      builtIn: true,
      credentialScope: {
        kind: 'native-home',
        runtimeId: 'codex',
        home: 'default',
      },
    });

    expect(BUILTIN_CONNECTIONS['google.subscription']).toEqual({
      id: 'google.subscription',
      provider: 'google',
      method: 'subscription',
      authClass: 'vendor-native',
      support: 'experimental',
      machine: 'desktop',
      label: 'Antigravity (subscription)',
      enabled: true,
      builtIn: true,
      credentialScope: {
        kind: 'native-home',
        runtimeId: 'antigravity',
        home: 'default',
      },
    });

    expect(BUILTIN_CONNECTIONS['deepseek.api']).toEqual({
      id: 'deepseek.api',
      provider: 'deepseek',
      method: 'api',
      authClass: 'official-api',
      support: 'official',
      machine: 'desktop',
      label: 'DeepSeek (API)',
      enabled: true,
      builtIn: true,
      credentialScope: {
        kind: 'keystore',
        name: 'DEEPSEEK_API_KEY',
      },
    });

    expect(BUILTIN_CONNECTIONS['openai.chatgpt-plan']).toEqual({
      id: 'openai.chatgpt-plan',
      provider: 'openai',
      method: 'subscription',
      authClass: 'official-account',
      support: 'official',
      machine: 'desktop',
      label: 'ChatGPT Plan',
      enabled: true,
      builtIn: true,
      credentialScope: {
        kind: 'account',
        name: 'chatgpt-plan',
      },
    });
  });
});

describe('generateConnectionId (TST-04)', () => {
  it('generates <family>.c<10 base32> using RFC 4648 lowercase base32 alphabet', () => {
    const id = generateConnectionId('openai');
    expect(id).toMatch(/^openai\.c[a-z2-7]{10}$/);
  });

  it('produces deterministic output with injected RNG', () => {
    // 0..9 in base32 ('abcdefghijklmnopqrstuvwxyz234567'):
    // 0 -> 'a', 1 -> 'b', 2 -> 'c', 3 -> 'd', 4 -> 'e',
    // 5 -> 'f', 6 -> 'g', 7 -> 'h', 8 -> 'i', 9 -> 'j'
    const deterministicRng = () => new Uint8Array([0, 1, 2, 3, 4, 5, 6, 7, 8, 9]);
    const id = generateConnectionId('anthropic', { rng: deterministicRng });
    expect(id).toBe('anthropic.cabcdefghij');
  });

  it('detects collisions against built-in IDs and retries', () => {
    let callCount = 0;
    // Simulate first attempt colliding with a pseudo-builtIn or reserved ID, second succeeding
    const rng = () => {
      callCount++;
      if (callCount === 1) {
        // Mock bytes that will collide if existingIds contains candidate
        return new Uint8Array([0, 0, 0, 0, 0, 0, 0, 0, 0, 0]); // caaaaaaaaaa
      }
      return new Uint8Array([1, 1, 1, 1, 1, 1, 1, 1, 1, 1]); // cbbbbbbbbbb
    };

    const id = generateConnectionId('openai', {
      rng,
      existingIds: ['openai.caaaaaaaaaa'],
    });
    expect(id).toBe('openai.cbbbbbbbbbb');
    expect(callCount).toBe(2);
  });

  it('detects collisions against tombstoned IDs and isTaken callback', () => {
    let callCount = 0;
    const rng = () => {
      callCount++;
      if (callCount === 1) return new Uint8Array([0, 0, 0, 0, 0, 0, 0, 0, 0, 0]);
      if (callCount === 2) return new Uint8Array([1, 1, 1, 1, 1, 1, 1, 1, 1, 1]);
      return new Uint8Array([2, 2, 2, 2, 2, 2, 2, 2, 2, 2]); // cccccccccc
    };

    const id = generateConnectionId('deepseek', {
      rng,
      tombstonedIds: ['deepseek.caaaaaaaaaa'],
      isTaken: (candidate) => candidate === 'deepseek.cbbbbbbbbbb',
    });
    expect(id).toBe('deepseek.c' + 'c'.repeat(10));
    expect(callCount).toBe(3);
  });

  it('throws bounded collision exhaustion error when maxAttempts is reached', () => {
    const collidingRng = () => new Uint8Array([0, 0, 0, 0, 0, 0, 0, 0, 0, 0]);
    expect(() =>
      generateConnectionId('openai', {
        rng: collidingRng,
        existingIds: ['openai.caaaaaaaaaa'],
        maxAttempts: 3,
      }),
    ).toThrow("Failed to generate unique connection ID for family 'openai' after 3 attempts");
  });

  it('rejects invalid connection families', () => {
    expect(() => generateConnectionId('')).toThrow('Invalid connection family');
    expect(() => generateConnectionId('OpenAI')).toThrow('Invalid connection family');
    expect(() => generateConnectionId('openai ')).toThrow('Invalid connection family');
    expect(() => generateConnectionId('openai/api')).toThrow('Invalid connection family');
  });
});

describe('canConnectionAdmit & isConnectionTombstoned (ADR-029 §4.3 / OD-7)', () => {
  const baseRecord: PersistentConnectionRecord = {
    id: 'anthropic.api.c1234567890',
    provider: 'anthropic',
    method: 'api',
    authClass: 'official-api',
    support: 'official',
    machine: 'desktop',
    label: 'Work Key',
    enabled: true,
    builtIn: false,
    credentialScope: { kind: 'keystore', name: 'ANTHROPIC_API_KEY__C1234567890' },
    credentialGeneration: 1,
    identityAssurance: 'OWNER_ASSERTED_SAME_ACCOUNT',
    lifecycleState: 'ACTIVE',
    createdAt: '2026-10-17T00:00:00.000Z',
    updatedAt: '2026-10-17T00:00:00.000Z',
  };

  it('admits units only when lifecycleState is ACTIVE and enabled is true', () => {
    expect(canConnectionAdmit(baseRecord)).toBe(true);

    expect(canConnectionAdmit({ ...baseRecord, enabled: false })).toBe(false);
    expect(canConnectionAdmit({ ...baseRecord, lifecycleState: 'DISABLED' })).toBe(false);
    expect(canConnectionAdmit({ ...baseRecord, lifecycleState: 'DISABLED', enabled: false })).toBe(
      false,
    );
    expect(canConnectionAdmit({ ...baseRecord, lifecycleState: 'TOMBSTONED' })).toBe(false);
    expect(
      canConnectionAdmit({ ...baseRecord, lifecycleState: 'TOMBSTONED', enabled: false }),
    ).toBe(false);
  });

  it('identifies tombstoned connection IDs correctly', () => {
    const tombstones = ['deepseek.api.cold1', 'openai.api.cretired'];
    expect(isConnectionTombstoned('deepseek.api.cold1', tombstones)).toBe(true);
    expect(isConnectionTombstoned('openai.api.cretired', tombstones)).toBe(true);
    expect(isConnectionTombstoned('anthropic.api.cactive', tombstones)).toBe(false);
    expect(isConnectionTombstoned('openai.subscription', tombstones)).toBe(false);
  });
});
