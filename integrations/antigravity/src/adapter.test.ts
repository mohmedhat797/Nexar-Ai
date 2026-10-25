import { readFileSync, writeFileSync } from 'node:fs';
import { spawn } from 'node:child_process';
import { adapterId, isNexarError } from '@nexar/contracts';
import type { NexarError } from '@nexar/contracts';
import { afterEach, describe, expect, it } from 'vitest';
import {
  AntigravityExecutionAdapter,
  MAX_PROMPT_BYTES,
  TESTED_AGY_VERSION,
  antigravityResource,
} from './index.js';
import { fakeLauncher, harness, isAlive, optedIn, task, waitFor } from './test/harness.js';
import type { Harness } from './test/harness.js';

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

/** Runs one task in a sandboxed workspace and returns the harness plus the launcher. */
function sandboxed(
  harnessInstance: Harness,
  signal?: AbortSignal,
): { launcher: ReturnType<typeof fakeLauncher>; ctx: ReturnType<Harness['context']> } {
  const launcher = fakeLauncher('sandbox');
  return { launcher, ctx: harnessInstance.context(signal, harnessInstance.workspace(launcher)) };
}

describe('supports', () => {
  it('matches on runtime.adapter', () => {
    const a = new AntigravityExecutionAdapter();
    expect(a.supports(antigravityResource())).toBe(true);
    const other = antigravityResource();
    expect(
      a.supports({ ...other, runtime: { ...other.runtime, adapter: adapterId('echo') } }),
    ).toBe(false);
  });
});

