import { describe, expect, it } from 'vitest';
import { join } from 'node:path';
import { NexarError, adapterId } from '@nexar/contracts';
import { buildDshEnv } from './env.js';
import { parseRuntimeOptions } from './options.js';
import { renderPatchOverlay } from './overlay.js';
import { deepseekHarnessResource } from './resource.js';

describe('buildDshEnv', () => {
  const parent: NodeJS.ProcessEnv = {
    PATH: '/usr/bin',
    HOME: '/home/u',
    USER: 'u',
    LANG: 'C',
    LC_ALL: 'C',
    TMPDIR: '/tmp',
    TERM: 'xterm',
    NODE_OPTIONS: '--max-old-space-size=1024',
    DEEPSEEK_API_KEY: 'sk-deepseek',
    OTHER_PROVIDER_KEY: 'sk-other',
    OPENAI_API_KEY: 'sk-openai',
    GH_TOKEN: 'ghp_secret',
    AWS_SECRET_ACCESS_KEY: 'aws-secret',
    DSH_HOME: '/users/real/.dsh',
  };

  it('passes only the allowlist, the resource credential and private runtime homes', () => {
    const env = buildDshEnv(parent, deepseekHarnessResource(), { stateDir: '/state' });
    expect(Object.keys(env).sort()).toEqual(
      [
        'DEEPSEEK_API_KEY',
        'DSH_HOME',
        'DSH_AGENTS_HOME',
        'HOME',
        'LANG',
        'LC_ALL',
        'NODE_OPTIONS',
        'PATH',
        'TERM',
        'TMPDIR',
        'USER',
      ].sort(),
    );
    expect(env.DSH_HOME).toBe(join('/state', 'home'));
    expect(env.DEEPSEEK_API_KEY).toBe('sk-deepseek');
  });

  it('never leaks unrelated secrets', () => {
    const env = buildDshEnv(parent, deepseekHarnessResource(), { stateDir: '/state' });
    for (const name of [
      'GH_TOKEN',
      'AWS_SECRET_ACCESS_KEY',
      'OPENAI_API_KEY',
      'OTHER_PROVIDER_KEY',
    ]) {
      expect(env).not.toHaveProperty(name);
    }
  });

  it('copies only variables present in the parent env and omits unset NODE_OPTIONS', () => {
    const env = buildDshEnv({ PATH: '/bin' }, deepseekHarnessResource(), { stateDir: '/s' });
    expect(Object.keys(env).sort()).toEqual(['DSH_AGENTS_HOME', 'DSH_HOME', 'PATH']);
  });

  it('adds piAiProviders key variables, and only those', () => {
    const env = buildDshEnv(parent, deepseekHarnessResource(), {
      stateDir: '/s',
      piAiProviders: { other: { apiKeyEnv: 'OTHER_PROVIDER_KEY' } },
    });
    expect(env.OTHER_PROVIDER_KEY).toBe('sk-other');
    expect(env).not.toHaveProperty('OPENAI_API_KEY');
  });

  it('adds no credential for runtime-managed or keyless resources', () => {
    const managed = deepseekHarnessResource({
      auth: { mode: 'oauth', credential: { source: 'runtime-managed', description: 'login' } },
    });
    const none = deepseekHarnessResource({ auth: { mode: 'none' } });
    expect(buildDshEnv(parent, managed, { stateDir: '/s' })).not.toHaveProperty('DEEPSEEK_API_KEY');
    expect(buildDshEnv(parent, none, { stateDir: '/s' })).not.toHaveProperty('DEEPSEEK_API_KEY');
  });
});

