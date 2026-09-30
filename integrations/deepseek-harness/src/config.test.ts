import { describe, expect, it } from 'vitest';
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

  it('passes only the allowlist, the resource credential and DSH_HOME', () => {
    const env = buildDshEnv(parent, deepseekHarnessResource(), { stateDir: '/state' });
    expect(Object.keys(env).sort()).toEqual(
      [
        'DEEPSEEK_API_KEY',
        'DSH_HOME',
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
    expect(env.DSH_HOME).toBe('/state/home');
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
    expect(Object.keys(env).sort()).toEqual(['DSH_HOME', 'PATH']);
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
      model: 'deepseek-v4-flash',
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
    expect(parseRuntimeOptions(resource).model).toBe('deepseek-v4-flash');
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
