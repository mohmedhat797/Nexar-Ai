import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { NexarError } from '@nexar/contracts';
import { defaultConfig, loadConfig, parseConfig } from './config.js';

const echoJson = {
  id: 'local-echo',
  displayName: 'Local Echo',
  kind: { type: 'model', provider: 'nexar', model: 'echo', access: 'local' },
  capabilities: ['text-generation'],
  runtime: { adapter: 'echo', locality: 'local' },
  auth: { mode: 'none' },
  cost: { model: 'free' },
  dataLocality: 'local',
};

const apiResource = {
  ...echoJson,
  id: 'remote-model',
  kind: { type: 'model', provider: 'acme', model: 'm1', access: 'api' },
  runtime: { adapter: 'acme', locality: 'remote' },
  auth: { mode: 'api-key', credential: { source: 'env', name: 'ACME_API_KEY' } },
  cost: {
    model: 'per-token',
    currency: 'USD',
    inputPerMillionTokens: 1,
    outputPerMillionTokens: 2,
  },
  dataLocality: 'third-party',
};

function config(overrides: Record<string, unknown> = {}) {
  return { version: 1, resources: [echoJson], ...overrides };
}

function message(fn: () => unknown): string {
  try {
    fn();
  } catch (e) {
    expect(e).toBeInstanceOf(NexarError);
    expect(e).toMatchObject({ code: 'CONFIGURATION_ERROR' });
    return (e as Error).message;
  }
  throw new Error('expected parseConfig to throw');
}

