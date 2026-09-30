import { adapterId, isNexarError, valueOf } from '@nexar/contracts';
import type { NexarError, ResourceDescriptor } from '@nexar/contracts';
import { afterEach, describe, expect, it } from 'vitest';
import { ClaudeCodeExecutionAdapter, claudeCodeResource } from './index.js';
import { harness, isAlive, silentLogger, task, waitFor } from './test/harness.js';
import type { Harness } from './test/harness.js';

let h: Harness | undefined;
afterEach(() => {
  h?.cleanup();
  h = undefined;
});

function withOptions(options: Record<string, unknown>): ResourceDescriptor {
  const base = claudeCodeResource();
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
    const a = new ClaudeCodeExecutionAdapter();
    expect(a.supports(claudeCodeResource())).toBe(true);
    const other = claudeCodeResource();
    expect(
      a.supports({ ...other, runtime: { ...other.runtime, adapter: adapterId('echo') } }),
    ).toBe(false);
  });
});

describe('execute: invocation', () => {
  it('passes the prompt on stdin only and builds the expected argv', async () => {
    h = harness({ FAKE_CLAUDE_MODE: 'success', FAKE_CLAUDE_ENV_KEYS: 'X' });
    await h.adapter.execute(
      {
        task: task({ systemPrompt: 'be brief', workingDirectory: process.cwd() }),
        resource: withOptions({ model: 'claude-opus-x', maxTurns: 4, permissionMode: 'default' }),
      },
      h.context(),
    );
    const [call] = h.invocations();
    expect(call?.stdin).toBe('PROMPT-SENTINEL');
    expect(call?.argv).toEqual([
      '-p',
      '--output-format',
      'json',
      '--no-session-persistence',
      '--permission-mode',
      'default',
      '--model',
      'claude-opus-x',
      '--max-turns',
      '4',
      '--append-system-prompt',
      'be brief',
      '--tools',
      'Read',
      'Glob',
      'Grep',
    ]);
    expect(call?.argv.join(' ')).not.toContain('PROMPT-SENTINEL');
  });

  it('defaults to plan mode, read-only tools and no --model', async () => {
    h = harness();
    await h.adapter.execute({ task: task(), resource: claudeCodeResource() }, h.context());
    const argv = h.invocations()[0]?.argv ?? [];
    expect(argv).toEqual([
      '-p',
      '--output-format',
      'json',
      '--no-session-persistence',
      '--permission-mode',
      'plan',
      '--tools',
      'Read',
      'Glob',
      'Grep',
    ]);
  });

  it('keeps --tools last so the variadic flag cannot swallow other flags', async () => {
    h = harness();
    await h.adapter.execute(
      {
        task: task({ systemPrompt: 's' }),
        resource: withOptions({ tools: ['Read', 'Edit'], maxTurns: 2 }),
      },
      h.context(),
    );
    const argv = h.invocations()[0]?.argv ?? [];
    expect(argv.slice(argv.indexOf('--tools'))).toEqual(['--tools', 'Read', 'Edit']);
  });

  it('passes an empty tool list as a single empty argument', async () => {
    h = harness();
    await h.adapter.execute({ task: task(), resource: withOptions({ tools: [] }) }, h.context());
    const argv = h.invocations()[0]?.argv ?? [];
    expect(argv.slice(-2)).toEqual(['--tools', '']);
  });

  it('resolves the model: options.model > kind.underlying.model > CLI default', async () => {
    h = harness();
    const base = claudeCodeResource();
    const kindModel: ResourceDescriptor = {
      ...base,
      kind: { ...base.kind, underlying: { provider: 'anthropic', model: 'kind-model' } } as never,
    };
    const optModel: ResourceDescriptor = {
      ...kindModel,
      runtime: { ...kindModel.runtime, options: { model: 'opt-model' } },
    };
    const modelArg = (): string | undefined => {
      const argv = h?.invocations().at(-1)?.argv ?? [];
      return argv[argv.indexOf('--model') + 1];
    };

    await h.adapter.execute({ task: task(), resource: optModel }, h.context());
    expect(modelArg()).toBe('opt-model');
    await h.adapter.execute({ task: task(), resource: kindModel }, h.context());
    expect(modelArg()).toBe('kind-model');
    await h.adapter.execute({ task: task(), resource: base }, h.context());
    expect(h.invocations().at(-1)?.argv).not.toContain('--model');
  });

  it('runs in the task working directory', async () => {
    h = harness();
    await h.adapter.execute(
      { task: task({ workingDirectory: '/' }), resource: claudeCodeResource() },
      h.context(),
    );
    expect(h.invocations()[0]?.cwd).toBe('/');
  });

  it('scrubs foreign credentials but keeps Claude/Anthropic variables', async () => {
    h = harness({
      FAKE_CLAUDE_ENV_KEYS: 'CLAUDE_X,ANTHROPIC_BASE_URL',
      GH_TOKEN: 'secret',
      GITHUB_TOKEN: 'secret',
      AWS_ACCESS_KEY_ID: 'secret',
      CLAUDECODE: '1',
      CLAUDE_X: 'kept',
      ANTHROPIC_BASE_URL: 'https://proxy.example',
    });
    await h.adapter.execute({ task: task(), resource: claudeCodeResource() }, h.context());
    const call = h.invocations()[0];
    expect(call?.envNames).not.toContain('GH_TOKEN');
    expect(call?.envNames).not.toContain('GITHUB_TOKEN');
    expect(call?.envNames).not.toContain('AWS_ACCESS_KEY_ID');
    expect(call?.envNames).not.toContain('CLAUDECODE');
    expect(call?.env).toEqual({ CLAUDE_X: 'kept', ANTHROPIC_BASE_URL: 'https://proxy.example' });
  });

  it('rejects invalid runtime.options before spawning', async () => {
    h = harness();
    const err = await rejection(
      h.adapter.execute({ task: task(), resource: withOptions({ maxTurns: 'x' }) }, h.context()),
    );
    expect(err.code).toBe('CONFIGURATION_ERROR');
    expect(h.invocations()).toHaveLength(0);
  });
});

