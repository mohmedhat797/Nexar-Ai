import { execFileSync } from 'node:child_process';
import type { spawn } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, realpathSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { NexarError } from '@nexar/contracts';
import { COWORK_PROFILE } from '../profiles.js';
import { PARENT_ENV_ALLOWLIST } from '../runtime/resolve.js';
import { makeLogger, makeTempDir } from '../test/support.js';
import type { FakeRecord, LogLine } from '../test/support.js';
import { runLocalAcpSession } from './local.js';
import type { LocalAcpEvent, LocalAcpSessionOptions, PermissionDecisionInput } from './local.js';

const FAKE_ACP = fileURLToPath(new URL('../test/fake-dsh-acp.mjs', import.meta.url));
const TOKEN = 'ctl-token-0123456789abcdef';
const BASE_URL = 'http://127.0.0.1:43111/v1';
const PROVIDER_KEY = 'sk-provider-key-must-not-leak';

interface LocalRecord extends FakeRecord {
  pid: number;
  envHome?: string;
  envUserProfile?: string;
  envPermissionMode?: string;
  envTelemetryDisabled?: string;
  tokenLeakedInto: string[];
  hasControlToken?: boolean;
  permissionLabel?: string;
  notifications: { method: string }[];
}

const dirs: string[] = [];
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function alive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

async function waitFor<T>(check: () => T | undefined, ms = 10_000): Promise<T> {
  const deadline = Date.now() + ms;
  for (;;) {
    let value: T | undefined;
    try {
      value = check();
    } catch {
      value = undefined; // the record may be mid-rename
    }
    if (value !== undefined) return value;
    if (Date.now() > deadline) throw new Error('waitFor timed out');
    await new Promise((r) => setTimeout(r, 15));
  }
}

function setup(
  flags: Record<string, string> = {},
  overrides: Partial<LocalAcpSessionOptions> = {},
) {
  const dir = realpathSync.native(makeTempDir('nexar-local-acp-'));
  dirs.push(dir);
  const base = join(dir, 'base');
  const scratch = join(base, 'turn');
  const home = join(dir, 'home');
  mkdirSync(scratch, { recursive: true });
  const recordPath = join(dir, 'record.json');
  const args = Object.entries({ record: recordPath, scenario: 'ask', ...flags }).map(
    ([k, v]) => `--fake-${k}=${v}`,
  );
  const logs: LogLine[] = [];
  const events: LocalAcpEvent[] = [];
  const controller = new AbortController();
  const decide = vi.fn<(input: PermissionDecisionInput) => Promise<'allow' | 'reject'>>(() =>
    Promise.resolve('reject'),
  );
  const options: LocalAcpSessionOptions = {
    launch: { command: process.execPath, args: [FAKE_ACP, ...args], env: {} },
    profile: COWORK_PROFILE,
    scratchBase: base,
    scratchDir: scratch,
    dshHome: home,
    permissionMode: 'read-only',
    control: { baseURL: BASE_URL, token: TOKEN },
    prompt: 'MARKER-PROMPT hello',
    decide,
    onEvent: (e) => void events.push(e),
    parentEnv: {
      PATH: process.env.PATH,
      SystemRoot: process.env.SystemRoot,
      DEEPSEEK_API_KEY: PROVIDER_KEY,
      GH_TOKEN: 'ghp_x',
      NODE_OPTIONS: '--inspect',
      ANTHROPIC_API_KEY: 'sk-ant-x',
    },
    signal: controller.signal,
    timeoutMs: 20_000,
    initializeTimeoutMs: 10_000,
    logger: makeLogger(logs),
    ...overrides,
  };
  const record = (): LocalRecord => JSON.parse(readFileSync(recordPath, 'utf8')) as LocalRecord;
  return {
    dir,
    base,
    scratch,
    home,
    options,
    record,
    recordPath,
    logs,
    events,
    controller,
    decide,
  };
}

async function failureOf(promise: Promise<unknown>): Promise<NexarError> {
  try {
    await promise;
  } catch (error) {
    return error as NexarError;
  }
  throw new Error('expected a rejection');
}