describe('renderPatchOverlay', () => {
  it('always disables session-log-deepseek', () => {
    expect(renderPatchOverlay()).toBe('- id: session-log-deepseek\n  disabled: true\n');
    expect(renderPatchOverlay({ piAiProviders: {} })).toBe(
      '- id: session-log-deepseek\n  disabled: true\n',
    );
  });

  it('renders llm-pi-ai providers', () => {
    const text = renderPatchOverlay({
      piAiProviders: {
        anthropic: { apiKeyEnv: 'ANTHROPIC_API_KEY' },
        'my.prov-1': { apiKeyEnv: 'K2' },
      },
    });
    expect(text).toBe(
      [
        '- id: session-log-deepseek',
        '  disabled: true',
        '- id: llm-pi-ai',
        '  config:',
        '    providers:',
        '      "anthropic":',
        '        apiKeyEnv: "ANTHROPIC_API_KEY"',
        '      "my.prov-1":',
        '        apiKeyEnv: "K2"',
        '',
      ].join('\n'),
    );
  });

  it.each(['a\n- id: evil', 'Upper', 'a b', 'a: b', '"quoted"', '', '-lead', 'a#b'])(
    'rejects provider name %j',
    (name) => {
      expect(() =>
        renderPatchOverlay({ piAiProviders: { [name]: { apiKeyEnv: 'OK_KEY' } } }),
      ).toThrow(expect.objectContaining({ code: 'CONFIGURATION_ERROR' }) as Error);
    },
  );

  it.each(['lower', 'A\n  disabled: false', 'A B', '1ABC', 'A"B', '', 'A-B'])(
    'rejects env name %j',
    (apiKeyEnv) => {
      expect(() => renderPatchOverlay({ piAiProviders: { ok: { apiKeyEnv } } })).toThrow(
        expect.objectContaining({ code: 'CONFIGURATION_ERROR' }) as Error,
      );
    },
  );
});

describe('parseRuntimeOptions', () => {
  const withOptions = (options: Record<string, unknown>) =>
    deepseekHarnessResource({
      runtime: { adapter: deepseekHarnessResource().runtime.adapter, locality: 'local', options },
    });

  it('applies defaults from the resource', () => {
    expect(parseRuntimeOptions(withOptions({}))).toEqual({
      provider: 'deepseek-official',
      model: 'deepseek-flash',
      patches: [],
    });
  });

  it('accepts every option', () => {
    const parsed = parseRuntimeOptions(
      withOptions({
        provider: 'p',
        model: 'm',
        reasoningEffort: 'high',
        maxTokens: 100,
        patches: ['/a.yml', '/b.yml'],
        piAiProviders: { x: { apiKeyEnv: 'X_KEY' } },
        timeoutMs: 5000,
      }),
    );
    expect(parsed).toEqual({
      provider: 'p',
      model: 'm',
      reasoningEffort: 'high',
      maxTokens: 100,
      patches: ['/a.yml', '/b.yml'],
      piAiProviders: { x: { apiKeyEnv: 'X_KEY' } },
      timeoutMs: 5000,
    });
  });

  it('requires a model when the kind does not supply one', () => {
    const resource = deepseekHarnessResource({
      kind: { type: 'agent', agent: 'deepseek-harness', interface: 'rpc' },
      runtime: { adapter: deepseekHarnessResource().runtime.adapter, locality: 'local' },
    });
    expect(() => parseRuntimeOptions(resource)).toThrow(
      expect.objectContaining({ code: 'CONFIGURATION_ERROR' }) as Error,
    );
  });

  it('falls back to kind.underlying.model', () => {
    const resource = deepseekHarnessResource({
      runtime: { adapter: deepseekHarnessResource().runtime.adapter, locality: 'local' },
    });
    expect(parseRuntimeOptions(resource).model).toBe('deepseek-flash');
  });

  it('preserves an explicitly persisted legacy model instead of silently migrating it', () => {
    expect(parseRuntimeOptions(withOptions({ model: 'deepseek-v4-flash' })).model).toBe(
      'deepseek-v4-flash',
    );
  });

  it.each([
    { provider: 3 },
    { provider: '' },
    { model: {} },
    { reasoningEffort: 1 },
    { maxTokens: '10' },
    { maxTokens: 1.5 },
    { maxTokens: 0 },
    { timeoutMs: -1 },
    { timeoutMs: Number.NaN },
    { patches: 'a.yml' },
    { patches: [1] },
    { patches: [''] },
    { piAiProviders: [] },
    { piAiProviders: { x: {} } },
    { piAiProviders: { x: { apiKeyEnv: 5 } } },
    { piAiProviders: { x: { apiKeyEnv: 'lower' } } },
    { piAiProviders: { 'Bad Name': { apiKeyEnv: 'OK' } } },
  ])('rejects invalid options %j', (options) => {
    expect(() => parseRuntimeOptions(withOptions(options))).toThrow(
      expect.objectContaining({ code: 'CONFIGURATION_ERROR' }) as Error,
    );
  });
});