describe('parseConfig', () => {
  it('accepts explicit review dimensions without changing the legacy resource default', () => {
    const parsed = parseConfig(
      config({
        projects: [
          {
            id: 'review-project',
            displayName: 'Review project',
            roots: ['work'],
            engineering: {
              repository: 'repo',
              reviewDimensions: { connection: 'required', provider: 'preferred' },
            },
          },
        ],
      }),
      'test',
    );
    expect(parsed.projects[0]?.engineering?.reviewDimensions).toEqual({
      connection: 'required',
      provider: 'preferred',
    });
    expect(parsed.projects[0]?.engineering?.reviewDiversity).toBe('preferred');
  });
  it.each([{ host: 'required' }, {}, { provider: 'optional' }, { resource: 'required' }])(
    'rejects unsupported, empty or contradictory project review dimensions %j',
    (reviewDimensions) => {
      expect(() =>
        parseConfig(
          config({
            projects: [
              {
                id: 'review-project',
                displayName: 'Review project',
                roots: ['work'],
                engineering: { repository: 'repo', reviewDiversity: 'preferred', reviewDimensions },
              },
            ],
          }),
          'test',
        ),
      ).toThrow(expect.objectContaining({ code: 'CONFIGURATION_ERROR' }));
    },
  );
  it('accepts a valid config and merges task-kind overrides over the defaults', () => {
    const parsed = parseConfig(
      config({
        resources: [echoJson, apiResource],
        routing: {
          policy: 'deterministic',
          defaultResourceId: 'local-echo',
          taskKinds: {
            coding: { requiredCapabilities: ['coding'], preferredResourceIds: ['remote-model'] },
          },
        },
        telemetry: { jsonlPath: '.nexar/telemetry.jsonl' },
      }),
      'test',
    );
    expect(parsed.resources.map((r) => r.id)).toEqual(['local-echo', 'remote-model']);
    expect(parsed.routing.defaultResourceId).toBe('local-echo');
    expect(parsed.routing.taskKinds['coding']).toEqual({
      requiredCapabilities: ['coding'],
      preferredResourceIds: ['remote-model'],
    });
    expect(parsed.routing.taskKinds['general']).toBeDefined();
    expect(parsed.telemetry.jsonlPath).toBe('.nexar/telemetry.jsonl');
  });

  it('applies defaults when routing/telemetry are omitted', () => {
    const parsed = parseConfig(config(), 'test');
    expect(parsed.routing.defaultResourceId).toBeUndefined();
    expect(parsed.telemetry).toEqual({});
  });

  it('rejects unknown keys at any level, naming the path', () => {
    expect(message(() => parseConfig(config({ extra: 1 }), 'test'))).toContain('extra');
    const nested = config({ resources: [{ ...echoJson, cost: { model: 'free', price: 1 } }] });
    expect(message(() => parseConfig(nested, 'test'))).toContain('resources.0.cost');
  });

  it('rejects inline secrets', () => {
    const inline = {
      ...apiResource,
      auth: { mode: 'api-key', credential: { source: 'env', name: 'X', apiKey: 'sk-abc' } },
    };
    expect(message(() => parseConfig(config({ resources: [inline] }), 'test'))).not.toContain(
      'sk-abc',
    );
    const topLevel = { ...apiResource, apiKey: 'sk-abc' };
    expect(() => parseConfig(config({ resources: [topLevel] }), 'test')).toThrow(NexarError);
    const literal = { ...apiResource, auth: { mode: 'api-key', credential: 'sk-abc' } };
    expect(() => parseConfig(config({ resources: [literal] }), 'test')).toThrow(NexarError);
    const valueSource = {
      ...apiResource,
      auth: { mode: 'api-key', credential: { source: 'value', value: 'sk-abc' } },
    };
    expect(() => parseConfig(config({ resources: [valueSource] }), 'test')).toThrow(NexarError);
  });

  it('rejects malformed env var names', () => {
    const bad = {
      ...apiResource,
      auth: { mode: 'api-key', credential: { source: 'env', name: 'sk-abc123' } },
    };
    expect(() => parseConfig(config({ resources: [bad] }), 'test')).toThrow(NexarError);
    const lower = { ...bad, auth: { mode: 'api-key', credential: { source: 'env', name: 'key' } } };
    expect(() => parseConfig(config({ resources: [lower] }), 'test')).toThrow(NexarError);
  });

  it('accepts runtime-managed credentials', () => {
    const managed = {
      ...apiResource,
      auth: {
        mode: 'subscription',
        credential: { source: 'runtime-managed', description: 'logged in via the vendor CLI' },
      },
    };
    expect(parseConfig(config({ resources: [managed] }), 'test').resources).toHaveLength(1);
  });

  describe('keystore credentials', () => {
    const withCredential = (credential: unknown) => ({
      ...apiResource,
      auth: { mode: 'api-key', credential },
    });
    const parse = (credential: unknown) =>
      parseConfig(config({ resources: [withCredential(credential)] }), 'test');

    it('accepts keystore references with valid names', () => {
      expect(parse({ source: 'keystore', name: 'DEEPSEEK_API_KEY' }).resources).toHaveLength(1);
      expect(parse({ source: 'keystore', name: 'A'.repeat(128) }).resources).toHaveLength(1);
    });

    it.each([
      ['lowercase', { source: 'keystore', name: 'deepseek_key' }],
      ['empty', { source: 'keystore', name: '' }],
      ['leading digit', { source: 'keystore', name: '1KEY' }],
      ['over 128 characters', { source: 'keystore', name: 'A'.repeat(129) }],
      ['extra keys', { source: 'keystore', name: 'KEY', value: 'sk-abc' }],
      ['missing name', { source: 'keystore' }],
    ])('rejects keystore references with %s', (_label, credential) => {
      expect(() => parse(credential)).toThrow(NexarError);
    });
  });

  describe('connection credentials', () => {
    const withCredential = (credential: unknown) => ({
      ...apiResource,
      auth: { mode: 'subscription', credential },
    });
    const parse = (credential: unknown) =>
      parseConfig(config({ resources: [withCredential(credential)] }), 'test');

    it('accepts only the ChatGPT plan connection', () => {
      expect(parse({ source: 'connection', name: 'chatgpt-plan' }).resources).toHaveLength(1);
    });

    it.each([
      ['another connection name', { source: 'connection', name: 'other' }],
      ['an uppercase name', { source: 'connection', name: 'CHATGPT_PLAN' }],
      ['extra keys', { source: 'connection', name: 'chatgpt-plan', value: 'x' }],
      ['a missing name', { source: 'connection' }],
    ])('rejects %s', (_label, credential) => {
      expect(() => parse(credential)).toThrow(NexarError);
    });
  });
  it('rejects dangling references and duplicates', () => {
    const dangling = config({ routing: { policy: 'deterministic', defaultResourceId: 'nope' } });
    expect(message(() => parseConfig(dangling, 'test'))).toContain('nope');
    const preferred = config({
      routing: {
        policy: 'deterministic',
        taskKinds: { coding: { requiredCapabilities: [], preferredResourceIds: ['ghost'] } },
      },
    });
    expect(message(() => parseConfig(preferred, 'test'))).toContain('ghost');
    expect(
      message(() => parseConfig(config({ resources: [echoJson, echoJson] }), 'test')),
    ).toContain('duplicate');
  });

  it('rejects invalid ids and unsupported versions', () => {
    const badId = config({ resources: [{ ...echoJson, id: 'Bad Id' }] });
    expect(message(() => parseConfig(badId, 'test'))).toContain('resource id');
    expect(() => parseConfig({ version: 2, resources: [] }, 'test')).toThrow(NexarError);
  });
});