describe('runLocalAcpSession', () => {
  it('runs a turn: the exact ACP flow, overlay file and answer text', async () => {
    const t = setup();
    t.decide.mockResolvedValue('allow');
    const result = await runLocalAcpSession(t.options);

    expect(result).toEqual({
      text: 'working. permission:allow-once',
      stopReason: 'end_turn',
      sessionId: 'sess-1',
    });
    const record = t.record();
    expect(record.requests.map((r) => r.method)).toEqual([
      'initialize',
      'session/new',
      'session/set_config_option',
      'session/prompt',
      'session/close',
    ]);
    expect(record.cwd).toBe(t.scratch);
    expect(record.argv.slice(-4)).toEqual([
      '--profile',
      'acp',
      '--patch',
      join(t.home, 'nexar.patch.yml'),
    ]);
    expect(record.overlay).toContain(`baseURL: "${BASE_URL}"`);
    expect(record.overlay).toContain('personaPrefix');
    expect(readFileSync(join(t.home, 'nexar.patch.yml'), 'utf8')).toBe(record.overlay);
    expect(record.requests[1]?.params).toMatchObject({ cwd: t.scratch, mcpServers: [] });
    expect(record.requests[2]?.params).toMatchObject({
      configId: 'model',
      value: JSON.stringify(['nexar', 'nexar-control']),
    });
    expect(alive(record.pid)).toBe(false);
  });

  it('gives the child exactly the allowlisted environment and the token only as NEXAR_CONTROL_TOKEN', async () => {
    const t = setup();
    await runLocalAcpSession(t.options);
    const record = t.record();

    // Windows adds a few variables (HOMEDRIVE, USERNAME, ...) to every process it starts.
    const osInjected = execFileSync(
      process.execPath,
      ['-e', 'process.stdout.write(Object.keys(process.env).join())'],
      { env: {}, encoding: 'utf8' },
    ).split(',');
    const expected = new Set(
      [
        ...osInjected,
        ...PARENT_ENV_ALLOWLIST,
        'HOME',
        'USERPROFILE',
        'DSH_HOME',
        'DSH_AGENTS_HOME',
        'DSH_PERMISSION_MODE',
        'DSH_TELEMETRY_DISABLED',
        'NEXAR_CONTROL_TOKEN',
      ].map((n) => n.toUpperCase()),
    );
    for (const key of record.envKeys) expect(expected.has(key.toUpperCase())).toBe(true);
    for (const forbidden of ['DEEPSEEK_API_KEY', 'GH_TOKEN', 'NODE_OPTIONS', 'ANTHROPIC_API_KEY']) {
      expect(record.envKeys).not.toContain(forbidden);
    }
    expect(record.envKeys).toEqual(
      expect.arrayContaining([
        'DSH_HOME',
        'DSH_AGENTS_HOME',
        'NEXAR_CONTROL_TOKEN',
        'HOME',
        'USERPROFILE',
      ]),
    );
    expect(record.tokenLeakedInto).toEqual([]);
    expect(record.dshHome).toBe(t.home);
    expect(record.envHome).toBe(t.home);
    expect(record.envUserProfile).toBe(t.home);
    expect(record.envPermissionMode).toBe('read-only');
    expect(record.envTelemetryDisabled).toBe('1');
    const serialized = JSON.stringify(record);
    expect(serialized).not.toContain(TOKEN);
    expect(serialized).not.toContain(PROVIDER_KEY);
  });

  it('passes read-only through DSH_PERMISSION_MODE', async () => {
    const t = setup();
    await runLocalAcpSession({ ...t.options, permissionMode: 'read-only' });
    expect(t.record().envPermissionMode).toBe('read-only');
  });

  it('refuses a standing host-local write grant before spawning', async () => {
    const t = setup();
    const spawnSpy = vi.fn() as unknown as typeof spawn;
    const invalid = { ...t.options, permissionMode: 'workspace-write', spawn: spawnSpy };
    await expect(runLocalAcpSession(invalid as LocalAcpSessionOptions)).rejects.toMatchObject({
      code: 'POLICY_REJECTED',
    });
    expect(spawnSpy).not.toHaveBeenCalled();
  });

  it('refuses a scratch directory outside its base without spawning anything', async () => {
    const t = setup();
    const outside = join(t.dir, 'outside');
    mkdirSync(outside);
    const spawnSpy = vi.fn() as unknown as typeof spawn;
    for (const scratchDir of [outside, t.base, join(t.dir, 'missing'), 'relative']) {
      const error = await failureOf(
        runLocalAcpSession({ ...t.options, scratchDir, spawn: spawnSpy }),
      );
      expect(error.code).toBe('POLICY_REJECTED');
    }
    expect(spawnSpy).not.toHaveBeenCalled();
    expect(existsSync(t.recordPath)).toBe(false);
    expect(existsSync(t.home)).toBe(false);
  });

  it('refuses a dsh home inside the scratch directory', async () => {
    const t = setup();
    const spawnSpy = vi.fn() as unknown as typeof spawn;
    const error = await failureOf(
      runLocalAcpSession({ ...t.options, dshHome: join(t.scratch, 'home'), spawn: spawnSpy }),
    );
    expect(error.code).toBe('POLICY_REJECTED');
    expect(spawnSpy).not.toHaveBeenCalled();
  });

  it('rejects a bad control URL before touching the filesystem or spawning', async () => {
    const t = setup();
    const spawnSpy = vi.fn() as unknown as typeof spawn;
    const error = await failureOf(
      runLocalAcpSession({
        ...t.options,
        control: { baseURL: 'http://example.com/v1', token: TOKEN },
        spawn: spawnSpy,
      }),
    );
    expect(error.code).toBe('CONFIGURATION_ERROR');
    expect(spawnSpy).not.toHaveBeenCalled();
    expect(existsSync(t.home)).toBe(false);
  });

  it('answers a permission request through decide: allow', async () => {
    const t = setup({ tool: 'write', input: '{"file_path":"a.md"}' });
    t.decide.mockResolvedValue('allow');
    await runLocalAcpSession(t.options);
    expect(t.decide).toHaveBeenCalledTimes(1);
    expect(t.decide).toHaveBeenCalledWith({
      tool: 'write',
      kind: 'execute',
      rawInput: { file_path: 'a.md' },
      toolCallId: 'call-1',
    });
    expect(t.record().permissionLabel).toBe('allow-once');
  });

  it('answers a permission request through decide: reject', async () => {
    const t = setup({ tool: 'write', input: '{"file_path":"a.md"}' });
    const result = await runLocalAcpSession(t.options);
    expect(t.record().permissionLabel).toBe('reject-once');
    expect(result.text).toBe('working. permission:reject-once');
  });

  it('chooses by option kind, never an *_always option, and rejects when decide throws', async () => {
    const scrambled = setup({ ids: 'scrambled' });
    scrambled.decide.mockResolvedValue('allow');
    await runLocalAcpSession(scrambled.options);
    expect(scrambled.record().permissionLabel).toBe('q-3');

    const failing = setup({ ids: 'scrambled' });
    failing.decide.mockRejectedValue(new Error('policy exploded'));
    await runLocalAcpSession(failing.options);
    expect(failing.record().permissionLabel).toBe('q-4');
  });

  it('rejects when the permission request has no preceding tool call', async () => {
    const t = setup({ scenario: 'unknown-call' });
    t.decide.mockResolvedValue('allow');
    await runLocalAcpSession(t.options);
    expect(t.decide).not.toHaveBeenCalled();
    expect(t.record().permissionLabel).toBe('reject-once');
  });

  it('allows bridge tools without asking decide', async () => {
    const bridge = 'mcp__nexar__nexar_intelligence_submit';
    const t = setup({ tool: bridge, input: '{}' });
    await runLocalAcpSession({ ...t.options, bridgeTools: [bridge] });
    expect(t.decide).not.toHaveBeenCalled();
    expect(t.record().permissionLabel).toBe('allow-once');
  });

  it('emits events without tool arguments or the prompt', async () => {
    const t = setup({ tool: 'write', input: '{"file_path":"SECRET-ARG.md"}' });
    await runLocalAcpSession(t.options);
    expect(t.events).toContainEqual({ type: 'tool-call', name: 'write' });
    expect(t.events.some((e) => e.type === 'text-delta')).toBe(true);
    expect(JSON.stringify(t.events)).not.toContain('SECRET-ARG');
    expect(JSON.stringify(t.logs)).not.toMatch(/SECRET-ARG|MARKER-PROMPT/);
  });

  it('passes requiredContext into the overlay and mcpServers into session/new', async () => {
    const t = setup();
    const server = { name: 'nexar', command: process.execPath, args: ['relay.mjs'], env: [] };
    await runLocalAcpSession({
      ...t.options,
      requiredContext: 'Always answer in French.',
      mcpServers: [server],
    });
    const record = t.record();
    expect(record.overlay).toContain('Always answer in French.');
    expect(record.requests[1]?.params).toMatchObject({ mcpServers: [server] });
  });

  it('returns max_tokens and rejects other stop reasons', async () => {
    const truncated = setup({ stop: 'max_tokens' });
    await expect(runLocalAcpSession(truncated.options)).resolves.toMatchObject({
      stopReason: 'max_tokens',
    });
    const refused = setup({ stop: 'refusal' });
    const error = await failureOf(runLocalAcpSession(refused.options));
    expect(error.code).toBe('PROVIDER_ERROR');
  });

  it('cancels: session/cancel, then the process is gone', async () => {
    const t = setup({ scenario: 'hang' });
    const running = failureOf(runLocalAcpSession(t.options));
    await waitFor(
      () => t.record().requests.some((r) => r.method === 'session/prompt') || undefined,
    );
    t.controller.abort();
    const error = await running;
    expect(error.code).toBe('EXECUTION_CANCELLED');
    const record = t.record();
    expect(record.notifications.map((n) => n.method)).toContain('session/cancel');
    await waitFor(() => (alive(record.pid) ? undefined : true));
  });

  it('refuses to start when already cancelled', async () => {
    const t = setup();
    t.controller.abort();
    const spawnSpy = vi.fn() as unknown as typeof spawn;
    const error = await failureOf(runLocalAcpSession({ ...t.options, spawn: spawnSpy }));
    expect(error.code).toBe('EXECUTION_CANCELLED');
    expect(spawnSpy).not.toHaveBeenCalled();
  });

  it('times out, cancels and stops the process', async () => {
    const t = setup({ scenario: 'hang' });
    const error = await failureOf(runLocalAcpSession({ ...t.options, timeoutMs: 2_500 }));
    expect(error.code).toBe('EXECUTION_TIMEOUT');
    const pid = t.record().pid;
    await waitFor(() => (alive(pid) ? undefined : true));
  });

  it('kills a child that ignores cancel', async () => {
    const t = setup({ scenario: 'hang', 'ignore-cancel': '1' });
    const running = failureOf(runLocalAcpSession(t.options));
    await waitFor(
      () => t.record().requests.some((r) => r.method === 'session/prompt') || undefined,
    );
    t.controller.abort();
    expect((await running).code).toBe('EXECUTION_CANCELLED');
    const pid = t.record().pid;
    await waitFor(() => (alive(pid) ? undefined : true), 15_000);
  }, 30_000);

  it('aborts the turn when the model route changes', async () => {
    const t = setup({ scenario: 'model-change' });
    const error = await failureOf(runLocalAcpSession(t.options));
    expect(error.code).toBe('POLICY_REJECTED');
    expect(error.details).toEqual({ reason: 'model-route-changed' });
    expect(t.record().notifications.map((n) => n.method)).toContain('session/cancel');
  });

  it('never lets the token reach an error message, its details or the logs', async () => {
    const leaky = setup({ scenario: 'rpc-error', 'rpc-message': `upstream said ${TOKEN} is bad` });
    const error = await failureOf(runLocalAcpSession(leaky.options));
    expect(error.code).toBe('PROVIDER_ERROR');
    expect(JSON.stringify(error.toJSON())).not.toContain(TOKEN);
    expect(JSON.stringify(leaky.logs)).not.toContain(TOKEN);

    const missing = setup();
    const unavailable = await failureOf(
      runLocalAcpSession({
        ...missing.options,
        launch: { command: join(missing.dir, 'no-such-binary'), args: [], env: {} },
      }),
    );
    expect(unavailable.code).toBe('INTEGRATION_UNAVAILABLE');
    expect(JSON.stringify(unavailable.toJSON())).not.toContain(TOKEN);
    expect(JSON.stringify(missing.logs)).not.toContain(TOKEN);
  });

  it('fails on an unsupported protocol version', async () => {
    const t = setup({ protocol: '2' });
    const error = await failureOf(runLocalAcpSession(t.options));
    expect(error.code).toBe('INTEGRATION_UNAVAILABLE');
  });
});
