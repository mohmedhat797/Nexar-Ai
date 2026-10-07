import { spawn } from 'node:child_process';
import type { ChildProcess, SpawnOptions } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { OpenWorkerHttpClient } from './client.js';
import { OpenWorkerSupervisor } from './supervisor.js';
import type { OpenWorkerSupervisorOptions } from './supervisor.js';

const FAKE = fileURLToPath(new URL('./test/fake-openworker-server.mjs', import.meta.url));

let root: string;
let supervisors: OpenWorkerSupervisor[];
beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'ow-sup-'));
  supervisors = [];
});
afterEach(async () => {
  await Promise.all(supervisors.map((s) => s.stop()));
  await rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
});

interface Harness {
  readonly supervisor: OpenWorkerSupervisor;
  readonly stateDir: string;
  readonly spawned: {
    command: string;
    args: readonly string[];
    env: NodeJS.ProcessEnv;
    child: ChildProcess;
  }[];
}

/** Runs the fake server script in place of `openworker`; knobs are added after env capture. */
function harness(
  knobs: Record<string, string> = {},
  overrides: Partial<OpenWorkerSupervisorOptions> = {},
): Harness {
  const stateDir = join(root, 'state');
  const spawned: Harness['spawned'] = [];
  const supervisor = new OpenWorkerSupervisor({
    executable: 'openworker-server',
    versionExecutable: 'openworker',
    stateDir,
    parentPid: process.pid,
    env: {
      ...process.env,
      NEXAR_DESKTOP_SECRET: 'desktop-secret',
      ANTHROPIC_API_KEY: 'sk-ant-leak',
      OPENAI_API_KEY: 'sk-openai-leak',
    },
    startupTimeoutMs: 15_000,
    spawn: ((command: string, args: readonly string[], options: SpawnOptions) => {
      const child = spawn(process.execPath, [FAKE, ...args], {
        ...options,
        env: { ...options.env, ...knobs },
      });
      spawned.push({ command, args, env: { ...options.env }, child });
      return child;
    }) as unknown as typeof spawn,
    ...overrides,
  });
  supervisors.push(supervisor);
  return { supervisor, stateDir, spawned };
}

const jsonl = (path: string): Record<string, unknown>[] =>
  readFileSync(path, 'utf8')
    .trim()
    .split('\n')
    .map((line) => JSON.parse(line) as Record<string, unknown>);