describe('defaultConfig', () => {
  it('contains only the echo resource as default', () => {
    const cfg = defaultConfig();
    expect(cfg.resources.map((r) => r.id)).toEqual(['local-echo']);
    expect(cfg.routing.defaultResourceId).toBe('local-echo');
  });
});

describe('loadConfig', () => {
  let dir: string;
  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'nexar-config-'));
  });
  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  const write = async (name: string, resourceId: string): Promise<string> => {
    const path = join(dir, name);
    await mkdir(dir, { recursive: true });
    await writeFile(path, JSON.stringify(config({ resources: [{ ...echoJson, id: resourceId }] })));
    return path;
  };

  it('prefers explicitPath over env and cwd', async () => {
    const explicit = await write('explicit.json', 'from-explicit');
    const envPath = await write('env.json', 'from-env');
    await write('nexar.config.json', 'from-cwd');
    const loaded = await loadConfig({
      explicitPath: explicit,
      env: { NEXAR_CONFIG_PATH: envPath },
      cwd: dir,
    });
    expect(loaded.source).toBe('explicit');
    expect(loaded.path).toBe(explicit);
    expect(loaded.config.resources[0]?.id).toBe('from-explicit');
  });

  it('prefers NEXAR_CONFIG_PATH over cwd', async () => {
    const envPath = await write('env.json', 'from-env');
    await write('nexar.config.json', 'from-cwd');
    const loaded = await loadConfig({ env: { NEXAR_CONFIG_PATH: envPath }, cwd: dir });
    expect(loaded.source).toBe('env');
    expect(loaded.config.resources[0]?.id).toBe('from-env');
  });

  it('falls back to <cwd>/nexar.config.json', async () => {
    await write('nexar.config.json', 'from-cwd');
    const loaded = await loadConfig({ env: {}, cwd: dir });
    expect(loaded.source).toBe('cwd');
    expect(loaded.path).toBe(join(dir, 'nexar.config.json'));
  });

  it('falls back to the built-in default', async () => {
    const loaded = await loadConfig({ env: {}, cwd: dir });
    expect(loaded.source).toBe('default');
    expect(loaded.path).toBeUndefined();
    expect(loaded.config.resources[0]?.id).toBe('local-echo');
  });

  it('errors on a missing explicit file, invalid JSON, and an invalid cwd config', async () => {
    await expect(
      loadConfig({ explicitPath: join(dir, 'missing.json'), env: {} }),
    ).rejects.toMatchObject({ code: 'CONFIGURATION_ERROR' });
    await writeFile(join(dir, 'nexar.config.json'), '{ not json');
    await expect(loadConfig({ env: {}, cwd: dir })).rejects.toMatchObject({
      code: 'CONFIGURATION_ERROR',
    });
    await writeFile(join(dir, 'nexar.config.json'), '{"version":1,"resources":[],"oops":true}');
    await expect(loadConfig({ env: {}, cwd: dir })).rejects.toMatchObject({
      code: 'CONFIGURATION_ERROR',
    });
  });
});