describe('execute: opt-in and policy gates', () => {
  it('requires acknowledgeExperimental, pointing at the research note, before anything runs', async () => {
    h = harness();
    const { launcher, ctx } = sandboxed(h);
    const err = await rejection(
      h.adapter.execute({ task: task(), resource: antigravityResource() }, ctx),
    );
    expect(err.code).toBe('CONFIGURATION_ERROR');
    expect(err.message).toContain('docs/research/upstream/v0.3/antigravity.md');
    expect(launcher.prepared.count).toBe(0);
    expect(h.invocations()).toEqual([]);
  });

  it('rejects without a workspace (POLICY_REJECTED), spawning nothing', async () => {
    h = harness();
    const err = await rejection(
      h.adapter.execute({ task: task(), resource: optedIn() }, h.context()),
    );
    expect(err.code).toBe('POLICY_REJECTED');
    expect(h.invocations()).toEqual([]);
  });

  it.each(['read-write', 'read-only'] as const)(
    'rejects a non-sandbox launcher (%s) before preparing or spawning',
    async (access) => {
      h = harness();
      const launcher = fakeLauncher('none');
      const err = await rejection(
        h.adapter.execute(
          { task: task(), resource: optedIn() },
          h.context(undefined, h.workspace(launcher, access)),
        ),
      );
      expect(err.code).toBe('POLICY_REJECTED');
      expect(launcher.prepared.count).toBe(0);
      expect(h.invocations()).toEqual([]);
    },
  );

  it('refuses when the launcher did not apply the sandbox, and still disposes', async () => {
    h = harness();
    const launcher = fakeLauncher('sandbox', { appliedIsolation: 'none' });
    const err = await rejection(
      h.adapter.execute(
        { task: task(), resource: optedIn() },
        h.context(undefined, h.workspace(launcher)),
      ),
    );
    expect(err.code).toBe('POLICY_REJECTED');
    expect(launcher.disposed.count).toBe(1);
    expect(h.invocations()).toEqual([]);
  });

  it('refuses when the workspace is not mounted at /work, and still disposes', async () => {
    h = harness();
    const launcher = fakeLauncher('sandbox', { workspacePath: '/elsewhere' });
    const err = await rejection(
      h.adapter.execute(
        { task: task(), resource: optedIn() },
        h.context(undefined, h.workspace(launcher)),
      ),
    );
    expect(err.code).toBe('SANDBOX_UNAVAILABLE');
    expect(launcher.disposed.count).toBe(1);
    expect(h.invocations()).toEqual([]);
  });

  it('rejects invalid settings before preparing', async () => {
    h = harness();
    const { launcher, ctx } = sandboxed(h);
    const err = await rejection(
      h.adapter.execute({ task: task(), resource: optedIn({ effort: 'extreme' }) }, ctx),
    );
    expect(err.code).toBe('CONFIGURATION_ERROR');
    expect(launcher.prepared.count).toBe(0);
  });

  it('caps the prompt (including the system prompt) at 100 000 bytes -> VALIDATION_ERROR', async () => {
    h = harness();
    const { launcher, ctx } = sandboxed(h);
    const err = await rejection(
      h.adapter.execute(
        { task: task({ prompt: 'x'.repeat(MAX_PROMPT_BYTES + 1) }), resource: optedIn() },
        ctx,
      ),
    );
    expect(err.code).toBe('VALIDATION_ERROR');
    expect(launcher.prepared.count).toBe(0);

    // Multi-byte characters count as bytes, not characters.
    const wide = await rejection(
      h.adapter.execute(
        { task: task({ prompt: 'é'.repeat(MAX_PROMPT_BYTES / 2 + 1) }), resource: optedIn() },
        ctx,
      ),
    );
    expect(wide.code).toBe('VALIDATION_ERROR');
  });

  // The POSIX execution plane supports a 100 kB argv; native Windows CreateProcess does not.
  it.skipIf(process.platform === 'win32')(
    'accepts a prompt at the POSIX argv byte limit',
    async () => {
      h = harness();
      const { ctx } = sandboxed(h);
      const ok = await h.adapter.execute(
        { task: task({ prompt: 'x'.repeat(MAX_PROMPT_BYTES) }), resource: optedIn() },
        ctx,
      );
      expect(ok.text.length).toBeGreaterThan(MAX_PROMPT_BYTES);
    },
  );

  it('an already-aborted signal cancels before preparing', async () => {
    h = harness();
    const ac = new AbortController();
    ac.abort();
    const { launcher, ctx } = sandboxed(h, ac.signal);
    const err = await rejection(h.adapter.execute({ task: task(), resource: optedIn() }, ctx));
    expect(err.code).toBe('EXECUTION_CANCELLED');
    expect(launcher.prepared.count).toBe(0);
  });
});

