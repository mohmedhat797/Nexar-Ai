import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { isNexarError } from '@nexar/contracts';
import type {
  EngineeringWorkspace,
  ExecutionContext,
  LaunchSpec,
  NexarError,
  PreparedLaunch,
  ProcessLauncher,
  ResourceDescriptor,
} from '@nexar/contracts';
import { afterEach, describe, expect, it } from 'vitest';
import { claudeCodeResource } from './index.js';
import { harness, task, waitFor } from './test/harness.js';
import type { Harness } from './test/harness.js';

let h: Harness | undefined;
afterEach(async () => {
  await h?.cleanup();
  h = undefined;
});

const WORKSPACE = mkdtempSync(join(tmpdir(), 'nexar-claude-ws-'));

const DENY_RULES = [
  'Bash(git commit:*)',
  'Bash(git commit *)',
  'Bash(git push:*)',
  'Bash(git push *)',
  'Bash(git add:*)',
  'Bash(git add *)',
  'Bash(git reset *)',
  'Bash(git checkout *)',
  'Bash(git remote *)',
  'Bash(git config *)',
];

const COMMON_ARGS = [
  '-p',
  '--output-format',
  'stream-json',
  '--verbose',
  '--no-session-persistence',
  '--permission-mode',
  'acceptEdits',
  '--permission-prompts',
  'none',
  '--setting-sources',
  'user',
  '--strict-mcp-config',
  '--disable-slash-commands',
  '--settings',
  '{"sandbox":{"enabled":false}}',
];

function request(options: Record<string, unknown> = {}, systemPrompt?: string) {
  const base = claudeCodeResource();
  const resource: ResourceDescriptor = { ...base, runtime: { ...base.runtime, options } };
  return { task: task(systemPrompt === undefined ? {} : { systemPrompt }), resource };
}

interface FakeLauncher extends ProcessLauncher {
  readonly specs: LaunchSpec[];
  disposed: number;
  prepareCalls: number;
}

/**
 * Passes the spec through unchanged (a real launcher would wrap it). `extraEnv` models the vars a
 * launcher adds itself; here it also forwards the fake runtime's control variables.
 */
