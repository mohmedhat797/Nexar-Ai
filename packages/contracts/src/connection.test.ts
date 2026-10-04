import { describe, expect, it } from 'vitest';
import {
  ENGINE_CONTROL_REQUIREMENTS,
  KNOWN_CAPABILITIES,
  adapterId,
  connectionOf,
  isControlCompatible,
  resourceId,
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
  it('is a capability check only, for both engines', () => {
    expect(ENGINE_CONTROL_REQUIREMENTS).toEqual({
      openworker: ['model-turn'],
      dsh: ['model-turn'],
    });
    const turn = model('openai', 'api', { capabilities: ['model-turn'] });
    expect(isControlCompatible(turn, 'openworker')).toBe(true);
    expect(isControlCompatible(turn, 'dsh')).toBe(true);
    // A native agent executes tools itself and does not accept caller tool schemas.
    const native = descriptor(
      { type: 'agent', agent: 'claude-code', interface: 'cli' },
      { capabilities: ['tool-use', 'coding'], auth: { mode: 'none' } },
    );
    expect(isControlCompatible(native, 'openworker')).toBe(false);
    // Connection method and auth never grant compatibility.
    expect(isControlCompatible(model('openai', 'api'), 'dsh')).toBe(false);
  });
});