describe('execute: sandboxed run', () => {
  it('builds the argv and LaunchSpec and spawns exactly the prepared command', async () => {
    h = harness();
    const { launcher, ctx } = sandboxed(h);
    const mounts = [
      { hostPath: '/srv/agy', sandboxPath: '/home/agent/.gemini', access: 'read-write' },
    ];
    const result = await h.adapter.execute(
      {
        task: task({ systemPrompt: 'be brief' }),
        resource: optedIn({
          model: 'gemini-3.1-pro',
          effort: 'high',
          allowHosts: ['example.googleapis.com'],
          sandbox: { mounts },
        }),
      },
      ctx,
    );

    const spec = launcher.specs[0];
    expect(spec?.env).toEqual({ LANG: 'C.UTF-8' });
    expect(spec?.workspace).toBe(h.dir);
    expect(spec?.workspaceAccess).toBe('read-write');
    expect(spec?.network).toEqual({ mode: 'proxy', allowHosts: ['example.googleapis.com'] });
    expect(spec?.mounts).toEqual(mounts);

    const argv = h.invocations()[0]?.argv ?? [];
    expect(argv).toEqual([
      '--output-format',
      'stream-json',
      '--dangerously-skip-permissions',
      '--add-dir',
      '/work',
      '--disable-slash-commands',
      '--model',
      'gemini-3.1-pro',
      '--effort',
      'high',
      '--print=be brief\n\n---\n\nPROMPT-SENTINEL',
    ]);
    expect(argv).not.toContain('--sandbox');
    expect(argv).not.toContain('-p');
    expect(argv).not.toContain('--print');
    expect(result.text).toBe('ECHO: be brief\n\n---\n\nPROMPT-SENTINEL');
    expect(result.resolved).toMatchObject({ provider: 'google', model: 'gemini-3.1-pro' });
    expect(launcher.disposed.count).toBe(1);
  });

  it('uses the default allowlist, passes no mounts, and omits model/effort when unset', async () => {
    h = harness();
    const { launcher, ctx } = sandboxed(h);
    await h.adapter.execute({ task: task(), resource: optedIn() }, ctx);
    expect(launcher.specs[0]?.network).toEqual({
      mode: 'proxy',
      allowHosts: ['cloudcode-pa.googleapis.com', 'oauth2.googleapis.com', 'www.googleapis.com'],
    });
    expect(launcher.specs[0]?.mounts).toBeUndefined();
    const argv = h.invocations()[0]?.argv ?? [];
    expect(argv).not.toContain('--model');
    expect(argv).not.toContain('--effort');
    expect(argv[argv.length - 1]).toBe('--print=PROMPT-SENTINEL');
  });

  it('keeps a prompt starting with a dash inside the --print= argument', async () => {
    h = harness();
    const { ctx } = sandboxed(h);
    await h.adapter.execute({ task: task({ prompt: '--help' }), resource: optedIn() }, ctx);
    const argv = h.invocations()[0]?.argv ?? [];
    expect(argv[argv.length - 1]).toBe('--print=--help');
    expect(argv).not.toContain('--help');
  });

  it('gives the child no parent environment variables', async () => {
    h = harness(
      {},
      { GOOGLE_API_KEY: 'g-secret', GEMINI_API_KEY: 'k', GITHUB_TOKEN: 't', LANG: 'C' },
    );
    const { ctx } = sandboxed(h);
    await h.adapter.execute({ task: task(), resource: optedIn() }, ctx);
    const env = h.invocations()[0]?.env ?? {};
    // PATH comes from the (fake) launcher; the adapter itself contributes LANG only.
    expect(applicationEnvKeys(env)).toEqual(['LANG', 'PATH']);
    expect(env['LANG']).toBe('C.UTF-8');
  });

  it('maps usage (thinking added to output), turns, and unknown cost', async () => {
    h = harness();
    const { ctx } = sandboxed(h);
    const r = await h.adapter.execute({ task: task(), resource: optedIn() }, ctx);
    expect(r.usage.inputTokens).toEqual({ status: 'measured', value: 100 });
    expect(r.usage.outputTokens).toEqual({ status: 'measured', value: 15 });
    expect(r.usage.cacheReadTokens).toEqual({ status: 'measured', value: 40 });
    expect(r.usage.turns).toEqual({ status: 'measured', value: 2 });
    expect(r.usage.costUsd.status).toBe('unavailable');
    expect(r.retries).toBe(0);
  });

  it('reports unavailable (not 0) for zero usage', async () => {
    h = harness({ mode: 'zero-usage' });
    const { ctx } = sandboxed(h);
    const r = await h.adapter.execute({ task: task(), resource: optedIn() }, ctx);
    expect(r.text).toBe('ok');
    expect(r.usage.inputTokens.status).toBe('unavailable');
    expect(r.usage.outputTokens.status).toBe('unavailable');
  });

  it('emits tool names once, never parameters, output or deltas', async () => {
    h = harness({ mode: 'activity' });
    const { ctx } = sandboxed(h);
    const r = await h.adapter.execute({ task: task(), resource: optedIn() }, ctx);
    expect(r.text).toBe('final answer');
    expect(h.events.filter((e) => e.type === 'tool-call')).toEqual([
      { type: 'tool-call', name: 'run_command' },
    ]);
    const all = JSON.stringify(h.events);
    expect(all).not.toContain('SECRET-COMMAND-TEXT');
    expect(all).not.toContain('SECRET-OUTPUT-TEXT');
    expect(all).not.toContain('SECRET-DELTA');
  });

  it('ignores garbage stdout lines', async () => {
    h = harness({ mode: 'garbage' });
    const { ctx } = sandboxed(h);
    const r = await h.adapter.execute({ task: task(), resource: optedIn() }, ctx);
    expect(r.text).toBe('after garbage');
  });

  it('counts soft permission denials in a status event and still succeeds', async () => {
    h = harness({ mode: 'denial' });
    const { ctx } = sandboxed(h);
    const r = await h.adapter.execute({ task: task(), resource: optedIn() }, ctx);
    expect(r.text).toBe('partial');
    expect(h.events).toContainEqual({ type: 'status', message: 'agy: permission denied (2)' });
    expect(h.events).toContainEqual({
      type: 'status',
      message: 'agy: finished (2 soft permission denials)',
    });
  });

  it('puts the probed version on later results', async () => {
    h = harness();
    await h.adapter.probe(optedIn(), new AbortController().signal);
    const { ctx } = sandboxed(h);
    const r = await h.adapter.execute({ task: task(), resource: optedIn() }, ctx);
    expect(r.resolved.runtimeVersion).toBe(TESTED_AGY_VERSION);
  });

  it('allows only one running agy per adapter; a second call is retryable RESOURCE_UNAVAILABLE', async () => {
    h = harness({ mode: 'hang' });
    const ac = new AbortController();
    const first = sandboxedRun(h, ac.signal);
    await waitFor(() => (h?.invocations().length ? true : undefined));

    const { launcher, ctx } = sandboxed(h);
    const err = await rejection(h.adapter.execute({ task: task(), resource: optedIn() }, ctx));
    expect(err.code).toBe('RESOURCE_UNAVAILABLE');
    expect(err.retryable).toBe(true);
    expect(launcher.prepared.count).toBe(0);

    ac.abort();
    expect((await rejection(first)).code).toBe('EXECUTION_CANCELLED');
    // The slot is free again once the first run has finished.
    const { ctx: ctx3 } = sandboxed(h);
    const again = await rejection(
      h.adapter.execute({ task: task(), resource: optedIn({ timeoutMs: 300 }) }, ctx3),
    );
    expect(again.code).toBe('EXECUTION_TIMEOUT');
  });
});

