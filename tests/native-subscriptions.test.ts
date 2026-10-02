import { resolve } from 'node:path';
import type { NativeSubscriptionRuntime } from '@nexar/contracts';
import { createClaudeSubscription } from '@nexar/integration-claude-code';
import { createCodexSubscription } from '@nexar/integration-codex';
import { createAntigravitySubscription } from '@nexar/integration-antigravity';
import type { runRuntimeCommand } from '@nexar/process';
import { describe, expect, it, vi } from 'vitest';

type Command = Parameters<typeof runRuntimeCommand>[0];
type Result = Awaited<ReturnType<typeof runRuntimeCommand>>;
const canary = 'PRIVATE-ACCOUNT-KEY-IDENTIFIER-CANARY';
const cwd = resolve('subscription-fixture');
const state = resolve('vendor-private-state');
const exited = (stdout = '', stderr = '', exitCode = 0): Result => ({
  kind: 'exited',
  stdout,
  stderr,
  exitCode,
});
const signal = () => new AbortController().signal;
const factories = [
  {
    name: 'claude',
    create: createClaudeSubscription,
    version: '2.1.288 (Claude Code)\r\n',
    normalized: '2.1.288',
    config: 'CLAUDE_CONFIG_DIR',
    status: ['auth', 'status'],
    login: ['auth', 'login'],
  },
  {
    name: 'codex',
    create: createCodexSubscription,
    version: 'codex-cli 0.160.0\r\n',
    normalized: '0.160.0',
    config: 'CODEX_HOME',
    status: ['login', 'status'],
    login: ['login'],
  },
] as const;

function fake(results: Result[]) {
  const queue = [...results];
  return vi.fn<typeof runRuntimeCommand>(() => {
    const result = queue.shift();
    if (result === undefined) throw new Error(canary);
    return Promise.resolve(result);
  });
}