describe('OpenWorkerSupervisor', () => {
  it('starts a private server, waits for health and is idempotent', async () => {
    const { supervisor, stateDir, spawned } = harness();
    expect(supervisor.client()).toBeUndefined();
    const [a, b] = await Promise.all([supervisor.start(), supervisor.start()]);
    expect(a).toEqual({ state: 'ready', version: '0.3.1', reason: 'OpenWorker is ready' });
    expect(b).toBe(a);
    expect(await supervisor.start()).toBe(a);
    expect(supervisor.status()).toBe(a);
    expect(supervisor.client()).toBeInstanceOf(OpenWorkerHttpClient);
    // One version probe plus one server: never a second server.
    expect(spawned.map((s) => s.args[0])).toEqual(['version', '--host']);
    const launch = jsonl(join(stateDir, 'launch.jsonl'));
    expect(launch).toHaveLength(1);
    const argv = launch[0]!['argv'] as string[];
    expect(argv.slice(0, 2)).toEqual(['--host', '127.0.0.1']);
    expect(argv[2]).toBe('--port');
    expect(Number(argv[3])).toBeGreaterThan(0);
  });

  it('launches with exactly the allowlisted environment', async () => {
    const { supervisor, stateDir, spawned } = harness();
    await supervisor.start();
    const server = spawned.find((s) => s.args[0] === '--host')!;
    const probe = spawned.find((s) => s.args[0] === 'version')!;
    const allowed = new Set([
      'PATH',
      'HOME',
      'USER',
      'LANG',
      'LC_ALL',
      'LC_CTYPE',
      'TERM',
      'DISPLAY',
      'WAYLAND_DISPLAY',
      'XDG_RUNTIME_DIR',
      'XDG_SESSION_TYPE',
      'XDG_CURRENT_DESKTOP',
      'DESKTOP_SESSION',
      'DBUS_SESSION_BUS_ADDRESS',
      'XDG_CONFIG_HOME',
      'XDG_DATA_HOME',
      'XDG_CACHE_HOME',
      'SystemRoot',
      'SystemDrive',
      'windir',
      'ComSpec',
      'PATHEXT',
      'USERNAME',
      'USERPROFILE',
      'APPDATA',
      'LOCALAPPDATA',
      'TEMP',
      'TMP',
      'COWORKER_STATE_DIR',
      'COWORKER_API_TOKEN',
      'COWORKER_EXIT_WITH_PARENT',
      'COWORKER_PARENT_PID',
      'COWORKER_STATE_LOCK',
    ]);
    expect(Object.keys(server.env).filter((key) => !allowed.has(key))).toEqual([]);
    expect(JSON.stringify(server.env)).not.toMatch(/desktop-secret|sk-ant-leak|sk-openai-leak/);
    expect(server.env['COWORKER_STATE_DIR']).toBe(stateDir);
    expect(server.env['COWORKER_API_TOKEN']).toMatch(/^[0-9a-f]{64}$/);
    expect(server.env['COWORKER_EXIT_WITH_PARENT']).toBe('1');
    expect(server.env['COWORKER_PARENT_PID']).toBe(String(process.pid));
    expect(server.env['COWORKER_STATE_LOCK']).toBe('strict');
    // The probe never sees the token or any server setting.
    expect(Object.keys(probe.env).filter((key) => key.startsWith('COWORKER_'))).toEqual([]);
    // The token never reaches argv or the status.
    expect(JSON.stringify(server.args)).not.toContain(server.env['COWORKER_API_TOKEN']!);
    expect(JSON.stringify(supervisor.status())).not.toContain(server.env['COWORKER_API_TOKEN']!);
  });

  it('uses a fresh token per launch', async () => {
    const first = harness();
    await first.supervisor.start();
    const token = first.spawned.find((s) => s.args[0] === '--host')!.env['COWORKER_API_TOKEN'];
    await first.supervisor.stop();
    await first.supervisor.start();
    const tokens = first.spawned
      .filter((s) => s.args[0] === '--host')
      .map((s) => s.env['COWORKER_API_TOKEN']);
    expect(tokens).toHaveLength(2);
    expect(tokens[1]).not.toBe(token);
  });

  it('public health is not authentication: protected mutations require the token', async () => {
    const { supervisor, spawned } = harness();
    await supervisor.start();
    const port = Number((jsonl(join(root, 'state', 'launch.jsonl'))[0]!['argv'] as string[])[3]);
    const wrong = new OpenWorkerHttpClient({ port, token: 'wrong' });
    expect(await wrong.health()).toBe(true);
    await expect(wrong.attachRoot('s1', root, false)).rejects.toMatchObject({
      code: 'INTEGRATION_UNAVAILABLE',
    });
    const right = new OpenWorkerHttpClient({
      port,
      token: spawned.find((s) => s.args[0] === '--host')!.env['COWORKER_API_TOKEN']!,
    });
    expect(await right.health()).toBe(true);
  });

  it('reports openworker-missing for a missing executable', async () => {
    const supervisor = new OpenWorkerSupervisor({
      executable: join(root, 'no-such-openworker-server'),
      stateDir: join(root, 'state'),
      parentPid: process.pid,
    });
    supervisors.push(supervisor);
    expect(await supervisor.start()).toEqual({
      state: 'openworker-missing',
      reason: 'OpenWorker is not installed',
    });
    expect(supervisor.client()).toBeUndefined();
  });

  it.each([
    '0.2.9',
    '0.3.0',
    '0.4.0',
    '1.0.0',
    'garbage',
    '',
    '0.3',
    '0.3.1.4',
    '0.3.1-rc.1',
    '00.3.1',
    '0.3.1 trailing',
  ])('reports unsupported-version for %s', async (version) => {
    const { supervisor, spawned } = harness({ FAKE_OW_VERSION: version });
    const status = await supervisor.start();
    expect(status.state).toBe('unsupported-version');
    expect(status.reason).toBe('OpenWorker version is not supported');
    expect(spawned.map((s) => s.args[0])).toEqual(['version']); // no server was started
  });

  it.each(['0.3.1', '0.3.2', '0.3.9'])(
    'accepts patch version %s inside the range',
    async (version) => {
      const { supervisor } = harness({ FAKE_OW_VERSION: version });
      expect(await supervisor.start()).toMatchObject({ state: 'ready', version });
    },
  );

  it('reports startup-failed within the bound when health never comes up', async () => {
    const { supervisor } = harness({ FAKE_OW_NEVER_READY: '1' }, { startupTimeoutMs: 600 });
    const started = Date.now();
    expect(await supervisor.start()).toMatchObject({ state: 'startup-failed' });
    expect(Date.now() - started).toBeLessThan(10_000);
    expect(supervisor.client()).toBeUndefined();
  });

  it('tolerates a slow start', async () => {
    const { supervisor } = harness({ FAKE_OW_START_DELAY_MS: '600' });
    expect(await supervisor.start()).toMatchObject({ state: 'ready' });
  });

  it('reports configuration-missing for unusable options', async () => {
    expect((await harness({}, { executable: '' }).supervisor.start()).state).toBe(
      'configuration-missing',
    );
    expect((await harness({}, { stateDir: 'relative' }).supervisor.start()).state).toBe(
      'configuration-missing',
    );
    expect((await harness({}, { parentPid: 0 }).supervisor.start()).state).toBe(
      'configuration-missing',
    );
  });

  it('sends provider keys in the request body only and never logs them', async () => {
    const log = vi.spyOn(console, 'log').mockImplementation(() => undefined);
    const err = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const { supervisor, stateDir, spawned } = harness();
    await supervisor.start();
    await supervisor.configureProviders([
      { provider: 'anthropic', apiKey: 'sk-ant-body-only' },
      { provider: 'openai', apiKey: 'sk-openai-body-only' },
    ]);
    const records = jsonl(join(stateDir, 'records.jsonl'));
    expect(records).toEqual([
      {
        kind: 'provider',
        body: { name: 'anthropic', fields: { api_key: 'sk-ant-body-only', base_url: '' } },
      },
      {
        kind: 'provider',
        body: { name: 'openai', fields: { api_key: 'sk-openai-body-only', base_url: '' } },
      },
    ]);
    const everywhereElse = JSON.stringify([
      spawned.map((s) => [s.args, s.env]),
      jsonl(join(stateDir, 'launch.jsonl')),
      supervisor.status(),
      log.mock.calls,
      err.mock.calls,
    ]);
    expect(everywhereElse).not.toMatch(/body-only/);
    log.mockRestore();
    err.mockRestore();
  });

  it('sends a loopback base_url with the entry and refuses any other', async () => {
    const { supervisor, stateDir } = harness();
    await supervisor.start();
    await supervisor.configureProviders([
      { provider: 'openai', apiKey: 'token-body-only', baseUrl: 'http://127.0.0.1:41234/v1' },
    ]);
    expect(jsonl(join(stateDir, 'records.jsonl'))).toEqual([
      {
        kind: 'provider',
        body: {
          name: 'openai',
          fields: { api_key: 'token-body-only', base_url: 'http://127.0.0.1:41234/v1' },
        },
      },
    ]);
    for (const baseUrl of [
      'https://127.0.0.1:41234/v1',
      'http://localhost:41234/v1',
      'http://127.0.0.1/v1',
      'http://127.0.0.1:0/v1',
      'http://127.0.0.1:41234/v1/',
      'http://127.0.0.1:41234/v2',
      'http://127.0.0.1:41234@evil.example/v1',
      'http://127.0.0.1:123456/v1',
      '',
    ]) {
      await expect(
        supervisor.configureProviders([{ provider: 'openai', apiKey: 'k', baseUrl }]),
      ).rejects.toMatchObject({ code: 'VALIDATION_ERROR' });
    }
    expect(jsonl(join(stateDir, 'records.jsonl'))).toHaveLength(1);
  });

  it('treats an upstream { ok: false } answer as a failed provider configuration', async () => {
    const { supervisor } = harness({ FAKE_OW_REFUSE_PROVIDERS: '1' });
    await supervisor.start();
    await expect(
      supervisor.configureProviders([{ provider: 'openai', apiKey: 'sk-refused' }]),
    ).rejects.toMatchObject({ code: 'CONFIGURATION_ERROR' });
    await expect(supervisor.removeProvider('openai')).rejects.toMatchObject({
      code: 'CONFIGURATION_ERROR',
    });
  });

  it('removes a stored provider profile by name', async () => {
    const { supervisor, stateDir } = harness();
    await supervisor.start();
    await supervisor.removeProvider('openai');
    expect(jsonl(join(stateDir, 'records.jsonl'))).toEqual([
      { kind: 'provider-removed', body: { name: 'openai' } },
    ]);
    await expect(supervisor.removeProvider('../x')).rejects.toMatchObject({
      code: 'VALIDATION_ERROR',
    });
  });

  it('reports provider failures by code only', async () => {
    const { supervisor } = harness({ FAKE_OW_FAIL_PROVIDERS: '1' });
    await supervisor.start();
    const failure = await supervisor
      .configureProviders([{ provider: 'anthropic', apiKey: 'sk-ant-secret-value' }])
      .catch((error: unknown) => error as { code?: string; message: string });
    expect(failure).toMatchObject({ code: 'CONFIGURATION_ERROR' });
    expect(JSON.stringify(failure)).not.toContain('sk-ant-secret-value');
    expect((failure as Error).message).not.toContain('sk-ant-secret-value');
  });

  it('validates provider entries and requires a ready server', async () => {
    const { supervisor } = harness();
    await expect(
      supervisor.configureProviders([{ provider: 'anthropic', apiKey: 'k' }]),
    ).rejects.toMatchObject({ code: 'INTEGRATION_UNAVAILABLE' });
    await supervisor.start();
    await expect(
      supervisor.configureProviders([{ provider: '../x', apiKey: 'k' }]),
    ).rejects.toMatchObject({ code: 'VALIDATION_ERROR' });
    await expect(
      supervisor.configureProviders([{ provider: 'anthropic', apiKey: '' }]),
    ).rejects.toMatchObject({ code: 'VALIDATION_ERROR' });
  });

  it('stop() during the health wait ends the starting server and never reports ready', async () => {
    const { supervisor, spawned } = harness({ FAKE_OW_NEVER_READY: '1' });
    const starting = supervisor.start();
    await vi.waitFor(() => expect(spawned.some((s) => s.args[0] === '--host')).toBe(true), {
      timeout: 10_000,
    });
    const server = spawned.find((s) => s.args[0] === '--host')!.child;
    const stoppedAt = Date.now();
    await supervisor.stop();
    expect(await starting).toMatchObject({ state: 'startup-failed' });
    // Abandoned at once, not after the 15 s startup bound.
    expect(Date.now() - stoppedAt).toBeLessThan(5_000);
    expect(supervisor.client()).toBeUndefined();
    await vi.waitFor(
      () => expect(server.exitCode !== null || server.signalCode !== null).toBe(true),
      {
        timeout: 5_000,
      },
    );
  });

  it('stop() during the version probe never launches a server', async () => {
    const versions: ChildProcess[] = [];
    const { supervisor, spawned } = harness(
      {},
      {
        spawn: ((command: string, args: readonly string[], options: SpawnOptions) => {
          // A version probe that would answer only after the test: stop() must not wait for it.
          const child = spawn(
            process.execPath,
            ['-e', "setTimeout(() => console.log('openworker 0.3.1'), 8000)"],
            options,
          );
          if (args[0] === 'version') versions.push(child);
          spawned.push({ command, args, env: { ...options.env }, child });
          return child;
        }) as unknown as typeof spawn,
      },
    );
    const starting = supervisor.start();
    await vi.waitFor(() => expect(versions).toHaveLength(1), { timeout: 10_000 });
    const stoppedAt = Date.now();
    await supervisor.stop();
    expect(await starting).toMatchObject({ state: 'startup-failed' });
    expect(Date.now() - stoppedAt).toBeLessThan(5_000);
    expect(spawned.filter((s) => s.args[0] === '--host')).toHaveLength(0);
    const probe = versions[0]!;
    await vi.waitFor(
      () => expect(probe.exitCode !== null || probe.signalCode !== null).toBe(true),
      {
        timeout: 5_000,
      },
    );
  });

  it('stop() ends the server and the client', async () => {
    const { supervisor, spawned } = harness();
    await supervisor.start();
    const port = Number((jsonl(join(root, 'state', 'launch.jsonl'))[0]!['argv'] as string[])[3]);
    const token = spawned.find((s) => s.args[0] === '--host')!.env['COWORKER_API_TOKEN']!;
    await supervisor.stop();
    expect(supervisor.client()).toBeUndefined();
    expect(supervisor.status().state).not.toBe('ready');
    let healthy = true;
    for (let i = 0; i < 50 && healthy; i++) {
      healthy = await new OpenWorkerHttpClient({ port, token }).health();
      if (healthy) await new Promise((r) => setTimeout(r, 100));
    }
    expect(healthy).toBe(false);
    expect(existsSync(join(root, 'state'))).toBe(true);
  });
});