function sandboxedRun(harnessInstance: Harness, signal: AbortSignal): Promise<unknown> {
  const { ctx } = sandboxed(harnessInstance, signal);
  return harnessInstance.adapter.execute({ task: task(), resource: optedIn() }, ctx);
}

describe('execute: failures', () => {
  it('result status ERROR -> PROVIDER_ERROR with the error text', async () => {
    h = harness({ mode: 'error' });
    const { launcher, ctx } = sandboxed(h);
    const err = await rejection(h.adapter.execute({ task: task(), resource: optedIn() }, ctx));
    expect(err.code).toBe('PROVIDER_ERROR');
    expect(err.message).toContain('the model fell over');
    expect(launcher.disposed.count).toBe(1);
  });

  it('exit 3 with AGY_ERROR -> PROVIDER_ERROR, honoring its retryable flag', async () => {
    h = harness({ mode: 'exit3' });
    const { ctx } = sandboxed(h);
    const err = await rejection(h.adapter.execute({ task: task(), resource: optedIn() }, ctx));
    expect(err.code).toBe('PROVIDER_ERROR');
    expect(err.retryable).toBe(true);
    expect(err.message).toContain('exit 3');
    expect(err.message).toContain('INTERNAL');
  });

  it('AGY_ERROR RESOURCE_EXHAUSTED -> QUOTA_EXHAUSTED, not retryable per agy', async () => {
    h = harness({ mode: 'quota' });
    const { ctx } = sandboxed(h);
    const err = await rejection(h.adapter.execute({ task: task(), resource: optedIn() }, ctx));
    expect(err.code).toBe('QUOTA_EXHAUSTED');
    expect(err.retryable).toBe(false);
  });

  it('exit 0 without a result event -> PROVIDER_ERROR', async () => {
    h = harness({ mode: 'no-result' });
    const { ctx } = sandboxed(h);
    const err = await rejection(h.adapter.execute({ task: task(), resource: optedIn() }, ctx));
    expect(err.code).toBe('PROVIDER_ERROR');
    expect(err.message).toContain('no result');
  });

  it('never echoes the prompt in an error message', async () => {
    h = harness({ mode: 'error' });
    const { ctx } = sandboxed(h);
    const err = await rejection(
      h.adapter.execute(
        { task: task({ prompt: 'the model fell over' }), resource: optedIn() },
        ctx,
      ),
    );
    expect(err.message).not.toContain('the model fell over');
    expect(err.message).toContain('[redacted]');
  });

  it('an interactive OAuth attempt -> AUTH_REQUIRED, and the process group is killed', async () => {
    let signalAt: number | undefined;
    const requestedAt = performance.now();
    const observeSpawn = ((...args: Parameters<typeof spawn>) => {
      const child = spawn(...args);
      let pending = '';
      const observe = (chunk: Buffer) => {
        pending = (pending + chunk.toString('utf8')).slice(-1024);
        if (pending.includes('Print mode: triggering interactive OAuth\n'))
          signalAt ??= performance.now();
      };
      child.stderr?.on('data', observe);
      child.once('close', () => child.stderr?.removeListener('data', observe));
      return child;
    }) as typeof spawn;
    h = harness({ mode: 'oauth' }, {}, { spawnImpl: observeSpawn });
    const { launcher, ctx } = sandboxed(h);
    const err = await rejection(h.adapter.execute({ task: task(), resource: optedIn() }, ctx));
    const settledAt = performance.now();
    expect(err.code).toBe('AUTH_REQUIRED');
    expect(err.message).toContain("sign in with 'agy' yourself");
    if (signalAt === undefined) throw new Error('Expected the complete fake OAuth signal');
    expect(settledAt - signalAt).toBeLessThan(4000);
    process.stdout.write(
      `antigravity fixture phases ${JSON.stringify({
        requestToSignalMs: Math.round(signalAt - requestedAt),
        signalToRejectionMs: Math.round(settledAt - signalAt),
      })}\n`,
    );
    const pid = readPid(h);
    expect(Number.isNaN(pid)).toBe(false);
    await waitFor(() => (isAlive(pid) ? undefined : true));
    const parent = h.invocations()[0]?.pid ?? 0;
    expect(isAlive(parent)).toBe(false);
    expect(launcher.disposed.count).toBe(1);
  });

  it('a missing binary -> INTEGRATION_UNAVAILABLE, and the launch is disposed', async () => {
    const a = new AntigravityExecutionAdapter({ binary: '/nonexistent/agy', env: { PATH: '' } });
    h = harness();
    const launcher = fakeLauncher('sandbox');
    const err = await rejection(
      a.execute({ task: task(), resource: optedIn() }, h.context(undefined, h.workspace(launcher))),
    );
    expect(err.code).toBe('INTEGRATION_UNAVAILABLE');
    expect(launcher.disposed.count).toBe(1);
  });

  it('oversized output -> PROVIDER_ERROR and the child is killed', async () => {
    h = harness({ mode: 'bigline' });
    const { ctx } = sandboxed(h);
    const err = await rejection(h.adapter.execute({ task: task(), resource: optedIn() }, ctx));
    expect(err.code).toBe('PROVIDER_ERROR');
    const parent = h.invocations()[0]?.pid ?? 0;
    await waitFor(() => (isAlive(parent) ? undefined : true));
  });
});

