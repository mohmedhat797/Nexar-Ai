import { existsSync, mkdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import {
  ApprovalGate,
  InMemoryApprovalStore,
  decide,
  type ApprovalRequest,
  type ApprovalStore,
} from '@nexar/approvals';
import { adapterId } from '@nexar/contracts';
import type {
  ExecutionContext,
  ExecutionEvent,
  LaunchSpec,
  PreparedLaunch,
  ProcessLauncher,
  ResourceDescriptor,
} from '@nexar/contracts';
import { DeepSeekHarnessExecutionAdapter } from '../adapter.js';
import { DEEPSEEK_HARNESS_ADAPTER_ID, deepseekHarnessResource } from '../resource.js';
import { makeContext, makeTask, makeTempDir } from '../test/support.js';
import type { FakeRecord, LogLine } from '../test/support.js';

const FAKE_ACP = fileURLToPath(new URL('../test/fake-dsh-acp.mjs', import.meta.url));
const TOOL_MARKER = 'MARKER-TOOL-ARG-9f3a';
const PROMPT_MARKER = 'MARKER-PROMPT-71c2';

interface AcpRecord extends FakeRecord {
  pid: number;
  notifications: { method: string; params?: Record<string, unknown> }[];
  clientReplies: { id: number; result?: unknown; error?: { code: number } }[];
  permissionReply?: { result?: { outcome: Record<string, unknown> }; error?: { code: number } };
  permissionLabel?: string;
}

function readAcpRecord(path: string): AcpRecord {
  return JSON.parse(readFileSync(path, 'utf8')) as AcpRecord;
}

function alive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

async function waitFor<T>(check: () => Promise<T | undefined> | T | undefined, ms = 10_000) {
  const deadline = Date.now() + ms;
  for (;;) {
    const value = await check();
    if (value !== undefined) return value;
    if (Date.now() > deadline) throw new Error('waitFor timed out');
    await new Promise((r) => setTimeout(r, 15));
  }
}

/** A launcher that hands the spawn spec straight back (the fake agent stands in for the sandbox). */
class FakeLauncher implements ProcessLauncher {
  specs: LaunchSpec[] = [];
  disposed = 0;
  constructor(
    private readonly workspacePath: string,
    readonly isolation: 'none' | 'sandbox' = 'sandbox',
    private readonly reportedIsolation: 'none' | 'sandbox' = isolation,
  ) {}
  prepare(spec: LaunchSpec): Promise<PreparedLaunch> {
    this.specs.push(spec);
    return Promise.resolve({
      command: spec.command,
      args: spec.args,
      env: { PATH: process.env.PATH ?? '' },
      cwd: this.workspacePath,
      workspacePath: this.workspacePath,
      isolation: this.reportedIsolation,
      dispose: () => {
        this.disposed++;
        return Promise.resolve();
      },
    });
  }
}

interface Options {
  flags?: Record<string, string>;
  acp?: Record<string, unknown>;
  approvals?: 'gate' | 'gate+store' | 'none';
  store?: ApprovalStore;
  access?: 'read-only' | 'read-write';
  isolation?: 'none' | 'sandbox';
  reportedIsolation?: 'none' | 'sandbox';
  env?: NodeJS.ProcessEnv;
  options?: Record<string, unknown>;
  prompt?: string;
  systemPrompt?: string;
  timeoutMs?: number;
}

function setup(o: Options = {}) {
  const dir = makeTempDir();
  const recordPath = join(dir, 'record.json');
  const workspacePath = join(dir, 'ws');
  const stateDir = join(dir, 'state');
  mkdirSync(workspacePath);
  const store = o.store ?? new InMemoryApprovalStore();
  const gate = new ApprovalGate({ mode: 'store', store, pollIntervalMs: 10 });
  const launcher = new FakeLauncher(
    workspacePath,
    o.isolation ?? 'sandbox',
    o.reportedIsolation ?? o.isolation ?? 'sandbox',
  );
  const flags = Object.entries({ record: recordPath, ...o.flags }).map(
    ([k, v]) => `--fake-${k}=${v}`,
  );
  const approvals =
    o.approvals === 'none' ? undefined : o.approvals === 'gate' ? { gate } : { gate, store };
  const adapter = new DeepSeekHarnessExecutionAdapter({
    binary: { command: process.execPath, args: [FAKE_ACP, ...flags] },
    stateDir,
    env: o.env ?? {
      PATH: process.env.PATH,
      DEEPSEEK_API_KEY: 'sk-test-key-123',
      GH_TOKEN: 'ghp_x',
    },
    initializeTimeoutMs: 5000,
    defaultTimeoutMs: 20_000,
    ...(approvals === undefined ? {} : { approvals }),
  });
  const resource: ResourceDescriptor = deepseekHarnessResource({
    runtime: {
      adapter: DEEPSEEK_HARNESS_ADAPTER_ID,
      locality: 'local',
      options: {
        provider: 'deepseek-official',
        model: 'deepseek-v4-flash',
        ...(o.timeoutMs === undefined ? {} : { timeoutMs: o.timeoutMs }),
        ...(o.acp === undefined ? {} : { acp: o.acp }),
        ...o.options,
      },
    },
  });
  const events: ExecutionEvent[] = [];
  const logs: LogLine[] = [];
  const controller = new AbortController();
  const base = makeContext({ signal: controller.signal, events, logs });
  const context: ExecutionContext = {
    ...base,
    workspace: {
      path: workspacePath,
      access: o.access ?? 'read-write',
      launcher,
    },
  };
  const task = makeTask({ workingDirectory: dir });
  const taskWithPrompts = {
    ...task,
    input: {
      ...task.input,
      prompt: o.prompt ?? task.input.prompt,
      ...(o.systemPrompt === undefined ? {} : { systemPrompt: o.systemPrompt }),
    },
  };
  const run = () => adapter.execute({ task: taskWithPrompts, resource }, context);
  return {
    dir,
    recordPath,
    workspacePath,
    stateDir,
    store,
    launcher,
    run,
    events,
    logs,
    controller,
  };
}

/** Waits for the pending approval the gate created and decides it. */
async function decideWhenPending(
  store: ApprovalStore,
  decision: 'approve' | 'deny',
): Promise<ApprovalRequest> {
  const pending = await waitFor(async () => (await store.list({ status: 'pending' }))[0]);
  return decide(store, pending.id, decision, { by: 'tester' });
}

describe('ACP engineering path: permissions via approvals', () => {
  it('runs end to end and allow_once is sent after a human approves', async () => {
    const t = setup({
      prompt: PROMPT_MARKER,
      flags: { input: JSON.stringify({ command: TOOL_MARKER }) },
    });
    const running = t.run();
    const approved = await decideWhenPending(t.store, 'approve');
    const result = await running;

    expect(result.text).toBe('working. permission:allow-once');
    expect(result.usage.costUsd).toEqual({ status: 'measured', value: 0.5 });
    expect(result.usage.inputTokens.status).toBe('unavailable');
    expect(t.events).toContainEqual({ type: 'tool-call', name: 'bash' });

    const record = readAcpRecord(t.recordPath);
    expect(record.permissionLabel).toBe('allow-once');
    expect(record.requests.map((r) => r.method)).toEqual([
      'initialize',
      'session/new',
      'session/set_config_option',
      'session/prompt',
      'session/close',
    ]);
    expect(record.requests[0]?.params).toEqual({
      protocolVersion: 1,
      clientCapabilities: { fs: { readTextFile: false, writeTextFile: false }, terminal: false },
    });
    expect(record.requests[1]?.params).toEqual({ cwd: t.workspacePath, mcpServers: [] });
    expect(record.requests[3]?.params).toEqual({
      sessionId: 'sess-1',
      prompt: [{ type: 'text', text: PROMPT_MARKER }],
    });
    expect(record.argv).toContain('--profile');

    // The approval is single use: consumed, and no parameters were persisted.
    const stored = await t.store.get(approved.id);
    expect(stored?.status).toBe('consumed');
    expect(stored?.actionType).toBe('agent.tool');
    expect(JSON.stringify(stored)).not.toContain(TOOL_MARKER);
    expect(t.launcher.disposed).toBe(1);
  });

  it('sends reject_once when the human denies', async () => {
    const t = setup();
    const running = t.run();
    await decideWhenPending(t.store, 'deny');
    const result = await running;
    expect(result.text).toBe('working. permission:reject-once');
    expect(readAcpRecord(t.recordPath).permissionLabel).toBe('reject-once');
  });

  it('chooses by option kind, never by id, and never picks the *_always options', async () => {
    const approve = setup({ flags: { ids: 'scrambled' } });
    const a = approve.run();
    await decideWhenPending(approve.store, 'approve');
    await a;
    expect(readAcpRecord(approve.recordPath).permissionLabel).toBe('q-3'); // allow_once

    const deny = setup({ flags: { ids: 'scrambled' } });
    const d = deny.run();
    await decideWhenPending(deny.store, 'deny');
    await d;
    expect(readAcpRecord(deny.recordPath).permissionLabel).toBe('q-4'); // reject_once
  });

  it('rejects when the approval expires', async () => {
    const t = setup({ acp: { permissions: { ttlMs: 60 } } });
    const result = await t.run();
    expect(result.text).toBe('working. permission:reject-once');
    expect((await t.store.list({ status: 'expired' })).length).toBe(1);
  });

  it('rejects without a gate (deny by default)', async () => {
    const t = setup({ approvals: 'none' });
    const result = await t.run();
    expect(result.text).toBe('working. permission:reject-once');
    expect(await t.store.list()).toEqual([]);
  });

  it('allows an allow-listed tool without a pending approval and records a policy decision', async () => {
    const t = setup({ acp: { permissions: { mode: 'allow-listed', allowTools: ['bash'] } } });
    const result = await t.run();
    expect(result.text).toBe('working. permission:allow-once');
    const records = await t.store.list();
    expect(records).toHaveLength(1);
    expect(records[0]).toMatchObject({
      status: 'consumed',
      decidedBy: 'policy',
      actionType: 'agent.tool',
    });
    expect(await t.store.list({ status: 'pending' })).toEqual([]);
  });

  it('asks for tools that are not on the allow-list', async () => {
    const t = setup({
      flags: { tool: 'rm' },
      acp: { permissions: { mode: 'allow-listed', allowTools: ['bash'], ttlMs: 60 } },
    });
    const result = await t.run();
    expect(result.text).toBe('working. permission:reject-once');
    const records = await t.store.list();
    expect(records).toHaveLength(1);
    expect(records[0]?.status).toBe('expired');
  });

  it('does not allow-list without a store to record the decision', async () => {
    const t = setup({
      approvals: 'gate',
      acp: { permissions: { mode: 'allow-listed', allowTools: ['bash'], ttlMs: 60 } },
    });
    const result = await t.run();
    expect(result.text).toBe('working. permission:reject-once');
  });

  it('rejects everything in deny mode and records the denial', async () => {
    const t = setup({ acp: { permissions: { mode: 'deny' } } });
    const result = await t.run();
    expect(result.text).toBe('working. permission:reject-once');
    const records = await t.store.list();
    expect(records).toHaveLength(1);
    expect(records[0]).toMatchObject({ status: 'denied', decidedBy: 'policy' });
  });

  it('rejects a permission request for an unknown toolCallId', async () => {
    const t = setup({ flags: { scenario: 'unknown-call' } });
    const result = await t.run();
    expect(result.text).toBe('working. permission:reject-once');
    expect(await t.store.list()).toEqual([]);
  });

  it('rejects when the tool call carried no rawInput', async () => {
    const t = setup({ flags: { scenario: 'no-input' } });
    const result = await t.run();
    expect(result.text).toBe('working. permission:reject-once');
    expect(await t.store.list()).toEqual([]);
  });

  it('answers with a JSON-RPC error when a rejection is needed but reject_once is absent', async () => {
    const t = setup({ flags: { scenario: 'no-reject' }, approvals: 'none' });
    const result = await t.run();
    expect(result.text).toBe('working. permission:error');
    expect(readAcpRecord(t.recordPath).permissionReply?.error?.code).toBeDefined();
  });

  it('never asks a human when no allow_once option exists, and never fabricates one', async () => {
    const t = setup({ flags: { scenario: 'no-reject' } });
    // allow_once is present here, so a pending approval appears; deny it: error reply.
    const running = t.run();
    await decideWhenPending(t.store, 'deny');
    expect((await running).text).toBe('working. permission:error');
  });

  it('answers fs/*, terminal/* and unknown agent requests with -32601', async () => {
    const t = setup({ flags: { scenario: 'probe-fs' } });
    await t.run();
    const replies = readAcpRecord(t.recordPath).clientReplies;
    expect(replies).toHaveLength(3);
    for (const reply of replies) expect(reply.error?.code).toBe(-32601);
  });

  it('never logs tool arguments or prompts', async () => {
    const t = setup({
      prompt: PROMPT_MARKER,
      flags: { input: JSON.stringify({ command: TOOL_MARKER }) },
      acp: { permissions: { mode: 'allow-listed', allowTools: ['bash'] } },
    });
    await t.run();
    const approvalsToo = setup({
      prompt: PROMPT_MARKER,
      flags: { input: JSON.stringify({ command: TOOL_MARKER }) },
    });
    const running = approvalsToo.run();
    await decideWhenPending(approvalsToo.store, 'approve');
    await running;
    for (const x of [t, approvalsToo]) {
      const text = JSON.stringify([x.logs, x.events]);
      expect(text).not.toContain(TOOL_MARKER);
      expect(text).not.toContain(PROMPT_MARKER);
      expect(JSON.stringify(await x.store.list())).not.toContain(TOOL_MARKER);
    }
  });
});

describe('ACP engineering path: protocol, lifecycle and errors', () => {
  it('rejects protocol version 2 as INTEGRATION_UNAVAILABLE and cleans up', async () => {
    const t = setup({ flags: { protocol: '2' } });
    await expect(t.run()).rejects.toMatchObject({ code: 'INTEGRATION_UNAVAILABLE' });
    const record = readAcpRecord(t.recordPath);
    expect(record.requests.map((r) => r.method)).toEqual(['initialize']);
    expect(t.launcher.disposed).toBe(1);
    await waitFor(() => (alive(record.pid) ? undefined : true));
  });

  it('cancels a pending permission: session/cancel, cancelled outcome, group killed', async () => {
    const t = setup({ flags: { scenario: 'hang-permission' } });
    const running = t.run();
    const pendingSettled = running.then(
      () => undefined,
      (e: unknown) => e,
    );
    await waitFor(async () => (await t.store.list({ status: 'pending' }))[0]);
    t.controller.abort();
    const error = await pendingSettled;
    expect(error).toMatchObject({ code: 'EXECUTION_CANCELLED' });

    const record = readAcpRecord(t.recordPath);
    expect(record.notifications.map((n) => n.method)).toContain('session/cancel');
    expect(record.permissionReply?.result?.outcome).toEqual({ outcome: 'cancelled' });
    expect((await t.store.list())[0]?.status).toBe('cancelled');
    await waitFor(() => (alive(record.pid) ? undefined : true));
    expect(t.launcher.disposed).toBe(1);
  }, 20_000);

  it('kills the runtime when the agent ignores session/cancel', async () => {
    const t = setup({ flags: { scenario: 'hang', 'ignore-cancel': '1' } });
    const settled = t.run().then(
      () => undefined,
      (e: unknown) => e,
    );
    await waitFor(() => (existsSync(t.recordPath) ? true : undefined));
    await waitFor(() =>
      readAcpRecord(t.recordPath).requests.some((r) => r.method === 'session/prompt')
        ? true
        : undefined,
    );
    t.controller.abort();
    expect(await settled).toMatchObject({ code: 'EXECUTION_CANCELLED' });
    const record = readAcpRecord(t.recordPath);
    expect(record.notifications.map((n) => n.method)).toContain('session/cancel');
    expect(alive(record.pid)).toBe(false);
    expect(t.launcher.disposed).toBe(1);
  }, 30_000);

  it('times out with EXECUTION_TIMEOUT after sending session/cancel', async () => {
    const t = setup({ flags: { scenario: 'hang' }, timeoutMs: 700 });
    await expect(t.run()).rejects.toMatchObject({ code: 'EXECUTION_TIMEOUT' });
    const record = readAcpRecord(t.recordPath);
    expect(record.notifications.map((n) => n.method)).toContain('session/cancel');
    await waitFor(() => (alive(record.pid) ? undefined : true));
  }, 20_000);

  it('does not spawn before an aborted signal', async () => {
    const t = setup();
    t.controller.abort();
    await expect(t.run()).rejects.toMatchObject({ code: 'EXECUTION_CANCELLED' });
    expect(t.launcher.specs).toEqual([]);
  });

  it('refuses a read-write workspace with a non-sandbox launcher before preparing anything', async () => {
    const t = setup({ isolation: 'none' });
    await expect(t.run()).rejects.toMatchObject({ code: 'POLICY_REJECTED' });
    expect(t.launcher.specs).toEqual([]);
    expect(existsSync(t.recordPath)).toBe(false);
  });

  it('re-checks the isolation reported by prepare and disposes without spawning', async () => {
    const t = setup({ isolation: 'sandbox', reportedIsolation: 'none' });
    await expect(t.run()).rejects.toMatchObject({ code: 'POLICY_REJECTED' });
    expect(t.launcher.disposed).toBe(1);
    expect(existsSync(t.recordPath)).toBe(false);
  });

  it('allows a read-only workspace without the sandbox guarantee check', async () => {
    const t = setup({
      isolation: 'none',
      access: 'read-only',
      acp: { permissions: { mode: 'deny' } },
    });
    await expect(t.run()).resolves.toMatchObject({ text: 'working. permission:reject-once' });
  });

  it('builds the sandbox launch spec from allowlisted env and one DSH state mount', async () => {
    const t = setup();
    const running = t.run();
    await decideWhenPending(t.store, 'approve');
    await running;
    const spec = t.launcher.specs[0] as LaunchSpec;
    expect(spec.command).toBe(process.execPath);
    expect(spec.args.slice(-2)).toEqual(['--profile', 'acp']);
    expect(spec.env).toEqual({ DSH_HOME: '/home/agent/.dsh', DEEPSEEK_API_KEY: 'sk-test-key-123' });
    expect(spec.workspace).toBe(t.workspacePath);
    expect(spec.workspaceAccess).toBe('read-write');
    expect(spec.network).toEqual({ mode: 'proxy', allowHosts: ['api.deepseek.com'] });
    const mount = spec.mounts?.[0];
    expect(spec.mounts).toHaveLength(1);
    expect(mount).toMatchObject({ sandboxPath: '/home/agent/.dsh', access: 'read-write' });
    expect(mount?.hostPath.startsWith(t.stateDir)).toBe(true);
    if (process.platform !== 'win32')
      expect(statSync(mount?.hostPath as string).mode & 0o777).toBe(0o700);
  });

  it('omits the credential when it is not set and honors allowHosts', async () => {
    const t = setup({
      env: { PATH: process.env.PATH },
      acp: { allowHosts: ['example.test'], permissions: { mode: 'deny' } },
    });
    await t.run();
    const spec = t.launcher.specs[0] as LaunchSpec;
    expect(spec.env).toEqual({ DSH_HOME: '/home/agent/.dsh' });
    expect(spec.network).toEqual({ mode: 'proxy', allowHosts: ['example.test'] });
  });

  it('prepends the system prompt with a clear separator and sets model/effort options', async () => {
    const t = setup({
      systemPrompt: 'BE CAREFUL',
      prompt: 'do it',
      options: { reasoningEffort: 'high' },
      acp: { permissions: { mode: 'deny' } },
    });
    await t.run();
    const record = readAcpRecord(t.recordPath);
    const prompt = record.requests.find((r) => r.method === 'session/prompt');
    const sent = (prompt?.params as { prompt: { text: string }[] }).prompt[0]?.text;
    expect(sent).toMatch(/^BE CAREFUL\n\n--- .* ---\n\ndo it$/);
    const configs = record.requests.filter((r) => r.method === 'session/set_config_option');
    expect(configs.map((c) => c.params)).toEqual([
      { sessionId: 'sess-1', configId: 'model', value: 'deepseek-v4-flash' },
      { sessionId: 'sess-1', configId: 'reasoning_effort', value: 'high' },
    ]);
  });

  it('treats max_tokens as success with a status event, and refusal as an error', async () => {
    const t = setup({ flags: { stop: 'max_tokens' }, acp: { permissions: { mode: 'deny' } } });
    await expect(t.run()).resolves.toBeDefined();
    expect(t.events.some((e) => e.type === 'status' && e.message.includes('token limit'))).toBe(
      true,
    );

    const r = setup({ flags: { stop: 'refusal' }, acp: { permissions: { mode: 'deny' } } });
    await expect(r.run()).rejects.toMatchObject({ code: 'PROVIDER_ERROR' });
  });

  it('classifies JSON-RPC errors as auth, quota or provider failures', async () => {
    const cases: [string, string][] = [
      ['invalid API key', 'AUTH_REQUIRED'],
      ['quota exceeded for this account', 'QUOTA_EXHAUSTED'],
      ['upstream exploded', 'PROVIDER_ERROR'],
    ];
    for (const [message, code] of cases) {
      const t = setup({ flags: { scenario: 'rpc-error', 'rpc-message': message } });
      await expect(t.run()).rejects.toMatchObject({ code });
      expect(t.launcher.disposed).toBe(1);
    }
  });

  it('keeps the adapter id wired for the engineering path', () => {
    expect(adapterId('deepseek-harness')).toBe(DEEPSEEK_HARNESS_ADAPTER_ID);
  });
});