function fakeLauncher(
  isolation: 'none' | 'sandbox',
  extraEnv: Record<string, string> = {},
  failPrepare = false,
): FakeLauncher {
  const launcher: FakeLauncher = {
    isolation,
    specs: [],
    disposed: 0,
    prepareCalls: 0,
    prepare: (spec) => {
      launcher.prepareCalls++;
      launcher.specs.push(spec);
      if (failPrepare) return Promise.reject(new Error('prepare failed'));
      const prepared: PreparedLaunch = {
        command: spec.command,
        args: spec.args,
        env: { ...spec.env, ...extraEnv },
        cwd: spec.workspace,
        workspacePath: '/work',
        isolation,
        dispose: () => {
          launcher.disposed++;
          return Promise.resolve();
        },
      };
      return Promise.resolve(prepared);
    },
  };
  return launcher;
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

function rig(
  isolation: 'none' | 'sandbox',
  access: 'read-only' | 'read-write',
  fakeEnv: Record<string, string> = {},
  parentEnv: NodeJS.ProcessEnv = {},
) {
  const hh = harness(parentEnv);
  h = hh;
  const launcher = fakeLauncher(isolation, {
    FAKE_CLAUDE_RECORD: hh.recordFile,
    FAKE_CLAUDE_ENV_KEYS: 'ANTHROPIC_API_KEY',
    ...fakeEnv,
  });
  const workspace: EngineeringWorkspace = { path: WORKSPACE, access, launcher };
  const ctx = (signal?: AbortSignal): ExecutionContext => ({ ...hh.context(signal), workspace });
  return { hh, launcher, ctx };
}

describe('mode selection', () => {
  it('rejects write mode without a sandbox before preparing or spawning anything', async () => {
    const { hh, launcher, ctx } = rig('none', 'read-write');
    const err = await rejection(hh.adapter.execute(request(), ctx()));
    expect(err.code).toBe('POLICY_REJECTED');
    expect(launcher.prepareCalls).toBe(0);
    expect(hh.invocations()).toEqual([]);
  });

  it('runs read-only through the launcher with a proxy network when there is no sandbox', async () => {
    const { hh, launcher, ctx } = rig('none', 'read-only');
    const result = await hh.adapter.execute(request({ permissionMode: 'plan' }), ctx());
    expect(result.text).toBe('ECHO: PROMPT-SENTINEL');
    expect(launcher.prepareCalls).toBe(1);
    const spec = launcher.specs[0];
    expect(spec?.workspaceAccess).toBe('read-only');
    expect(spec?.workspace).toBe(WORKSPACE);
    expect(spec?.network).toEqual({
      mode: 'proxy',
      allowHosts: ['api.anthropic.com', 'claude.ai', 'platform.claude.com'],
    });
    // The v0.2 read-only argv, not the engineering one.
    const [call] = hh.invocations();
    expect(call?.argv.slice(1, 3)).toEqual(['--output-format', 'json']);
    expect(call?.argv).not.toContain('--setting-sources');
    expect(call?.cwd).toBe(WORKSPACE);
    expect(launcher.disposed).toBe(1);
  });
});

describe('engineering argv', () => {
  it('builds the read-write argv with the prompt on stdin only', async () => {
    const { hh, launcher, ctx } = rig('sandbox', 'read-write');
    await hh.adapter.execute(request({ model: 'claude-x', maxTurns: 7 }, 'be careful'), ctx());
    // Drop the fake-claude script that stands in for the binary prefix.
    expect(launcher.specs[0]?.args.slice(1)).toEqual([
      ...COMMON_ARGS,
      '--model',
      'claude-x',
      '--max-turns',
      '7',
      '--append-system-prompt',
      'be careful',
      '--allowedTools',
      'Bash',
      '--disallowedTools',
      ...DENY_RULES,
      '--tools',
      'Read',
      'Edit',
      'Write',
      'Glob',
      'Grep',
      'Bash',
    ]);
    const [call] = hh.invocations();
    expect(call?.stdin).toBe('PROMPT-SENTINEL');
    expect(call?.argv.join(' ')).not.toContain('PROMPT-SENTINEL');
    expect(launcher.specs[0]?.workspaceAccess).toBe('read-write');
  });

  it('passes --max-budget-usd only when maxCostUsd is set', async () => {
    const { hh, launcher, ctx } = rig('sandbox', 'read-write');
    const plain = request();
    await hh.adapter.execute(plain, ctx());
    await hh.adapter.execute(
      { ...plain, task: { ...plain.task, requirements: { capabilities: [], maxCostUsd: 1.5 } } },
      ctx(),
    );
    const [a, b] = launcher.specs;
    expect(a?.args).not.toContain('--max-budget-usd');
    const i = b?.args.indexOf('--max-budget-usd') ?? -1;
    expect(i).toBeGreaterThan(0);
    expect(b?.args[i + 1]).toBe('1.5');
    expect(b?.args.indexOf('--allowedTools') ?? 0).toBeGreaterThan(i);
  });

  it('maps error_max_budget_usd from the stream to POLICY_REJECTED', async () => {
    const { hh, ctx } = rig('sandbox', 'read-write', { FAKE_CLAUDE_MODE: 'budget' });
    const err = await rejection(hh.adapter.execute(request(), ctx()));
    expect(err.code).toBe('POLICY_REJECTED');
    expect(err.details).toMatchObject({ reason: 'max-budget-usd' });
  });

  it('uses a tool list without Edit/Write for read-only workspaces', async () => {
    const { hh, launcher, ctx } = rig('sandbox', 'read-only');
    await hh.adapter.execute(request(), ctx());
    expect(launcher.specs[0]?.args.slice(1)).toEqual([
      ...COMMON_ARGS,
      '--allowedTools',
      'Bash',
      '--disallowedTools',
      ...DENY_RULES,
      '--tools',
      'Read',
      'Glob',
      'Grep',
      'Bash',
    ]);
    expect(launcher.specs[0]?.workspaceAccess).toBe('read-only');
  });
});

describe('launch spec', () => {
  it('carries a minimal env with nothing from the parent', async () => {
    const { hh, launcher, ctx } = rig(
      'sandbox',
      'read-write',
      {},
      { ANTHROPIC_API_KEY: 'sk-parent', ANTHROPIC_AUTH_TOKEN: 'tok-parent', GITHUB_TOKEN: 'gh' },
    );
    await hh.adapter.execute(request(), ctx());
    expect(launcher.specs[0]?.env).toEqual({
      LANG: 'C.UTF-8',
      CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: '1',
      CLAUDE_CODE_DISABLE_AUTO_MEMORY: '1',
      CLAUDE_CODE_DISABLE_GIT_INSTRUCTIONS: '1',
      ENABLE_CLAUDEAI_MCP_SERVERS: 'false',
    });
    const [call] = hh.invocations();
    for (const name of ['ANTHROPIC_API_KEY', 'ANTHROPIC_AUTH_TOKEN', 'GITHUB_TOKEN']) {
      expect(call?.envNames).not.toContain(name);
    }
  });

  it('passes mounts through unchanged and overrides allowHosts', async () => {
    const { hh, launcher, ctx } = rig('sandbox', 'read-write');
    const mounts = [
      {
        hostPath: '/home/o/.claude/.credentials.json',
        sandboxPath: '/home/agent/.claude/.credentials.json',
        access: 'read-write' as const,
      },
    ];
    await hh.adapter.execute(
      request({ sandbox: { allowHosts: ['api.anthropic.com'], mounts } }),
      ctx(),
    );
    expect(launcher.specs[0]?.mounts).toEqual(mounts);
    expect(launcher.specs[0]?.network).toEqual({
      mode: 'proxy',
      allowHosts: ['api.anthropic.com'],
    });
  });

  it('defaults to no mounts', async () => {
    const { hh, launcher, ctx } = rig('sandbox', 'read-only');
    await hh.adapter.execute(request(), ctx());
    expect(launcher.specs[0]?.mounts).toEqual([]);
  });
});

describe('dispose', () => {
  it('runs on success', async () => {
    const { hh, launcher, ctx } = rig('sandbox', 'read-write');
    await hh.adapter.execute(request(), ctx());
    expect(launcher.disposed).toBe(1);
  });

  it('runs on provider failure', async () => {
    const { hh, launcher, ctx } = rig('sandbox', 'read-write', { FAKE_CLAUDE_MODE: 'error' });
    const err = await rejection(hh.adapter.execute(request(), ctx()));
    expect(err.code).toBe('PROVIDER_ERROR');
    expect(launcher.disposed).toBe(1);
  });

  it('runs on spawn error', async () => {
    const { hh, launcher, ctx } = rig('sandbox', 'read-write');
    const original = launcher.prepare.bind(launcher);
    launcher.prepare = async (spec, signal) => ({
      ...(await original(spec, signal)),
      command: '/nonexistent/claude-binary',
    });
    const err = await rejection(hh.adapter.execute(request(), ctx()));
    expect(err.code).toBe('INTEGRATION_UNAVAILABLE');
    expect(launcher.disposed).toBe(1);
  });

  it('runs on timeout', async () => {
    const { hh, launcher, ctx } = rig('sandbox', 'read-write', { FAKE_CLAUDE_MODE: 'hang' });
    const err = await rejection(hh.adapter.execute(request({ engineeringTimeoutMs: 150 }), ctx()));
    expect(err.code).toBe('EXECUTION_TIMEOUT');
    expect(launcher.disposed).toBe(1);
  });

  it('runs on abort', async () => {
    const { hh, launcher, ctx } = rig('sandbox', 'read-write', { FAKE_CLAUDE_MODE: 'hang' });
    const ac = new AbortController();
    const pending = rejection(hh.adapter.execute(request(), ctx(ac.signal)));
    await waitFor(() => hh.invocations()[0]);
    ac.abort();
    expect((await pending).code).toBe('EXECUTION_CANCELLED');
    expect(launcher.disposed).toBe(1);
  });

  it('propagates a failed prepare without spawning', async () => {
    const hh = harness();
    h = hh;
    const launcher = fakeLauncher('sandbox', {}, true);
    const workspace: EngineeringWorkspace = { path: WORKSPACE, access: 'read-write', launcher };
    await expect(hh.adapter.execute(request(), { ...hh.context(), workspace })).rejects.toThrow(
      'prepare failed',
    );
    expect(launcher.disposed).toBe(0);
    expect(hh.invocations()).toEqual([]);
  });
});

describe('stream-json output', () => {
  it('extracts the result and emits tool-call events without inputs', async () => {
    const { hh, ctx } = rig('sandbox', 'read-write', { FAKE_CLAUDE_TOOLS: 'Read,Edit,Bash' });
    const result = await hh.adapter.execute(request({ model: 'claude-x' }), ctx());
    expect(result.text).toBe('ECHO: PROMPT-SENTINEL');
    expect(result.resolved.model).toBe('claude-x');
    expect(hh.events.filter((e) => e.type === 'tool-call')).toEqual([
      { type: 'tool-call', name: 'Read' },
      { type: 'tool-call', name: 'Edit' },
      { type: 'tool-call', name: 'Bash' },
    ]);
    expect(JSON.stringify(hh.events)).not.toContain('TOOL-INPUT-SENTINEL');
  });

  it('reports only the count of permission denials', async () => {
    const { hh, ctx } = rig('sandbox', 'read-write', { FAKE_CLAUDE_DENIALS: '2' });
    await hh.adapter.execute(request(), ctx());
    expect(hh.events).toContainEqual({
      type: 'status',
      message: 'claude: 2 permission denial(s)',
    });
    expect(JSON.stringify(hh.events)).not.toContain('DENIED-SENTINEL');
  });

  it('fails with PROVIDER_ERROR when the result line is missing', async () => {
    const { hh, ctx } = rig('sandbox', 'read-write', { FAKE_CLAUDE_NO_RESULT: '1' });
    const err = await rejection(hh.adapter.execute(request(), ctx()));
    expect(err.code).toBe('PROVIDER_ERROR');
  });

  it('classifies an error result as PROVIDER_ERROR and a login failure as AUTH_REQUIRED', async () => {
    const a = rig('sandbox', 'read-write', { FAKE_CLAUDE_MODE: 'error' });
    expect((await rejection(a.hh.adapter.execute(request(), a.ctx()))).code).toBe('PROVIDER_ERROR');
    await a.hh.cleanup();
    const b = rig('sandbox', 'read-write', { FAKE_CLAUDE_MODE: 'auth' });
    expect((await rejection(b.hh.adapter.execute(request(), b.ctx()))).code).toBe('AUTH_REQUIRED');
  });
});