describe.each(factories)('$name native subscription boundary', (runtime) => {
  const create = (
    runCommand: typeof runRuntimeCommand,
    env: NodeJS.ProcessEnv = {},
  ): NativeSubscriptionRuntime => runtime.create({ cwd, env, runCommand });

  it('uses only fixed version/status arguments and bounded probe transport', async () => {
    const run = fake([exited(runtime.version), exited()]);
    const abort = signal();
    await create(run).probe(abort);
    expect(run.mock.calls.map(([command]) => command.args)).toEqual([
      ['--version'],
      runtime.status,
    ]);
    for (const [command] of run.mock.calls)
      expect(command).toMatchObject({
        command: runtime.name,
        cwd,
        signal: abort,
        interaction: 'probe',
        timeoutMs: 10_000,
        maxOutputBytes: 16 * 1024,
      });
  });

  it('uses explicit executable settings without adding prompt/config arguments', async () => {
    const run = fake([exited('', '', 0)]);
    const command = resolve('vendor-runtime.exe');
    await runtime.create({ cwd, env: {}, command, runCommand: run }).login(signal());
    expect(run.mock.calls[0]?.[0]).toMatchObject({
      command,
      args: runtime.login,
      interaction: 'browser',
      timeoutMs: 300_000,
    });
  });

  it('preserves only the trusted absolute vendor state setting and public OS environment', async () => {
    const run = fake([exited()]);
    const env: NodeJS.ProcessEnv = {
      PATH: 'public-path',
      HOME: state,
      [runtime.config]: state,
      ANTHROPIC_API_KEY: canary,
      ANTHROPIC_AUTH_TOKEN: canary,
      CLAUDE_CODE_OAUTH_TOKEN: canary,
      OPENAI_API_KEY: canary,
      CODEX_API_KEY: canary,
      CODEX_ACCESS_TOKEN: canary,
      GEMINI_API_KEY: canary,
      GOOGLE_API_KEY: canary,
      NODE_OPTIONS: canary,
      AGY_ADC_AUTH: canary,
      [runtime.config === 'CODEX_HOME' ? 'CLAUDE_CONFIG_DIR' : 'CODEX_HOME']: state,
      NEXAR_PRIVATE_SETTING: canary,
    };
    await create(run, env).login(signal());
    const child = run.mock.calls[0]![0].env;
    expect(child[runtime.config]).toBe(state);
    expect(child.PATH).toBe('public-path');
    expect(child.HOME).toBe(state);
    expect(JSON.stringify(child)).not.toContain(canary);
    expect(
      child[runtime.config === 'CODEX_HOME' ? 'CLAUDE_CONFIG_DIR' : 'CODEX_HOME'],
    ).toBeUndefined();
    expect(env.ANTHROPIC_API_KEY).toBe(canary);
  });

  it.each([
    'relative-state',
    '../parent',
    `state\n${canary}`,
    `state\0${canary}`,
    'x'.repeat(4097),
  ])('rejects unsafe state setting %s', async (value) => {
    const run = fake([exited()]);
    await create(run, { [runtime.config]: value }).login(signal());
    expect(run.mock.calls[0]![0].env[runtime.config]).toBeUndefined();
  });

  it.runIf(process.platform === 'win32')(
    'rejects root-relative Windows state settings and case collisions',
    async () => {
      for (const env of [
        { [runtime.config]: '\\relative-root' },
        { [runtime.config]: state, [runtime.config.toLowerCase()]: state },
      ]) {
        const run = fake([exited()]);
        await create(run, env).login(signal());
        expect(run.mock.calls[0]![0].env[runtime.config]).toBeUndefined();
      }
    },
  );

  it.runIf(process.platform === 'win32')(
    'scrubs mixed-case tokens and recognizes a single mixed-case state setting',
    async () => {
      const run = fake([exited()]);
      await create(run, {
        [runtime.config.toLowerCase()]: state,
        openai_api_key: canary,
        anthropic_auth_token: canary,
        node_options: canary,
      }).login(signal());
      expect(run.mock.calls[0]![0].env[runtime.config]).toBe(state);
      expect(JSON.stringify(run.mock.calls)).not.toContain(canary);
    },
  );

  it.each(['unavailable', 'cancelled', 'timed-out', 'overflow'] as const)(
    'handles version transport %s without probing authentication',
    async (kind) => {
      const run = fake([{ kind, stdout: canary, stderr: canary }]);
      const result = await create(run).probe(signal());
      expect(result).toEqual({
        status: kind === 'unavailable' ? 'unavailable' : 'unknown',
        authMode: 'unknown',
        loginSupported: true,
      });
      expect(run).toHaveBeenCalledTimes(1);
    },
  );

  it('nonzero version exit is unavailable and carries no output', async () => {
    const run = fake([exited(canary, canary, 1)]);
    expect(await create(run).probe(signal())).toEqual({
      status: 'unavailable',
      authMode: 'unknown',
      loginSupported: true,
    });
  });

  it.each([
    canary,
    '1.2.3\nprivate@example.com',
    '\x1b[31m1.2.3',
    '1.2.3/path',
    '1.2.3 (private-account)',
    '1.2.3-' + 'a'.repeat(101),
  ])('does not return malformed/private version %s', async (version) => {
    const auth =
      runtime.name === 'claude'
        ? exited('{"loggedIn":true,"authMethod":"claude.ai"}')
        : exited('', 'Logged in using ChatGPT');
    const run = fake([exited(version), auth]);
    expect(await create(run).probe(signal())).toEqual({
      status: 'connected',
      authMode: 'vendor-account',
      loginSupported: true,
    });
    expect(run).toHaveBeenCalledTimes(2);
  });

  it.each(['1.2.3-alpha.13+build.7', '12345.23456.34567'])(
    'returns only the bounded numeric version core %s',
    async (version) => {
      const auth =
        runtime.name === 'claude'
          ? exited('{"loggedIn":true,"authMethod":"claude.ai"}')
          : exited('', 'Logged in using ChatGPT');
      const run = fake([exited(version), auth]);
      const result = await create(run).probe(signal());
      expect(result.status).toBe('connected');
      expect(result.version).toBe(version.split('-')[0]);
      expect(result.version).toMatch(/^\d{1,5}\.\d{1,5}\.\d{1,5}$/);
    },
  );

  it.each(['unavailable', 'cancelled', 'timed-out', 'overflow'] as const)(
    'handles authentication transport %s without disclosing diagnostics',
    async (kind) => {
      const run = fake([exited(runtime.version), { kind, stdout: canary, stderr: canary }]);
      expect(await create(run).probe(signal())).toEqual({
        status: kind === 'unavailable' ? 'unavailable' : 'unknown',
        authMode: 'unknown',
        version: runtime.normalized,
        loginSupported: true,
      });
    },
  );

  it.each([
    [exited(canary, canary), 'succeeded'],
    [exited(canary, canary, 1), 'failed'],
    [{ kind: 'cancelled', stdout: canary, stderr: canary }, 'cancelled'],
    [{ kind: 'timed-out', stdout: canary, stderr: canary }, 'timed-out'],
    [{ kind: 'unavailable', stdout: canary, stderr: canary }, 'unavailable'],
    [{ kind: 'overflow', stdout: canary, stderr: canary }, 'failed'],
  ] as const)('maps login command outcome safely', async (result, outcome) => {
    const run = fake([result]);
    expect(await create(run).login(signal())).toBe(outcome);
    expect(run.mock.calls[0]![0]).toMatchObject({
      args: runtime.login,
      interaction: 'browser',
      timeoutMs: 300_000,
    });
  });

  it('normalizes injected transport exceptions without exposing their messages', async () => {
    const run = vi.fn<typeof runRuntimeCommand>(() => {
      throw new Error(canary);
    });
    expect(await create(run).probe(signal())).toEqual({
      status: 'unknown',
      authMode: 'unknown',
      loginSupported: true,
    });
    expect(await create(run).login(signal())).toBe('unavailable');
  });

  it('does not launch when already cancelled', async () => {
    const run = fake([]);
    const controller = new AbortController();
    controller.abort(canary);
    expect((await create(run).probe(controller.signal)).status).toBe('unknown');
    expect(await create(run).login(controller.signal)).toBe('cancelled');
    expect(run).not.toHaveBeenCalled();
  });

  it('does not launch status after cancellation races the version command', async () => {
    const controller = new AbortController();
    const run = vi.fn<typeof runRuntimeCommand>(() => {
      controller.abort(canary);
      return Promise.resolve(exited(runtime.version));
    });
    expect((await create(run).probe(controller.signal)).status).toBe('unknown');
    expect(run).toHaveBeenCalledTimes(1);
  });

  it('does not report connected when cancellation races the authentication result', async () => {
    const controller = new AbortController();
    let calls = 0;
    const run = vi.fn<typeof runRuntimeCommand>(() => {
      if (calls++ === 0) return Promise.resolve(exited(runtime.version));
      controller.abort(canary);
      return Promise.resolve(
        runtime.name === 'claude'
          ? exited('{"loggedIn":true,"authMethod":"claude.ai"}')
          : exited('', 'Logged in using ChatGPT'),
      );
    });
    expect((await create(run).probe(controller.signal)).status).toBe('unknown');
  });

  it('returns cancelled when cancellation races a successful login exit', async () => {
    const controller = new AbortController();
    const run = vi.fn<typeof runRuntimeCommand>(() => {
      controller.abort(canary);
      return Promise.resolve(exited());
    });
    expect(await create(run).login(controller.signal)).toBe('cancelled');
  });
});

