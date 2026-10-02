import { readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { adapterId, isNexarError } from '@nexar/contracts';
import type { NexarError, ResourceDescriptor } from '@nexar/contracts';
import { afterEach, describe, expect, it } from 'vitest';
import { CodexExecutionAdapter, TESTED_CODEX_VERSION, codexResource } from './index.js';
import { fakeLauncher, harness, isAlive, silentLogger, task, waitFor } from './test/harness.js';
import type { Harness } from './test/harness.js';

const BYPASS = '--dangerously-bypass-approvals-and-sandbox';

// Node/libuv restores these public Windows variables during spawn, independently of the adapter.
const WINDOWS_RUNTIME_KEYS = new Set(
  process.platform === 'win32'
    ? [
        'HOMEDRIVE',
        'HOMEPATH',
        'LOGONSERVER',
        'SYSTEMDRIVE',
        'SYSTEMROOT',
        'TEMP',
        'USERDOMAIN',
        'USERNAME',
        'USERPROFILE',
        'WINDIR',
      ]
    : [],
);

function applicationEnvKeys(env: Readonly<Record<string, string | undefined>>): string[] {
  return Object.keys(env)
    .filter((name) => !WINDOWS_RUNTIME_KEYS.has(name.toUpperCase()))
    .sort();
}

let h: Harness | undefined;
afterEach(() => {
  h?.cleanup();
  h = undefined;
});

function withOptions(options: Record<string, unknown>): ResourceDescriptor {
  const base = codexResource();
  return { ...base, runtime: { ...base.runtime, options } };
}

async function rejection(p: Promise<unknown>): Promise<NexarError> {
  try {
    await p;
  } catch (e) {
    if (isNexarError(e)) return e;
    throw e;
  }
  throw new Error('expected rejection');
}

describe('supports', () => {
  it('matches on runtime.adapter', () => {
    const a = new CodexExecutionAdapter();
    expect(a.supports(codexResource())).toBe(true);
    const other = codexResource();
    expect(
      a.supports({ ...other, runtime: { ...other.runtime, adapter: adapterId('echo') } }),
    ).toBe(false);
  });
});

describe('execute: unscoped (no workspace)', () => {
  it('sends the prompt on stdin only, read-only, with the expected argv and cwd', async () => {
    h = harness();
    const result = await h.adapter.execute(
      {
        task: task({ workingDirectory: process.cwd() }),
        resource: withOptions({ model: 'gpt-x', reasoningEffort: 'medium' }),
      },
      h.context(),
    );
    const [call] = h.invocations();
    expect(call?.stdin).toBe('PROMPT-SENTINEL');
    expect(call?.argv).toEqual([
      'exec',
      '--json',
      '--ephemeral',
      '--ignore-user-config',
      '--color',
      'never',
      '-m',
      'gpt-x',
      '-c',
      'model_reasoning_effort="medium"',
      '-s',
      'read-only',
      '--skip-git-repo-check',
      '-C',
      process.cwd(),
      '-',
    ]);
    expect(call?.argv.join(' ')).not.toContain('PROMPT-SENTINEL');
    expect(call?.argv).not.toContain(BYPASS);
    expect(result.text).toBe('ECHO: PROMPT-SENTINEL');
    expect(result.resolved).toMatchObject({ provider: 'openai', model: 'gpt-x' });
  });

  it('prepends the system prompt to the stdin prompt', async () => {
    h = harness();
    await h.adapter.execute(
      { task: task({ systemPrompt: 'be brief' }), resource: codexResource() },
      h.context(),
    );
    expect(h.invocations()[0]?.stdin).toBe('be brief\n\nPROMPT-SENTINEL');
    expect(h.invocations()[0]?.argv.join(' ')).not.toContain('be brief');
  });

  it('scrubs the environment: no API keys or tokens reach the child', async () => {
    h = harness(
      {},
      {
        OPENAI_API_KEY: 'sk-secret',
        CODEX_API_KEY: 'k',
        CODEX_ACCESS_TOKEN: 't',
        GITHUB_TOKEN: 'g',
        LANG: 'C',
      },
    );
    await h.adapter.execute({ task: task(), resource: codexResource() }, h.context());
    const env = h.invocations()[0]?.env ?? {};
    expect(applicationEnvKeys(env)).toEqual(['CODEX_HOME', 'HOME', 'LANG', 'PATH', 'TERM']);
    expect(env['TERM']).toBe('dumb');
    expect(env['CODEX_HOME']).toBe(join(h.dir, '.codex'));
  });

  it('uses the codexHome setting as CODEX_HOME', async () => {
    h = harness();
    await h.adapter.execute(
      { task: task(), resource: withOptions({ codexHome: '/srv/ch' }) },
      h.context(),
    );
    expect(h.invocations()[0]?.env['CODEX_HOME']).toBe(resolve('/srv/ch'));
  });

  it('maps usage, turns and unknown cost', async () => {
    h = harness();
    const r = await h.adapter.execute({ task: task(), resource: codexResource() }, h.context());
    expect(r.usage.inputTokens).toEqual({ status: 'measured', value: 100 });
    expect(r.usage.outputTokens).toEqual({ status: 'measured', value: 15 });
    expect(r.usage.costUsd.status).toBe('unavailable');
    expect(r.retries).toBe(0);
  });

  it('reports unavailable (not 0) when codex emits zero usage', async () => {
    h = harness({ mode: 'zero-usage' });
    const r = await h.adapter.execute({ task: task(), resource: codexResource() }, h.context());
    expect(r.text).toBe('ok');
    expect(r.usage.inputTokens.status).toBe('unavailable');
    expect(r.usage.outputTokens.status).toBe('unavailable');
  });

  it('streams tool/status events and returns the last agent message', async () => {
    h = harness({ mode: 'activity' });
    const r = await h.adapter.execute({ task: task(), resource: codexResource() }, h.context());
    expect(r.text).toBe('final answer');
    expect(h.events).toContainEqual({ type: 'tool-call', name: 'shell' });
    expect(h.events).toContainEqual({ type: 'tool-call', name: 'edit', detail: '2 files' });
    expect(h.events).toContainEqual({ type: 'status', message: 'agent message' });
    expect(JSON.stringify(h.events)).not.toContain('SECRET-COMMAND-TEXT');
  });

  it('treats reconnecting errors followed by success as success', async () => {
    h = harness({ mode: 'reconnect' });
    const r = await h.adapter.execute({ task: task(), resource: codexResource() }, h.context());
    expect(r.text).toBe('recovered');
  });

  it('ignores garbage stdout lines', async () => {
    h = harness({ mode: 'garbage' });
    const r = await h.adapter.execute({ task: task(), resource: codexResource() }, h.context());
    expect(r.text).toBe('after garbage');
  });

  it('rejects invalid settings before spawning', async () => {
    h = harness();
    const err = await rejection(
      h.adapter.execute({ task: task(), resource: withOptions({ nope: 1 }) }, h.context()),
    );
    expect(err.code).toBe('CONFIGURATION_ERROR');
    expect(h.invocations()).toEqual([]);
  });
});

describe('execute: failures', () => {
  it('turn.failed 401 -> AUTH_REQUIRED', async () => {
    h = harness({ mode: 'auth' });
    const err = await rejection(
      h.adapter.execute({ task: task(), resource: codexResource() }, h.context()),
    );
    expect(err.code).toBe('AUTH_REQUIRED');
    expect(err.message.length).toBeLessThan(300);
  });

  it('usage limit -> QUOTA_EXHAUSTED', async () => {
    h = harness({ mode: 'limit' });
    const err = await rejection(
      h.adapter.execute({ task: task(), resource: codexResource() }, h.context()),
    );
    expect(err.code).toBe('QUOTA_EXHAUSTED');
  });

  it('non-zero exit without events -> PROVIDER_ERROR with a bounded stderr excerpt', async () => {
    h = harness({ mode: 'fail' });
    const err = await rejection(
      h.adapter.execute({ task: task(), resource: codexResource() }, h.context()),
    );
    expect(err.code).toBe('PROVIDER_ERROR');
    expect(err.message).toContain('exit 3');
    expect(err.message).toContain('boom happened');
  });

  it('never echoes the prompt in an error message', async () => {
    h = harness({ mode: 'fail' });
    const err = await rejection(
      h.adapter.execute({ task: task(), resource: codexResource() }, h.context()),
    );
    expect(err.message).not.toContain('PROMPT-SENTINEL');
  });

  it('a missing binary -> INTEGRATION_UNAVAILABLE', async () => {
    const a = new CodexExecutionAdapter({ binary: '/nonexistent/codex', env: { PATH: '' } });
    const err = await rejection(
      a.execute(
        { task: task(), resource: codexResource() },
        { signal: new AbortController().signal, logger: silentLogger },
      ),
    );
    expect(err.code).toBe('INTEGRATION_UNAVAILABLE');
  });

  it('oversized output -> PROVIDER_ERROR and the child is killed', async () => {
    h = harness({ mode: 'bigline' });
    const err = await rejection(
      h.adapter.execute({ task: task(), resource: codexResource() }, h.context()),
    );
    expect(err.code).toBe('PROVIDER_ERROR');
    const pid = h.invocations()[0]?.pid ?? 0;
    await waitFor(() => (isAlive(pid) ? undefined : true));
  });

  it('an already-aborted signal cancels before spawning', async () => {
    h = harness();
    const ctl = new AbortController();
    ctl.abort();
    const err = await rejection(
      h.adapter.execute({ task: task(), resource: codexResource() }, h.context(ctl.signal)),
    );
    expect(err.code).toBe('EXECUTION_CANCELLED');
    expect(h.invocations()).toEqual([]);
  });
});

describe('execute: timeout and abort kill the process group', () => {
  it('timeout -> EXECUTION_TIMEOUT and the grandchild dies', async () => {
    h = harness({ mode: 'hang' });
    const err = await rejection(
      h.adapter.execute({ task: task(), resource: withOptions({ timeoutMs: 600 }) }, h.context()),
    );
    expect(err.code).toBe('EXECUTION_TIMEOUT');
    const grandchild = Number(readFileSync(h.pidfile, 'utf8'));
    await waitFor(() => (isAlive(grandchild) ? undefined : true));
    const leader = h.invocations()[0]?.pid ?? 0;
    expect(isAlive(leader)).toBe(false);
  });

  it('abort -> EXECUTION_CANCELLED and the grandchild dies', async () => {
    h = harness({ mode: 'hang' });
    const ctl = new AbortController();
    const pending = rejection(
      h.adapter.execute({ task: task(), resource: codexResource() }, h.context(ctl.signal)),
    );
    const pidfile = h.pidfile;
    const grandchild = await waitFor(() => {
      try {
        const n = Number(readFileSync(pidfile, 'utf8'));
        return n > 0 ? n : undefined;
      } catch {
        return undefined;
      }
    });
    ctl.abort();
    expect((await pending).code).toBe('EXECUTION_CANCELLED');
    await waitFor(() => (isAlive(grandchild) ? undefined : true));
  });
});

describe('execute: sandboxed workspace', () => {
  it('builds the LaunchSpec and spawns exactly the prepared command', async () => {
    h = harness();
    const launcher = fakeLauncher('sandbox');
    const result = await h.adapter.execute(
      {
        task: task({ systemPrompt: 'sys' }),
        resource: withOptions({ model: 'gpt-x', codexHome: h.dir, allowHosts: ['chatgpt.com'] }),
      },
      h.context(undefined, h.workspace(launcher, 'read-write')),
    );

    const [spec] = launcher.specs;
    expect(spec?.workspace).toBe(h.dir);
    expect(spec?.workspaceAccess).toBe('read-write');
    expect(spec?.network).toEqual({ mode: 'proxy', allowHosts: ['chatgpt.com'] });
    expect(spec?.mounts).toEqual([
      { hostPath: h.dir, sandboxPath: '/home/agent/.codex', access: 'read-write' },
    ]);
    expect(spec?.env).toEqual({ CODEX_HOME: '/home/agent/.codex', LANG: 'C.UTF-8' });
    expect(JSON.stringify(spec)).not.toContain('PROMPT-SENTINEL');
    expect(spec?.args).toContain(BYPASS);
    expect(spec?.args).not.toContain('-s');
    expect(spec?.args.at(-1)).toBe('-');

    const call = h.invocations()[0];
    expect(call?.argv).toContain(BYPASS);
    expect(call?.stdin).toBe('sys\n\nPROMPT-SENTINEL');
    expect(call?.env['CODEX_HOME']).toBe('/home/agent/.codex');
    expect(result.text).toContain('PROMPT-SENTINEL');
    expect(launcher.disposed.count).toBe(1);
  });

  it('uses the default allowlist when none is configured', async () => {
    h = harness();
    const launcher = fakeLauncher('sandbox');
    await h.adapter.execute(
      { task: task(), resource: withOptions({ codexHome: h.dir }) },
      h.context(undefined, h.workspace(launcher, 'read-only')),
    );
    expect(launcher.specs[0]?.workspaceAccess).toBe('read-only');
    expect(launcher.specs[0]?.network).toEqual({
      mode: 'proxy',
      allowHosts: ['chatgpt.com', 'auth.openai.com', 'api.openai.com'],
    });
  });

  it('disposes the launch when codex fails', async () => {
    h = harness({ mode: 'auth' });
    const launcher = fakeLauncher('sandbox');
    await rejection(
      h.adapter.execute(
        { task: task(), resource: withOptions({ codexHome: h.dir }) },
        h.context(undefined, h.workspace(launcher, 'read-write')),
      ),
    );
    expect(launcher.disposed.count).toBe(1);
  });

  it('disposes the launch on timeout', async () => {
    h = harness({ mode: 'hang' });
    const launcher = fakeLauncher('sandbox');
    const err = await rejection(
      h.adapter.execute(
        { task: task(), resource: withOptions({ codexHome: h.dir, timeoutMs: 500 }) },
        h.context(undefined, h.workspace(launcher, 'read-write')),
      ),
    );
    expect(err.code).toBe('EXECUTION_TIMEOUT');
    expect(launcher.disposed.count).toBe(1);
  });

  it('disposes the launch on abort', async () => {
    h = harness({ mode: 'hang' });
    const launcher = fakeLauncher('sandbox');
    const ctl = new AbortController();
    const pending = rejection(
      h.adapter.execute(
        { task: task(), resource: withOptions({ codexHome: h.dir }) },
        h.context(ctl.signal, h.workspace(launcher, 'read-write')),
      ),
    );
    await waitFor(() => (h?.invocations().length ? true : undefined));
    ctl.abort();
    expect((await pending).code).toBe('EXECUTION_CANCELLED');
    expect(launcher.disposed.count).toBe(1);
  });

  it('refuses to run when the launcher did not apply the sandbox, and still disposes', async () => {
    h = harness();
    const launcher = fakeLauncher('sandbox', { appliedIsolation: 'none' });
    const err = await rejection(
      h.adapter.execute(
        { task: task(), resource: withOptions({ codexHome: h.dir }) },
        h.context(undefined, h.workspace(launcher, 'read-write')),
      ),
    );
    expect(err.code).toBe('POLICY_REJECTED');
    expect(h.invocations()).toEqual([]);
    expect(launcher.disposed.count).toBe(1);
  });

  it('fails with AUTH_REQUIRED when the Codex home does not exist, before preparing', async () => {
    h = harness();
    const launcher = fakeLauncher('sandbox');
    const err = await rejection(
      h.adapter.execute(
        { task: task(), resource: withOptions({ codexHome: `${h.dir}/missing` }) },
        h.context(undefined, h.workspace(launcher, 'read-write')),
      ),
    );
    expect(err.code).toBe('AUTH_REQUIRED');
    expect(launcher.prepared.count).toBe(0);
    expect(err.message).not.toContain(h.dir);
  });
});

describe('execute: workspace without a sandbox launcher', () => {
  it('read-write -> POLICY_REJECTED before the launcher or any process is touched', async () => {
    h = harness();
    const launcher = fakeLauncher('none');
    const err = await rejection(
      h.adapter.execute(
        { task: task(), resource: codexResource() },
        h.context(undefined, h.workspace(launcher, 'read-write')),
      ),
    );
    expect(err.code).toBe('POLICY_REJECTED');
    expect(err.message).toContain('write mode requires the Nexar sandbox');
    expect(launcher.prepared.count).toBe(0);
    expect(h.invocations()).toEqual([]);
  });

  it('read-only runs through the launcher without the bypass flag', async () => {
    h = harness();
    const launcher = fakeLauncher('none');
    const r = await h.adapter.execute(
      { task: task(), resource: codexResource() },
      h.context(undefined, h.workspace(launcher, 'read-only')),
    );
    expect(launcher.prepared.count).toBe(1);
    expect(launcher.disposed.count).toBe(1);
    const argv = h.invocations()[0]?.argv ?? [];
    expect(argv).not.toContain(BYPASS);
    expect(argv.slice(argv.indexOf('-s'), argv.indexOf('-s') + 2)).toEqual(['-s', 'read-only']);
    expect(argv[argv.indexOf('-C') + 1]).toBe(h.dir);
    expect(launcher.specs[0]?.mounts).toBeUndefined();
    expect(r.text).toContain('PROMPT-SENTINEL');
  });
});

describe('probe', () => {
  it('reports available + authenticated with the tested version, and runs only free commands', async () => {
    h = harness();
    const state = await h.adapter.probe(codexResource(), new AbortController().signal);
    expect(state).toMatchObject({ availability: 'available', auth: 'authenticated' });
    expect(state.detail).toBe('codex-cli 0.159.3');
    expect(h.invocations().map((i) => i.argv)).toEqual([['--version'], ['login', 'status']]);
    expect(h.invocations()[1]?.env['CODEX_HOME']).toBe(join(h.dir, '.codex'));
    expect(applicationEnvKeys(h.invocations()[1]?.env ?? {})).toEqual([
      'CODEX_HOME',
      'HOME',
      'PATH',
    ]);
  });

  it('reports unauthenticated when logged out', async () => {
    h = harness({ 'logged-out': '' });
    const state = await h.adapter.probe(codexResource(), new AbortController().signal);
    expect(state).toMatchObject({ availability: 'available', auth: 'unauthenticated' });
  });

  it('notes a version mismatch but stays available', async () => {
    h = harness({ version: '9.9.9' });
    const state = await h.adapter.probe(codexResource(), new AbortController().signal);
    expect(state.availability).toBe('available');
    expect(state.detail).toContain('codex-cli 9.9.9');
    expect(state.detail).toContain(TESTED_CODEX_VERSION);
  });

  it('reports unavailable for a missing binary', async () => {
    const a = new CodexExecutionAdapter({ binary: '/nonexistent/codex', env: { PATH: '' } });
    const state = await a.probe(codexResource(), new AbortController().signal);
    expect(state.availability).toBe('unavailable');
    expect(state.auth).toBe('unknown');
  });

  it('puts the probed version on later results', async () => {
    h = harness({ version: '0.159.3' });
    await h.adapter.probe(codexResource(), new AbortController().signal);
    const r = await h.adapter.execute({ task: task(), resource: codexResource() }, h.context());
    expect(r.resolved.runtimeVersion).toBe('0.159.3');
  });
});
