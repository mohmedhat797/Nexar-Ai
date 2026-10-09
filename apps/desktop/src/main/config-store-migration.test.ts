import { mkdir, mkdtemp, readFile, readdir, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { parseConfig } from '@nexar/core';
import type { Logger } from '@nexar/contracts';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { CHANNELS } from '../shared/channels.js';
import { ConfigStore, firstRunConfig, type RawConfig } from './config-store.js';
import { addProject, createHarness, type Harness } from './test-harness.js';

/** The exact shape earlier versions wrote on first run. */
function legacyConfig(): RawConfig {
  return {
    version: 1,
    resources: [
      {
        id: 'local-echo',
        displayName: 'Local Echo',
        kind: { type: 'model', provider: 'nexar', model: 'echo', access: 'local' },
        capabilities: [
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
        ],
        runtime: { adapter: 'echo', locality: 'local' },
        auth: { mode: 'none' },
        cost: { model: 'free' },
        dataLocality: 'local',
      },
    ],
    routing: { policy: 'resource-intelligence', defaultResourceId: 'local-echo' },
    telemetry: { jsonlPath: '.nexar/telemetry.jsonl' },
    discovery: { enabled: true },
    projects: [],
  };
}

let dir: string;
let path: string;
let logs: string[];
const logger: Logger = (() => {
  const record = (msg: string): void => void logs.push(msg);
  const l: Logger = { debug: record, info: record, warn: record, error: record, child: () => l };
  return l;
})();

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'nexar-config-store-'));
  path = join(dir, 'nexar.config.json');
  logs = [];
});
afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

const backups = async (): Promise<string[]> =>
  (await readdir(dir)).filter((name) => name.startsWith('nexar.config.json.bak-'));

describe('firstRunConfig', () => {
  it('configures no resource and no default, and is a valid config', () => {
    const config = firstRunConfig();
    expect(config['resources']).toEqual([]);
    expect(config['routing']).toEqual({ policy: 'resource-intelligence' });
    const parsed = parseConfig(config, 'test', { baseDir: dir });
    expect(parsed.resources).toEqual([]);
    expect(parsed.routing.defaultResourceId).toBeUndefined();
    expect(parsed.discovery.enabled).toBe(true);
  });

  it('is what ensure() writes when there is no config', async () => {
    await new ConfigStore(path, logger).ensure();
    expect(JSON.parse(await readFile(path, 'utf8'))).toEqual(firstRunConfig());
    expect(await backups()).toEqual([]);
  });
});