/** The grandchild pid the fake wrote, or NaN before it exists. */
function readPid(harnessInstance: Harness): number {
  try {
    const value = Number(readFileSync(harnessInstance.pidfile, 'utf8').trim());
    return Number.isSafeInteger(value) && value > 0 ? value : Number.NaN;
  } catch {
    return Number.NaN;
  }
}

/** Always stop an owned hanging execution, including when fixture readiness fails. */
async function withCancelledExecution<T>(
  instance: Harness,
  body: (execution: {
    cancel: () => void;
    run: Promise<NexarError>;
    launcher: ReturnType<typeof fakeLauncher>;
  }) => Promise<T>,
): Promise<T> {
  const ac = new AbortController();
  const { launcher, ctx } = sandboxed(instance, ac.signal);
  const run = rejection(instance.adapter.execute({ task: task(), resource: optedIn() }, ctx));
  let outcome: { ok: true; value: T } | { ok: false; error: unknown };
  try {
    outcome = { ok: true, value: await body({ cancel: () => ac.abort(), run, launcher }) };
  } catch (error) {
    outcome = { ok: false, error };
  }
  ac.abort();
  try {
    await run;
  } catch (cleanupError) {
    if (!outcome.ok)
      throw new AggregateError(
        [outcome.error, cleanupError],
        'Fixture failure and cancellation failed',
        {
          cause: cleanupError,
        },
      );
    throw cleanupError;
  }
  if (!outcome.ok) throw outcome.error;
  return outcome.value;
}