describe('execute: success', () => {
  it('maps text, usage, cost, model and emits status events', async () => {
    h = harness();
    const result = await h.adapter.execute(
      { task: task(), resource: withOptions({ model: 'claude-requested' }) },
      h.context(),
    );
    expect(result.text).toBe('ECHO: PROMPT-SENTINEL');
    expect(result.retries).toBe(0);
    expect(result.artifacts).toEqual([]);
    expect(result.resolved).toEqual({ provider: 'anthropic', model: 'claude-requested' });
    expect(result.usage).toEqual({
      inputTokens: { status: 'measured', value: 10 },
      outputTokens: { status: 'measured', value: 5 },
      cacheReadTokens: { status: 'measured', value: 3 },
      cacheWriteTokens: { status: 'measured', value: 2 },
      costUsd: {
        status: 'estimated',
        value: 0.0123,
        basis: 'claude CLI list-price estimate',
      },
      turns: { status: 'measured', value: 1 },
    });
    expect(h.events).toEqual([
      { type: 'status', message: 'claude: started' },
      { type: 'status', message: 'claude: finished' },
    ]);
  });

  it('takes the resolved model from modelUsage when none was requested', async () => {
    h = harness();
    const result = await h.adapter.execute(
      { task: task(), resource: claudeCodeResource() },
      h.context(),
    );
    expect(result.resolved.model).toBe('claude-fake-default');
  });

  it('reports unavailable (never zero) for figures the CLI omits', async () => {
    h = harness({ FAKE_CLAUDE_OMIT_USAGE: '1' });
    const { usage } = await h.adapter.execute(
      { task: task(), resource: claudeCodeResource() },
      h.context(),
    );
    const reason = 'not reported by claude CLI';
    expect(usage.inputTokens).toEqual({ status: 'unavailable', reason });
    expect(usage.outputTokens).toEqual({ status: 'unavailable', reason });
    expect(usage.cacheReadTokens).toEqual({ status: 'unavailable', reason });
    expect(usage.costUsd).toEqual({ status: 'unavailable', reason });
    expect(valueOf(usage.turns ?? { status: 'unavailable' })).toBe(1);
  });

  it('includes the runtime version once probed', async () => {
    h = harness();
    await h.adapter.probe(claudeCodeResource(), new AbortController().signal);
    const { resolved } = await h.adapter.execute(
      { task: task(), resource: claudeCodeResource() },
      h.context(),
    );
    expect(resolved.runtimeVersion).toBe('9.9.9 (Claude Code fake)');
  });
});