describe('echo default migration', () => {
  const store = (): ConfigStore =>
    new ConfigStore(path, logger, () => new Date('2026-10-04T12:00:00.123Z'));

  it('removes the old echo default after writing an exclusive 0600 backup, and is idempotent', async () => {
    const original = JSON.stringify(legacyConfig(), null, 2) + '\n';
    await writeFile(path, original);
    await store().ensure();

    const migrated = JSON.parse(await readFile(path, 'utf8')) as RawConfig;
    expect(migrated['resources']).toEqual([]);
    expect(migrated['routing']).toEqual({ policy: 'resource-intelligence' });
    expect(migrated['discovery']).toEqual({ enabled: true });
    expect(logs).toEqual(['config migrated: echo default removed']);

    expect(await backups()).toEqual(['nexar.config.json.bak-20261004T120000123Z']);
    const backup = join(dir, 'nexar.config.json.bak-20261004T120000123Z');
    expect(await readFile(backup, 'utf8')).toBe(original);
    if (process.platform !== 'win32') expect((await stat(backup)).mode & 0o777).toBe(0o600);

    const afterFirst = await readFile(path, 'utf8');
    await store().ensure();
    expect(await readFile(path, 'utf8')).toBe(afterFirst);
    expect(await backups()).toHaveLength(1);
    expect(logs).toHaveLength(1);
  });

  it('keeps the config and logs a warning when the backup cannot be written exclusively', async () => {
    const original = JSON.stringify(legacyConfig());
    await writeFile(path, original);
    await writeFile(join(dir, 'nexar.config.json.bak-20261004T120000123Z'), 'existing');
    await store().ensure();
    expect(await readFile(path, 'utf8')).toBe(original);
    expect(await readFile(join(dir, 'nexar.config.json.bak-20261004T120000123Z'), 'utf8')).toBe(
      'existing',
    );
    expect(logs).toEqual(['config migration skipped: echo default kept']);
  });

  const edits: Record<string, (raw: RawConfig) => void> = {
    'a different default': (raw) => {
      raw['routing'] = { policy: 'resource-intelligence', defaultResourceId: 'other' };
      (raw['resources'] as Record<string, unknown>[]).push({
        ...(raw['resources'] as Record<string, unknown>[])[0],
        id: 'other',
      });
    },
    'an extra resource': (raw) => {
      (raw['resources'] as Record<string, unknown>[]).push({
        ...(raw['resources'] as Record<string, unknown>[])[0],
        id: 'other',
      });
    },
    'an edited echo descriptor': (raw) => {
      (raw['resources'] as Record<string, unknown>[])[0]!['displayName'] = 'My echo';
    },
    'no default': (raw) => {
      raw['routing'] = { policy: 'resource-intelligence' };
    },
  };
  for (const [name, edit] of Object.entries(edits)) {
    it(`leaves ${name} untouched`, async () => {
      const raw = legacyConfig();
      edit(raw);
      const text = JSON.stringify(raw, null, 2);
      await writeFile(path, text);
      await store().ensure();
      expect(await readFile(path, 'utf8')).toBe(text);
      expect(await backups()).toEqual([]);
      expect(logs).toEqual([]);
    });
  }

  it('leaves an unreadable config for the normal read error', async () => {
    await mkdir(dir, { recursive: true });
    await writeFile(path, '{not json');
    await store().ensure();
    expect(await readFile(path, 'utf8')).toBe('{not json');
    expect(await backups()).toEqual([]);
  });
});

describe('Auto routing with the first-run config', () => {
  let h: Harness;
  beforeEach(async () => {
    h = await createHarness();
  });
  afterEach(async () => {
    await h.cleanup();
  });

  async function useConfig(raw: RawConfig): Promise<void> {
    await h.config.write(raw);
    await h.engine.reload();
  }
  const run = (projectId: string) =>
    h.call<{ decision: { selected: { resourceId: string } } }>(CHANNELS.tasksRun, {
      requestId: 'req-first-run',
      projectId,
      kind: 'general',
      prompt: 'hello',
    });

  it('surfaces NO_ELIGIBLE_RESOURCE with reasons when nothing is configured or discovered', async () => {
    await useConfig({ ...firstRunConfig() });
    const id = await addProject(h);
    const result = await run(id);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.code).toBe('NO_ELIGIBLE_RESOURCE');
    const explained = await h.call<{ outcome: string; reasons?: unknown }>(CHANNELS.routeExplain, {
      projectId: id,
      kind: 'general',
      prompt: 'hello',
    });
    expect(explained.ok && explained.value.outcome).toBe('no-eligible-resource');
    expect(JSON.stringify(explained)).not.toContain('local-echo');
  });

  it('selects an available native-agent resource without any default', async () => {
    const native = {
      id: 'claude-code',
      displayName: 'Claude Code (fake)',
      kind: { type: 'agent', agent: 'claude-code', interface: 'cli' },
      capabilities: ['text-generation', 'reasoning', 'knowledge-work'],
      // The echo adapter stands in for the native runtime: only routing is under test.
      runtime: { adapter: 'echo', locality: 'local' },
      auth: { mode: 'none' },
      cost: { model: 'subscription' },
      dataLocality: 'third-party',
    };
    await useConfig({ ...firstRunConfig(), resources: [native] });
    const id = await addProject(h);
    const result = await run(id);
    expect(result.ok && result.value.decision.selected.resourceId).toBe('claude-code');
  });
});