describe('deepseekHarnessResource', () => {
  it('matches the documented descriptor', () => {
    const r = deepseekHarnessResource();
    expect(r.id).toBe('deepseek-harness');
    expect(r.runtime.adapter).toBe('deepseek-harness');
    expect(r.kind).toMatchObject({ type: 'agent', agent: 'deepseek-harness', interface: 'rpc' });
    expect(r.auth).toEqual({
      mode: 'api-key',
      credential: { source: 'env', name: 'DEEPSEEK_API_KEY' },
    });
    expect(r.dataLocality).toBe('third-party');
    expect(deepseekHarnessResource({ displayName: 'X' }).displayName).toBe('X');
  });
});

describe('keystore credentials (env, overlay and options)', () => {
  const KEYSTORE_VALUE = 'sk-keystore-value';
  const parentWithSameName: NodeJS.ProcessEnv = {
    PATH: '/usr/bin',
    DEEPSEEK_API_KEY: 'sk-parent-env-value',
    OTHER_PROVIDER_KEY: 'sk-parent-other',
    GH_TOKEN: 'ghp_secret',
  };
  const keystoreResource = deepseekHarnessResource({
    auth: { mode: 'api-key', credential: { source: 'keystore', name: 'DEEPSEEK_API_KEY' } },
  });

  it('puts the resolver value under the keystore name, never the parent env value', () => {
    const env = buildDshEnv(parentWithSameName, keystoreResource, {
      stateDir: '/s',
      resolveSecret: (name) => (name === 'DEEPSEEK_API_KEY' ? KEYSTORE_VALUE : undefined),
    });
    expect(env.DEEPSEEK_API_KEY).toBe(KEYSTORE_VALUE);
    expect(Object.values(env)).not.toContain('sk-parent-env-value');
    expect(env).not.toHaveProperty('GH_TOKEN');
  });

  it('does not satisfy a keystore reference from the parent env', () => {
    const missing = buildDshEnv(parentWithSameName, keystoreResource, {
      stateDir: '/s',
      resolveSecret: () => undefined,
    });
    expect(missing).not.toHaveProperty('DEEPSEEK_API_KEY');
    const noResolver = buildDshEnv(parentWithSameName, keystoreResource, { stateDir: '/s' });
    expect(noResolver).not.toHaveProperty('DEEPSEEK_API_KEY');
    const empty = buildDshEnv(parentWithSameName, keystoreResource, {
      stateDir: '/s',
      resolveSecret: () => '',
    });
    expect(empty).not.toHaveProperty('DEEPSEEK_API_KEY');
  });

  it('resolves keystore piAiProviders entries from the resolver and env entries from the env', () => {
    const env = buildDshEnv(parentWithSameName, deepseekHarnessResource(), {
      stateDir: '/s',
      piAiProviders: {
        stored: { keystore: 'OTHER_PROVIDER_KEY' },
        fromEnv: { apiKeyEnv: 'GH_TOKEN' },
      },
      resolveSecret: (name) => (name === 'OTHER_PROVIDER_KEY' ? KEYSTORE_VALUE : undefined),
    });
    expect(env.OTHER_PROVIDER_KEY).toBe(KEYSTORE_VALUE);
    expect(env.GH_TOKEN).toBe('ghp_secret');
    expect(env.DEEPSEEK_API_KEY).toBe('sk-parent-env-value'); // the env credential, unchanged
  });

  it('rejects the same variable requested from both sources', () => {
    expect(() =>
      buildDshEnv(parentWithSameName, deepseekHarnessResource(), {
        stateDir: '/s',
        piAiProviders: { stored: { keystore: 'DEEPSEEK_API_KEY' } },
        resolveSecret: () => KEYSTORE_VALUE,
      }),
    ).toThrow(/both the environment and the key store/);
  });

  it.each(['PATH', 'NODE_OPTIONS', 'DSH_HOME', 'DSH_AGENTS_HOME'])(
    'refuses a keystore name that would overwrite %s',
    (name) => {
      const resource = deepseekHarnessResource({
        auth: { mode: 'api-key', credential: { source: 'keystore', name } },
      });
      expect(() =>
        buildDshEnv(parentWithSameName, resource, {
          stateDir: '/s',
          resolveSecret: () => KEYSTORE_VALUE,
        }),
      ).toThrow(/collides/);
    },
  );

  it('never puts a value in a thrown error', () => {
    try {
      buildDshEnv(parentWithSameName, deepseekHarnessResource(), {
        stateDir: '/s',
        piAiProviders: { stored: { keystore: 'DEEPSEEK_API_KEY' } },
        resolveSecret: () => KEYSTORE_VALUE,
      });
      throw new Error('expected a throw');
    } catch (e) {
      expect(String((e as Error).message)).not.toContain(KEYSTORE_VALUE);
      expect(String((e as Error).message)).not.toContain('sk-parent-env-value');
    }
  });

  it('renders the variable NAME for keystore entries and never a value', () => {
    const yaml = renderPatchOverlay({
      piAiProviders: { anthropic: { keystore: 'ANTHROPIC_API_KEY' }, other: { apiKeyEnv: 'K2' } },
    });
    expect(yaml).toContain('      "anthropic":\n        apiKeyEnv: "ANTHROPIC_API_KEY"');
    expect(yaml).toContain('      "other":\n        apiKeyEnv: "K2"');
    expect(yaml).not.toContain('keystore');
  });

  it.each([
    ['both keys', { apiKeyEnv: 'A_KEY', keystore: 'A_KEY' }],
    ['neither key', {}],
    ['a lowercase keystore name', { keystore: 'lower' }],
    ['an over-long keystore name', { keystore: 'A'.repeat(129) }],
    ['a non-string keystore name', { keystore: 5 }],
  ])('overlay validation rejects %s', (_label, entry) => {
    expect(() => renderPatchOverlay({ piAiProviders: { ok: entry as never } })).toThrow(NexarError);
  });

  it('parses keystore piAiProviders options and rejects ambiguous or malformed ones', () => {
    const parse = (piAiProviders: unknown) =>
      parseRuntimeOptions(
        deepseekHarnessResource({
          runtime: {
            adapter: adapterId('deepseek-harness'),
            locality: 'local',
            options: { model: 'm', piAiProviders },
          },
        }),
      );
    expect(parse({ x: { keystore: 'X_KEY' } }).piAiProviders).toEqual({
      x: { keystore: 'X_KEY' },
    });
    expect(parse({ x: { apiKeyEnv: 'X_KEY' } }).piAiProviders).toEqual({
      x: { apiKeyEnv: 'X_KEY' },
    });
    for (const bad of [
      { x: { apiKeyEnv: 'X_KEY', keystore: 'X_KEY' } },
      { x: {} },
      { x: { keystore: 5 } },
      { x: { keystore: 'lower' } },
      { x: null },
    ]) {
      expect(() => parse(bad)).toThrow(NexarError);
    }
  });
});