describe('Claude subscription authentication classification', () => {
  it.each([
    [{ loggedIn: true, authMethod: 'claude.ai' }, 0, 'connected', 'vendor-account'],
    [{ loggedIn: false, authMethod: 'none' }, 1, 'not-connected', 'none'],
    [{ loggedIn: true, authMethod: 'api_key' }, 0, 'not-connected', 'api-key'],
    [{ loggedIn: true, authMethod: 'api_key_helper' }, 0, 'not-connected', 'api-key'],
    [{ loggedIn: true, authMethod: 'oauth_token' }, 0, 'unknown', 'unknown'],
    [{ loggedIn: true, authMethod: 'third_party' }, 0, 'unknown', 'unknown'],
    [{ loggedIn: true, authMethod: 'claude.ai' }, 1, 'unknown', 'unknown'],
    [{ loggedIn: false, authMethod: 'claude.ai' }, 1, 'unknown', 'unknown'],
    [{ loggedIn: 'true', authMethod: 'claude.ai' }, 0, 'unknown', 'unknown'],
    [{ loggedIn: true }, 0, 'unknown', 'unknown'],
    [{ loggedIn: false, authMethod: 'none' }, 2, 'unknown', 'unknown'],
  ] as const)(
    'classifies account/API/unknown state without returning account metadata',
    async (body, exitCode, status, authMode) => {
      const run = fake([
        exited('2.1.288 (Claude Code)'),
        exited(
          JSON.stringify({
            ...body,
            email: canary,
            accountId: canary,
            token: canary,
            configDirectory: canary,
          }),
          canary,
          exitCode,
        ),
      ]);
      const result = await createClaudeSubscription({ cwd, env: {}, runCommand: run }).probe(
        signal(),
      );
      expect(result).toEqual({ status, authMode, version: '2.1.288', loginSupported: true });
      expect(JSON.stringify(result)).not.toContain(canary);
    },
  );

  it.each([
    'not json ' + canary,
    'null',
    '[]',
    'true',
    '{}',
    '{"loggedIn":true,"authMethod":"unknown-method"}',
  ])('fails closed on malformed or unrecognized JSON', async (body) => {
    const run = fake([exited('2.1.288'), exited(body)]);
    const result = await createClaudeSubscription({ cwd, env: {}, runCommand: run }).probe(
      signal(),
    );
    expect(result.status).toBe('unknown');
    expect(JSON.stringify(result)).not.toContain(canary);
  });
});