describe('execute: errors', () => {
  const run = (hh: Harness, resource = claudeCodeResource(), signal?: AbortSignal) =>
    hh.adapter.execute({ task: task(), resource }, hh.context(signal));

  it('maps is_error / non-zero exit to PROVIDER_ERROR without leaking the prompt', async () => {
    h = harness({ FAKE_CLAUDE_MODE: 'error' });
    const err = await rejection(run(h));
    expect(err.code).toBe('PROVIDER_ERROR');
    expect(err.details).toEqual({ exitCode: 1, subtype: 'error_during_execution' });
    expect(err.message).toContain('error_during_execution');
    expect(err.message).toContain('529');
    expect(err.message).toContain('upstream exploded');
    expect(err.message).not.toContain('PROMPT-SENTINEL');
  });

  it('maps unparseable stdout to PROVIDER_ERROR', async () => {
    h = harness({ FAKE_CLAUDE_MODE: 'garbage' });
    const err = await rejection(run(h));
    expect(err.code).toBe('PROVIDER_ERROR');
    expect(err.details).toEqual({ exitCode: 0 });
  });

  it('maps a login failure to AUTH_REQUIRED', async () => {
    h = harness({ FAKE_CLAUDE_MODE: 'auth' });
    const err = await rejection(run(h));
    expect(err.code).toBe('AUTH_REQUIRED');
    expect(err.details).toEqual({ exitCode: 1 });
  });

  it('maps a missing binary to INTEGRATION_UNAVAILABLE', async () => {
    const a = new ClaudeCodeExecutionAdapter({ binary: '/nonexistent/definitely-not-claude' });
    const err = await rejection(
      a.execute(
        { task: task(), resource: claudeCodeResource() },
        {
          signal: new AbortController().signal,
          logger: silentLogger,
        },
      ),
    );
    expect(err.code).toBe('INTEGRATION_UNAVAILABLE');
  });

  it('kills the child and throws EXECUTION_TIMEOUT', async () => {
    h = harness({ FAKE_CLAUDE_MODE: 'hang' });
    const started = Date.now();
    const err = await rejection(run(h, withOptions({ timeoutMs: 300 })));
    expect(err.code).toBe('EXECUTION_TIMEOUT');
    expect(Date.now() - started).toBeLessThan(2500);
    const pid = h.invocations()[0]?.pid;
    expect(pid).toBeDefined();
    expect(isAlive(pid as number)).toBe(false);
  });

  it('kills the child and throws EXECUTION_CANCELLED on abort', async () => {
    h = harness({ FAKE_CLAUDE_MODE: 'hang' });
    const controller = new AbortController();
    const pending = rejection(run(h, claudeCodeResource(), controller.signal));
    const pid = await waitFor(() => h?.invocations()[0]?.pid);
    expect(isAlive(pid)).toBe(true);

    const started = Date.now();
    controller.abort();
    const err = await pending;
    expect(err.code).toBe('EXECUTION_CANCELLED');
    expect(Date.now() - started).toBeLessThan(1500);
    expect(isAlive(pid)).toBe(false);
  });

  it('does not spawn when already aborted', async () => {
    h = harness();
    const controller = new AbortController();
    controller.abort();
    const err = await rejection(run(h, claudeCodeResource(), controller.signal));
    expect(err.code).toBe('EXECUTION_CANCELLED');
    expect(h.invocations()).toHaveLength(0);
  });
});

describe('probe', () => {
  const NOW = new Date('2026-02-03T04:05:06.000Z');
  const signal = (): AbortSignal => new AbortController().signal;

  it('reports available + authenticated without running a model call', async () => {
    h = harness({}, { clock: () => NOW });
    const state = await h.adapter.probe(claudeCodeResource(), signal());
    expect(state).toEqual({
      availability: 'available',
      auth: 'authenticated',
      detail: '9.9.9 (Claude Code fake)',
      observedAt: NOW.toISOString(),
    });
    expect(h.invocations().map((i) => i.argv)).toEqual([['--version'], ['auth', 'status']]);
  });

  it('reports unauthenticated when logged out', async () => {
    h = harness({ FAKE_CLAUDE_LOGGED_OUT: '1' });
    const state = await h.adapter.probe(claudeCodeResource(), signal());
    expect(state).toMatchObject({ availability: 'available', auth: 'unauthenticated' });
  });

  it('reports unavailable/unknown when the binary is missing', async () => {
    const a = new ClaudeCodeExecutionAdapter({
      binary: '/nonexistent/definitely-not-claude',
      clock: () => NOW,
    });
    const state = await a.probe(claudeCodeResource(), signal());
    expect(state.availability).toBe('unavailable');
    expect(state.auth).toBe('unknown');
    expect(state.detail).toContain('not runnable');
  });

  it('reports auth unknown when auth status is unparseable', async () => {
    const a = new ClaudeCodeExecutionAdapter({
      binary: {
        command: process.execPath,
        args: ['-e', "console.log(process.argv[1] === '--version' ? '1.0.0' : 'nope')"],
      },
    });
    const state = await a.probe(claudeCodeResource(), signal());
    expect(state).toMatchObject({ availability: 'available', auth: 'unknown' });
  });

  it('throws EXECUTION_CANCELLED when aborted', async () => {
    h = harness();
    const controller = new AbortController();
    controller.abort();
    const err = await rejection(h.adapter.probe(claudeCodeResource(), controller.signal));
    expect(err.code).toBe('EXECUTION_CANCELLED');
  });
});