describe('fake runtime PID readiness', () => {
  it.each(['', ' ', '0', '-1', 'NaN', '1.5', '9007199254740992'])(
    'does not treat invalid PID text %j as readiness',
    (value) => {
      h = harness();
      writeFileSync(h.pidfile, value);
      expect(readPid(h)).toBeNaN();
    },
  );
  it('accepts a published positive integer PID', () => {
    h = harness();
    writeFileSync(h.pidfile, '12345');
    expect(readPid(h)).toBe(12345);
  });
});

// Each case spawns the fake runtime and its grandchild, kills the tree with taskkill (bounded at
// 5 s on Windows), allows 10 s for fake-runtime startup and 5 s to observe process death: the suite's
// own bounds exceed the 5 s default on a loaded Windows runner. Assertions are unchanged.
describe(
  'execute: timeout and abort kill the process group and dispose',
  { timeout: process.platform === 'win32' ? 20_000 : 5_000 },
  () => {
    it('timeout -> EXECUTION_TIMEOUT, grandchild dies, launch disposed', async () => {
      h = harness({ mode: 'hang' });
      const { launcher, ctx } = sandboxed(h);
      const err = await rejection(
        h.adapter.execute({ task: task(), resource: optedIn({ timeoutMs: 400 }) }, ctx),
      );
      expect(err.code).toBe('EXECUTION_TIMEOUT');
      expect(launcher.disposed.count).toBe(1);
      const pid = readPid(h);
      await waitFor(() => (isAlive(pid) ? undefined : true));
    });

    it('abort -> EXECUTION_CANCELLED, grandchild dies, launch disposed', async () => {
      const hh = harness({ mode: 'hang' });
      h = hh;
      await withCancelledExecution(hh, async ({ cancel, run, launcher }) => {
        await waitFor(() => (Number.isNaN(readPid(hh)) ? undefined : true), 10_000);
        const pid = readPid(hh);
        const parent = hh.invocations()[0]?.pid ?? 0;
        expect(parent).toBeGreaterThan(0);
        cancel();
        expect((await run).code).toBe('EXECUTION_CANCELLED');
        expect(launcher.disposed.count).toBe(1);
        await waitFor(() => (isAlive(pid) || isAlive(parent) ? undefined : true));
      });
    });

    it('a fixture readiness error still cancels execution and observes owned tree exit', async () => {
      const hh = harness({ mode: 'hang' });
      h = hh;
      let pid = Number.NaN;
      let parent = Number.NaN;
      let disposed: { count: number } | undefined;
      await expect(
        withCancelledExecution(hh, async ({ launcher }) => {
          await waitFor(() => (Number.isNaN(readPid(hh)) ? undefined : true), 10_000);
          pid = readPid(hh);
          parent = hh.invocations()[0]?.pid ?? Number.NaN;
          disposed = launcher.disposed;
          throw new Error('Synthetic fixture readiness failure');
        }),
      ).rejects.toThrow('Synthetic fixture readiness failure');
      expect(Number.isSafeInteger(pid) && pid > 0).toBe(true);
      expect(Number.isSafeInteger(parent) && parent > 0).toBe(true);
      expect(disposed?.count).toBe(1);
      await waitFor(() => (isAlive(pid) || isAlive(parent) ? undefined : true));
    });
  },
);

