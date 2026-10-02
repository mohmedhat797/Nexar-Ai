import { existsSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { adapterId, isNexarError } from '@nexar/contracts';
import type { NexarError } from '@nexar/contracts';
import { afterEach, describe, expect, it } from 'vitest';
import { DelegateSkillsExecutionAdapter, delegateSkillsCodexResource } from './index.js';
import { FAKE_RELAY, harness, isAlive, task, waitFor } from './test/harness.js';
import type { Harness } from './test/harness.js';

let h: Harness | undefined;
afterEach(async () => {
  await h?.cleanup();
  h = undefined;
});

async function rejection(p: Promise<unknown>): Promise<NexarError> {
  try {
    await p;
  } catch (e) {
    if (isNexarError(e)) return e;
    throw e;
  }
  throw new Error('expected rejection');
}

/** Runs the fake relay in `scenario`; returns the harness, the launcher and the outcome promise. */
function run(
  scenario: string,
  options: Record<string, unknown> = {},
  taskInput: Parameters<typeof task>[0] = {},
  env: NodeJS.ProcessEnv = {},
) {
  h = harness(env);
  const launcher = h.launcher(scenario);
  const promise = h.adapter.execute(
    { task: task(taskInput), resource: h.resource(options) },
    h.context(undefined, h.workspace(launcher)),
  );
  return { h, launcher, promise };
}

describe('supports', () => {
  it('matches on runtime.adapter', () => {
    const a = new DelegateSkillsExecutionAdapter({ stateDir: '/nonexistent' });
    expect(a.supports(delegateSkillsCodexResource())).toBe(true);
    const other = delegateSkillsCodexResource();
    expect(
      a.supports({ ...other, runtime: { ...other.runtime, adapter: adapterId('codex') } }),
    ).toBe(false);
  });
});

describe('execute: policy', () => {
  it('rejects without an engineering workspace', async () => {
    h = harness();
    const e = await rejection(
      h.adapter.execute({ task: task(), resource: h.resource() }, h.context()),
    );
    expect(e.code).toBe('POLICY_REJECTED');
    expect(e.message).toContain('engineering workspaces');
    expect(h.invocation()).toBeUndefined();
    expect(h.runDirs()).toEqual([]);
  });

  it('rejects a non-sandbox launcher before preparing or spawning anything', async () => {
    h = harness();
    const launcher = h.launcher('completed', 'none');
    const e = await rejection(
      h.adapter.execute(
        { task: task(), resource: h.resource() },
        h.context(undefined, h.workspace(launcher)),
      ),
    );
    expect(e.code).toBe('POLICY_REJECTED');
    expect(launcher.prepared.count).toBe(0);
    expect(h.invocation()).toBeUndefined();
    expect(h.runDirs()).toEqual([]);
  });

  it('rejects when the launcher applies less isolation than it declared, and still disposes', async () => {
    h = harness();
    const launcher = h.launcher('completed', 'sandbox', { appliedIsolation: 'none' });
    const e = await rejection(
      h.adapter.execute(
        { task: task(), resource: h.resource() },
        h.context(undefined, h.workspace(launcher)),
      ),
    );
    expect(e.code).toBe('POLICY_REJECTED');
    expect(h.invocation()).toBeUndefined();
    expect(launcher.disposed.count).toBe(1);
    expect(h.runDirs()).toEqual([]);
  });

  it('refuses a relay whose sha256 does not match the pin, before spawning', async () => {
    h = harness();
    const launcher = h.launcher('completed');
    const e = await rejection(
      h.adapter.execute(
        { task: task(), resource: h.resource({ relaySha256: 'b'.repeat(64) }) },
        h.context(undefined, h.workspace(launcher)),
      ),
    );
    expect(e.code).toBe('INTEGRATION_UNAVAILABLE');
    expect(e.message).toContain('relay pin mismatch');
    expect(launcher.prepared.count).toBe(0);
    expect(h.invocation()).toBeUndefined();
    expect(h.runDirs()).toEqual([]);
  });

  it('refuses a missing relay file', async () => {
    h = harness();
    const launcher = h.launcher('completed');
    const e = await rejection(
      h.adapter.execute(
        { task: task(), resource: h.resource({ relayPath: join(h.dir, 'gone.mjs') }) },
        h.context(undefined, h.workspace(launcher)),
      ),
    );
    expect(e.code).toBe('INTEGRATION_UNAVAILABLE');
    expect(launcher.prepared.count).toBe(0);
  });

  it('reports a missing Codex home as AUTH_REQUIRED without spawning', async () => {
    h = harness();
    const launcher = h.launcher('completed');
    const e = await rejection(
      h.adapter.execute(
        { task: task(), resource: h.resource({ codexHome: join(h.dir, 'no-codex') }) },
        h.context(undefined, h.workspace(launcher)),
      ),
    );
    expect(e.code).toBe('AUTH_REQUIRED');
    expect(launcher.prepared.count).toBe(0);
  });

  it('rejects an unsupported relay as CONFIGURATION_ERROR', async () => {
    h = harness();
    const launcher = h.launcher('completed');
    const e = await rejection(
      h.adapter.execute(
        { task: task(), resource: h.resource({ relay: 'claude' }) },
        h.context(undefined, h.workspace(launcher)),
      ),
    );
    expect(e.code).toBe('CONFIGURATION_ERROR');
    expect(launcher.prepared.count).toBe(0);
  });
});

describe('execute: launch spec', () => {
  it('requests the exact args, env, mounts, network and workspace', async () => {
    const {
      h: hh,
      launcher,
      promise,
    } = run('completed', {
      model: 'gpt-x',
      effort: 'medium',
      timeout: '45m',
      allowHosts: ['api.openai.com'],
    });
    await promise;
    const [spec] = launcher.specs;
    expect(spec?.command).toBe(process.execPath);
    expect(spec?.args).toEqual([
      '/opt/nexar/relay/relay.mjs',
      '--cd',
      '/work',
      '--out-dir',
      '/opt/nexar/out',
      '--sandbox',
      'danger-full-access',
      '--clean-env',
      '--ignore-user-config',
      '--keep-env',
      'CODEX_HOME',
      '--timeout',
      '45m',
      '--model',
      'gpt-x',
      '--effort',
      'medium',
    ]);
    expect(spec?.env).toEqual({ CODEX_HOME: '/home/agent/.codex', LANG: 'C.UTF-8' });
    expect(spec?.workspace).toBe(join(hh.dir, 'work'));
    expect(spec?.workspaceAccess).toBe('read-write');
    expect(spec?.network).toEqual({ mode: 'proxy', allowHosts: ['api.openai.com'] });

    const mounts = spec?.mounts ?? [];
    expect(mounts).toHaveLength(3);
    // A private copy of the pin-verified bytes is mounted, never the owner's relay directory.
    expect(mounts[0]?.sandboxPath).toBe('/opt/nexar/relay');
    expect(mounts[0]?.access).toBe('read-only');
    expect(mounts[0]?.hostPath.startsWith(join(hh.stateDir, 'relay-'))).toBe(true);
    expect(mounts[0]?.hostPath).not.toBe(join(FAKE_RELAY, '..'));
    expect(mounts[1]?.sandboxPath).toBe('/opt/nexar/out');
    expect(mounts[1]?.access).toBe('read-write');
    expect(mounts[1]?.hostPath.startsWith(hh.stateDir)).toBe(true);
    expect(mounts[2]).toEqual({
      hostPath: hh.codexHome,
      sandboxPath: '/home/agent/.codex',
      access: 'read-write',
    });
  });

  it('omits --model/--effort when unset and uses the default timeout', async () => {
    const { launcher, promise } = run('completed');
    await promise;
    const args = launcher.specs[0]?.args ?? [];
    expect(args).not.toContain('--model');
    expect(args).not.toContain('--effort');
    expect(args.slice(-2)).toEqual(['--timeout', '30m']);
    expect(launcher.specs[0]?.network).toMatchObject({
      mode: 'proxy',
      allowHosts: ['chatgpt.com', 'auth.openai.com', 'api.openai.com'],
    });
  });

  it('passes the workspace access through', async () => {
    h = harness();
    const launcher = h.launcher('completed');
    await h.adapter.execute(
      { task: task(), resource: h.resource() },
      h.context(undefined, h.workspace(launcher, 'read-only')),
    );
    expect(launcher.specs[0]?.workspaceAccess).toBe('read-only');
  });

  it('sends the brief on stdin only, never in argv', async () => {
    const { h: hh, launcher, promise } = run('completed', {}, { systemPrompt: 'SYSTEM-SENTINEL' });
    await promise;
    const call = hh.invocation();
    expect(call?.stdin).toBe('SYSTEM-SENTINEL\n\nBRIEF-SENTINEL');
    expect(call?.argv.join(' ')).not.toContain('SENTINEL');
    expect(JSON.stringify(launcher.specs[0])).not.toContain('SENTINEL');
    // Rewritten host paths reached the relay.
    expect(call?.argv[call.argv.indexOf('--cd') + 1]).toBe(launcher.specs[0]?.workspace);
    expect(call?.cwd).toBe(launcher.specs[0]?.workspace);
  });

  it('passes no parent environment to the relay', async () => {
    const { h: hh, promise } = run(
      'completed',
      {},
      {},
      {
        OPENAI_API_KEY: 'sk-parent',
        CODEX_API_KEY: 'ck-parent',
        GITHUB_TOKEN: 'gh-parent',
      },
    );
    await promise;
    const env = hh.invocation()?.env ?? {};
    for (const name of ['OPENAI_API_KEY', 'CODEX_API_KEY', 'GITHUB_TOKEN', 'HOME']) {
      expect(env[name]).toBeUndefined();
    }
    expect(JSON.stringify(env)).not.toMatch(/sk-parent|ck-parent|gh-parent/);
    expect(env['CODEX_HOME']).toBe('/home/agent/.codex');
    expect(env['LANG']).toBe('C.UTF-8');
  });

  it('takes the Codex home from $CODEX_HOME in the adapter env, never reading it', async () => {
    h = harness({ CODEX_HOME: '/definitely/not/here' });
    const launcher = h.launcher('completed');
    const resource = h.resource();
    const options = { ...resource.runtime.options };
    delete options['codexHome'];
    const e = await rejection(
      h.adapter.execute(
        { task: task(), resource: { ...resource, runtime: { ...resource.runtime, options } } },
        h.context(undefined, h.workspace(launcher)),
      ),
    );
    // Nonexistent directory: AUTH_REQUIRED proves the env path was the one checked.
    expect(e.code).toBe('AUTH_REQUIRED');
  });
});

describe('execute: result mapping', () => {
  it('maps a completed run to text, usage, resolved and events', async () => {
    const { h: hh, launcher, promise } = run('completed', { model: 'gpt-x' });
    const result = await promise;
    expect(result.text).toBe('RELAY-FINAL');
    expect(result.artifacts).toEqual([]);
    expect(result.retries).toBe(0);
    expect(result.usage.inputTokens).toEqual({ status: 'measured', value: 100 });
    expect(result.usage.outputTokens).toEqual({ status: 'measured', value: 10 });
    expect(result.usage.cacheReadTokens).toEqual({ status: 'measured', value: 40 });
    expect(result.usage.turns).toEqual({ status: 'measured', value: 2 });
    expect(result.usage.costUsd.status).toBe('unavailable');
    expect(result.resolved).toEqual({
      provider: 'openai',
      model: 'gpt-relay',
      runtimeVersion: 'codex-cli 0.159.3 relay@6826b36',
    });
    expect(hh.events.map((e) => (e.type === 'status' ? e.message : e.type))).toEqual([
      'relay: started',
      'relay: finished (2 files touched)',
    ]);
    expect(launcher.disposed.count).toBe(1);
  });

  it('falls back to the configured model and reports usage as unavailable for zero usage', async () => {
    const { promise } = run('zero-usage', { model: 'gpt-x' });
    const result = await promise;
    expect(result.resolved.model).toBe('gpt-x');
    expect(result.usage.inputTokens.status).toBe('unavailable');
    expect(result.usage.outputTokens.status).toBe('unavailable');
    expect(result.usage.costUsd.status).toBe('unavailable');
  });

  it('reports usage as unavailable when events.jsonl is missing', async () => {
    const result = await run('no-events').promise;
    expect(result.usage.inputTokens.status).toBe('unavailable');
    expect(result.usage.turns?.status).toBe('unavailable');
  });

  it.each([
    ['failed-auth', 'AUTH_REQUIRED'],
    ['failed-limit', 'QUOTA_EXHAUSTED'],
    ['failed-other', 'PROVIDER_ERROR'],
    ['timeout', 'EXECUTION_TIMEOUT'],
    ['aborted', 'EXECUTION_CANCELLED'],
    ['codex-unavailable', 'INTEGRATION_UNAVAILABLE'],
    ['malformed', 'PROVIDER_ERROR'],
    ['wrong-schema', 'PROVIDER_ERROR'],
    ['bad-types', 'PROVIDER_ERROR'],
    ['missing', 'PROVIDER_ERROR'],
    ['symlink', 'PROVIDER_ERROR'],
  ])('maps %s to %s, disposes, and removes the out dir', async (scenario, code) => {
    const { h: hh, launcher, promise } = run(scenario);
    const e = await rejection(promise);
    expect(e.code).toBe(code);
    expect(launcher.disposed.count).toBe(1);
    expect(hh.runDirs()).toEqual([]);
  });

  it('removes the out dir after a successful run too', async () => {
    const { h: hh, promise } = run('completed');
    await promise;
    expect(hh.runDirs()).toEqual([]);
  });

  it('does not echo the brief in a failure message', async () => {
    const { promise } = run('failed-other', {}, { prompt: 'segfault boom' });
    const e = await rejection(promise);
    expect(e.message).not.toContain('segfault boom');
  });

  // POSIX modes do not implement Windows ACLs.
  it.skipIf(process.platform === 'win32')(
    'creates per-run out dirs under stateDir with mode 0700',
    async () => {
      h = harness();
      let mode: number | undefined;
      const launcher = h.launcher('completed');
      const prepare = launcher.prepare.bind(launcher);
      launcher.prepare = async (spec, signal) => {
        const out = spec.mounts?.find((m) => m.sandboxPath === '/opt/nexar/out')?.hostPath;
        if (out !== undefined) mode = statSync(out).mode & 0o777;
        return prepare(spec, signal);
      };
      await h.adapter.execute(
        { task: task(), resource: h.resource() },
        h.context(undefined, h.workspace(launcher)),
      );
      expect(mode).toBe(0o700);
    },
  );
});

describe('execute: cancellation and timeout', () => {
  it('kills the whole process group on abort', async () => {
    h = harness();
    const launcher = h.launcher('hang');
    const controller = new AbortController();
    const promise = h.adapter.execute(
      { task: task(), resource: h.resource() },
      h.context(controller.signal, h.workspace(launcher)),
    );
    const pidfile = h.pidfile;
    const grandchild = await waitFor(() =>
      existsSync(pidfile) ? Number(readFileSync(pidfile, 'utf8')) : undefined,
    );
    expect(isAlive(grandchild)).toBe(true);
    controller.abort();
    const e = await rejection(promise);
    expect(e.code).toBe('EXECUTION_CANCELLED');
    await waitFor(() => (isAlive(grandchild) ? undefined : true));
    expect(launcher.disposed.count).toBe(1);
    expect(h.runDirs()).toEqual([]);
  });

  it('is cancelled without preparing anything when already aborted', async () => {
    h = harness();
    const launcher = h.launcher('completed');
    const controller = new AbortController();
    controller.abort();
    const e = await rejection(
      h.adapter.execute(
        { task: task(), resource: h.resource() },
        h.context(controller.signal, h.workspace(launcher)),
      ),
    );
    expect(e.code).toBe('EXECUTION_CANCELLED');
    expect(launcher.prepared.count).toBe(0);
  });

  it('kills a relay that outlives its own timeout (outer watchdog)', async () => {
    h = harness({}, { watchdogGraceMs: 100 });
    const launcher = h.launcher('hang');
    const e = await rejection(
      h.adapter.execute(
        { task: task(), resource: h.resource({ timeout: '1s' }) },
        h.context(undefined, h.workspace(launcher)),
      ),
    );
    expect(e.code).toBe('EXECUTION_TIMEOUT');
    expect(launcher.disposed.count).toBe(1);
    expect(h.runDirs()).toEqual([]);
  });

  it('reports a node that cannot start as INTEGRATION_UNAVAILABLE and still disposes', async () => {
    h = harness();
    const launcher = h.launcher('completed');
    const e = await rejection(
      h.adapter.execute(
        { task: task(), resource: h.resource({ nodePath: join(h.dir, 'no-such-node') }) },
        h.context(undefined, h.workspace(launcher)),
      ),
    );
    expect(e.code).toBe('INTEGRATION_UNAVAILABLE');
    expect(launcher.disposed.count).toBe(1);
  });
});

describe('probe', () => {
  it('is available with auth unknown when the pin matches and node runs', async () => {
    h = harness();
    const state = await h.adapter.probe(h.resource(), new AbortController().signal);
    expect(state.availability).toBe('available');
    expect(state.auth).toBe('unknown');
    expect(state.detail).toContain(`node ${process.version}`);
    expect(state.detail).toContain('relay@6826b36');
    expect(h.invocation()).toBeUndefined();
  });

  it('is unavailable on a pin mismatch', async () => {
    h = harness();
    const state = await h.adapter.probe(
      h.resource({ relaySha256: 'c'.repeat(64) }),
      new AbortController().signal,
    );
    expect(state.availability).toBe('unavailable');
    expect(state.detail).toBe('relay pin mismatch');
  });

  it('is unavailable when the relay file is missing', async () => {
    h = harness();
    const state = await h.adapter.probe(
      h.resource({ relayPath: join(h.dir, 'gone.mjs') }),
      new AbortController().signal,
    );
    expect(state.availability).toBe('unavailable');
    expect(state.detail).toBe('relay script not found');
  });

  it('is unavailable when node cannot run', async () => {
    h = harness();
    const state = await h.adapter.probe(
      h.resource({ nodePath: join(h.dir, 'no-such-node') }),
      new AbortController().signal,
    );
    expect(state.availability).toBe('unavailable');
    expect(state.detail).toContain('node not runnable');
  });

  it('throws CONFIGURATION_ERROR for invalid settings', async () => {
    h = harness();
    const e = await rejection(
      h.adapter.probe(h.resource({ relay: 'agy' }), new AbortController().signal),
    );
    expect(e.code).toBe('CONFIGURATION_ERROR');
  });
});