describe('Codex subscription authentication classification', () => {
  it.each([
    ['', 'Logged in using ChatGPT\r\n', 0, 'connected', 'vendor-account'],
    ['Logged in using ChatGPT', '', 0, 'connected', 'vendor-account'],
    ['', 'Not logged in', 1, 'not-connected', 'none'],
    ['', 'Not logged in', 0, 'not-connected', 'none'],
    ['', `Logged in using an API key - ${canary}`, 0, 'not-connected', 'api-key'],
    ['', 'Logged in using access token', 0, 'unknown', 'unknown'],
    ['', 'Logged in using personal access token', 0, 'unknown', 'unknown'],
    ['', 'Logged in using workload identity', 0, 'unknown', 'unknown'],
    ['', 'Logged in using Amazon Bedrock API key', 0, 'unknown', 'unknown'],
    ['', 'Logged in using ChatGPT', 1, 'unknown', 'unknown'],
    [canary, 'Logged in using ChatGPT', 0, 'unknown', 'unknown'],
    ['', `Warning ${canary}\nLogged in using ChatGPT`, 0, 'unknown', 'unknown'],
    ['', 'Not logged in\nLogged in using ChatGPT', 0, 'unknown', 'unknown'],
    ['', `Error checking login status: ${canary}`, 1, 'unknown', 'unknown'],
  ] as const)(
    'requires anchored native account evidence',
    async (stdout, stderr, exitCode, status, authMode) => {
      const run = fake([exited('codex-cli 0.160.0'), exited(stdout, stderr, exitCode)]);
      const result = await createCodexSubscription({ cwd, env: {}, runCommand: run }).probe(
        signal(),
      );
      expect(result).toEqual({ status, authMode, version: '0.160.0', loginSupported: true });
      expect(JSON.stringify(result)).not.toContain(canary);
    },
  );
});

describe('Antigravity unsupported automation', () => {
  it('probes only version and never invents authentication or entitlement commands', async () => {
    const run = fake([exited('1.2.14\r\n', canary)]);
    const runtime = createAntigravitySubscription({
      cwd,
      env: { GEMINI_API_KEY: canary, GOOGLE_API_KEY: canary, AGY_ADC_AUTH: canary },
      runCommand: run,
    });
    expect(await runtime.probe(signal())).toEqual({
      status: 'unknown',
      authMode: 'unknown',
      version: '1.2.14',
      loginSupported: false,
    });
    expect(await runtime.login(signal())).toBe('unavailable');
    expect(run).toHaveBeenCalledTimes(1);
    const command: Command = run.mock.calls[0]![0];
    expect(command).toMatchObject({
      command: 'agy',
      args: ['--version'],
      interaction: 'probe',
      timeoutMs: 10_000,
    });
    expect(JSON.stringify(command.env)).not.toContain(canary);
  });

  it.each(['unavailable', 'cancelled', 'timed-out', 'overflow'] as const)(
    'handles %s without exposing output',
    async (kind) => {
      const run = fake([{ kind, stdout: canary, stderr: canary }]);
      expect(
        await createAntigravitySubscription({ cwd, env: {}, runCommand: run }).probe(signal()),
      ).toEqual({
        status: kind === 'unavailable' ? 'unavailable' : 'unknown',
        authMode: 'unknown',
        loginSupported: false,
      });
    },
  );

  it.each([exited(canary), exited('1.2.14\n' + canary), exited('1.2.14', canary, 1)])(
    'fails closed on invalid version results',
    async (result) => {
      const run = fake([result]);
      const probe = await createAntigravitySubscription({ cwd, env: {}, runCommand: run }).probe(
        signal(),
      );
      expect(probe.status).toBe(result.exitCode === 1 ? 'unavailable' : 'unknown');
      expect(probe.version).toBeUndefined();
    },
  );

  it('returns unknown on exceptions and launches nothing on pre-abort', async () => {
    const run = vi.fn<typeof runRuntimeCommand>(() => {
      throw new Error(canary);
    });
    const runtime = createAntigravitySubscription({ cwd, env: {}, runCommand: run });
    expect((await runtime.probe(signal())).status).toBe('unknown');
    const controller = new AbortController();
    controller.abort(canary);
    expect((await runtime.probe(controller.signal)).status).toBe('unknown');
    expect(run).toHaveBeenCalledTimes(1);
  });
});