describe('probe', () => {
  it('runs only `--version`, never lists models or infers authentication', async () => {
    h = harness();
    const state = await h.adapter.probe(optedIn(), new AbortController().signal);
    expect(state).toMatchObject({ availability: 'available', auth: 'unknown' });
    expect(state.detail).toBe('agy 1.2.14');
    const calls = h.invocations();
    expect(calls.map((i) => i.argv)).toEqual([['--version']]);
    for (const call of calls) {
      expect(call.argv.some((a) => a === '-p' || a.startsWith('--print') || a === '--prompt')).toBe(
        false,
      );
      expect(applicationEnvKeys(call.env)).toEqual(['HOME', 'PATH']);
    }
  });

  it('does not run the potentially interactive listing for a logged-out runtime', async () => {
    h = harness({ 'logged-out': '' });
    const state = await h.adapter.probe(optedIn(), new AbortController().signal);
    expect(state).toMatchObject({ availability: 'available', auth: 'unknown' });
    expect(h.invocations().map((i) => i.argv)).toEqual([['--version']]);
  });

  it('reports unknown auth regardless of catalog availability', async () => {
    h = harness({ 'models-empty': '' });
    const state = await h.adapter.probe(optedIn(), new AbortController().signal);
    expect(state).toMatchObject({ availability: 'available', auth: 'unknown' });
  });

  it('is degraded, naming the opt-in, without acknowledgeExperimental', async () => {
    h = harness();
    const state = await h.adapter.probe(antigravityResource(), new AbortController().signal);
    expect(state.availability).toBe('degraded');
    expect(state.auth).toBe('unknown');
    expect(state.detail).toContain('experimental: set acknowledgeExperimental');
    expect(h.invocations().map((i) => i.argv)).toEqual([['--version']]);
  });

  it('notes a version mismatch but stays available', async () => {
    h = harness({ version: '9.9.9' });
    const state = await h.adapter.probe(optedIn(), new AbortController().signal);
    expect(state.availability).toBe('available');
    expect(state.detail).toContain('9.9.9');
    expect(state.detail).toContain(TESTED_AGY_VERSION);
  });

  it('keeps malformed version output private and reports unknown authentication', async () => {
    h = harness({ version: '1.2.14 SECRET-CANARY' });
    const state = await h.adapter.probe(optedIn(), new AbortController().signal);
    expect(state).toMatchObject({ availability: 'available', auth: 'unknown' });
    expect(JSON.stringify(state)).not.toContain('SECRET-CANARY');
    expect(h.invocations().map((i) => i.argv)).toEqual([['--version']]);
  });

  it('reports unavailable for a missing binary', async () => {
    const a = new AntigravityExecutionAdapter({ binary: '/nonexistent/agy', env: { PATH: '' } });
    const state = await a.probe(optedIn(), new AbortController().signal);
    expect(state.availability).toBe('unavailable');
    expect(state.auth).toBe('unknown');
  });
});
