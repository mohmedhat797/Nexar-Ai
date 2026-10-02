import { existsSync } from 'node:fs';
import { mkdtemp, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { DEFAULT_DISCOVERY_CONFIG } from '@nexar/core';
import { adapterId, resourceId } from '@nexar/contracts';
import type { ResourceDescriptor, SecretResolver } from '@nexar/contracts';
import { noopLogger } from '@nexar/telemetry';
import {
  builtinEngineeringPlansDir,
  builtinWorkflowsDir,
  compose,
  createAdapters,
  discoverySources,
  loadHostConfig,
  nexarStateDir,
  stateBaseDir,
  type HostEnvironment,
} from './index.js';

let cwd: string;
let host: HostEnvironment;

beforeEach(async () => {
  cwd = await realpath(await mkdtemp(join(tmpdir(), 'nexar-host-')));
  host = { env: { PATH: '' }, cwd };
});

afterEach(async () => {
  await rm(cwd, { recursive: true, force: true });
});

describe('compose', () => {
  it('builds a runtime with the built-in default config and the echo resource', async () => {
    const loaded = await loadHostConfig(host, undefined);
    expect(loaded.source).toBe('default');
    const composition = await compose(loaded, host, noopLogger);
    expect(composition.runtime.registry.list().map((r) => r.id)).toContain('local-echo');
    expect(composition.discovery).toBeUndefined();
    expect(composition.quotaSource).toBeDefined();
  });
});

describe('createAdapters', () => {
  const NAME = 'DEEPSEEK_API_KEY';
  const VALUE = 'sk-host-secret-value';
  const signal = new AbortController().signal;

  function keystoreResource(adapter: string): ResourceDescriptor {
    return {
      id: resourceId(`ks-${adapter}`),
      displayName: adapter,
      kind: { type: 'agent', agent: adapter, interface: 'rpc' },
      capabilities: ['text-generation'],
      runtime: { adapter: adapterId(adapter), locality: 'local' },
      auth: { mode: 'api-key', credential: { source: 'keystore', name: NAME } },
      cost: { model: 'unknown' },
      dataLocality: 'local',
    };
  }

  /** Own enumerable fields (one level) of an adapter that hold the given function. */
  function holds(adapter: object, fn: unknown): boolean {
    return Object.values(adapter).some((v) => v === fn);
  }

  it('hands the resolver to the pi and deepseek-harness adapters only', () => {
    const resolveSecret: SecretResolver = () => VALUE;
    const adapters = createAdapters(host, cwd, { resolveSecret });
    const holders = adapters.filter((a) => holds(a, resolveSecret)).map((a) => String(a.id));
    expect(holders.sort()).toEqual(['deepseek-harness', 'pi']);
    // no adapter keeps the resolver in a nested options object either
    for (const adapter of adapters) {
      if (holders.includes(String(adapter.id))) continue;
      const nested = Object.values(adapter).filter(
        (v): v is object => typeof v === 'object' && v !== null,
      );
      expect(nested.some((v) => holds(v, resolveSecret))).toBe(false);
    }
  });

  it('gives no adapter a resolver by default (the CLI)', () => {
    const resolveSecret: SecretResolver = () => VALUE;
    expect(createAdapters(host, cwd).some((a) => holds(a, resolveSecret))).toBe(false);
  });

  it('lets the resolved key authenticate a keystore resource on dsh', async () => {
    const asked: string[] = [];
    const resolveSecret: SecretResolver = (name) => {
      asked.push(name);
      return VALUE;
    };
    const adapters = createAdapters(host, cwd, { resolveSecret });
    const dsh = adapters.find((a) => String(a.id) === 'deepseek-harness');
    expect((await dsh?.probe(keystoreResource('deepseek-harness'), signal))?.auth).toBe(
      'authenticated',
    );
    expect(asked).toEqual([NAME]);
  });

  it('reports a keystore resource as unauthenticated without a resolver', async () => {
    const dsh = createAdapters(host, cwd).find((a) => String(a.id) === 'deepseek-harness');
    expect((await dsh?.probe(keystoreResource('deepseek-harness'), signal))?.auth).toBe(
      'unauthenticated',
    );
  });
});

describe('compose with a secret resolver', () => {
  it('accepts a resolver and still builds the runtime', async () => {
    const loaded = await loadHostConfig(host, undefined);
    const composition = await compose(loaded, host, noopLogger, { resolveSecret: () => undefined });
    expect(composition.runtime.registry.list().map((r) => r.id)).toContain('local-echo');
  });
});

describe('loadHostConfig', () => {
  it('prefers an explicit path, then NEXAR_CONFIG_PATH', async () => {
    const file = join(cwd, 'custom.json');
    await writeFile(file, JSON.stringify({ version: 1, resources: [] }));
    expect((await loadHostConfig(host, file)).source).toBe('explicit');
    const viaEnv = await loadHostConfig({ ...host, env: { NEXAR_CONFIG_PATH: file } }, undefined);
    expect(viaEnv).toMatchObject({ source: 'env', path: file });
  });
});

describe('discoverySources', () => {
  it('lists every source and disables nothing for enabled config with endpoints', () => {
    const config = {
      ...DEFAULT_DISCOVERY_CONFIG,
      piCatalog: { enabled: true, providers: ['x'], maxModels: 5 },
      localEndpoints: {
        enabled: true,
        endpoints: [{ id: 'o', kind: 'ollama' as const, baseUrl: 'http://127.0.0.1:11434' }],
      },
    };
    const { sources, disabled } = discoverySources(config, host.env);
    expect(sources).toHaveLength(6);
    expect(disabled).toEqual([]);
  });

  it('honours disabled sources', () => {
    const config = {
      ...DEFAULT_DISCOVERY_CONFIG,
      cli: { enabled: false },
    };
    const { sources, disabled } = discoverySources(config, host.env);
    // 4 CLI sources + pi catalog (off by default) + local endpoints (none listed).
    expect(disabled).toHaveLength(6);
    expect(new Set(disabled)).toEqual(new Set(sources.map((s) => s.id)));
  });
});

describe('state directories', () => {
  it('uses the cwd for the built-in default config', async () => {
    const loaded = await loadHostConfig(host, undefined);
    expect(stateBaseDir(loaded, host)).toBe(cwd);
    expect(nexarStateDir(loaded, host)).toBe(join(cwd, '.nexar'));
  });

  it('uses the config file directory for a file config', async () => {
    const dir = join(cwd, 'conf');
    const file = join(dir, 'nexar.json');
    await import('node:fs/promises').then((fs) => fs.mkdir(dir));
    await writeFile(file, JSON.stringify({ version: 1, resources: [] }));
    const loaded = await loadHostConfig(host, file);
    expect(stateBaseDir(loaded, host)).toBe(dir);
    expect(nexarStateDir(loaded, host)).toBe(join(dir, '.nexar'));
  });
});

describe('builtin directories', () => {
  it('finds the shipped workflows and engineering plans', () => {
    expect(existsSync(join(builtinWorkflowsDir(host), 'solution-proposal'))).toBe(true);
    expect(existsSync(join(builtinEngineeringPlansDir(host), 'implement-review'))).toBe(true);
  });

  it('honours the environment overrides, resolved against the cwd', () => {
    const env = { NEXAR_WORKFLOWS_DIR: 'wf', NEXAR_ENGINEERING_PLANS_DIR: '/abs/plans' };
    expect(builtinWorkflowsDir({ env, cwd })).toBe(resolve(cwd, 'wf'));
    expect(builtinEngineeringPlansDir({ env, cwd })).toBe(resolve(cwd, '/abs/plans'));
  });

  it('ignores empty overrides', () => {
    const env = { NEXAR_WORKFLOWS_DIR: '' };
    expect(builtinWorkflowsDir({ env, cwd })).toBe(builtinWorkflowsDir(host));
  });
});
