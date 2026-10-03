import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { OpenWorkerHttpClient } from './client.js';
import { decidePermission } from './policy.js';
import { COWORK_ERROR_CODES, runCoworkTurn } from './session.js';
import type { CoworkTurnRequest } from './session.js';
import { FakeOpenWorkerServer } from './test/fake-server.js';
import type { FakeScenario } from './test/fake-server.js';

const TOKEN = 'test-token-0123456789abcdef';
const scratchDir = join(tmpdir(), 'nexar-cowork-scratch');
const projectRoot = join(tmpdir(), 'nexar-cowork-project');

let server: FakeOpenWorkerServer;
let client: OpenWorkerHttpClient;
let port: number;

beforeEach(async () => {
  server = new FakeOpenWorkerServer({ token: TOKEN });
  port = await server.listen();
  client = new OpenWorkerHttpClient({ port, token: TOKEN });
});
afterEach(() => server.close());

function request(overrides: Partial<CoworkTurnRequest> = {}) {
  const progress: string[] = [];
  const requests: unknown[] = [];
  const base: CoworkTurnRequest = {
    sessionId: 'sess-1',
    prompt: 'Draft a note',
    model: 'anthropic:claude-test',
    scratchDir,
    projectRoot,
    signal: new AbortController().signal,
    timeoutMs: 5_000,
    onProgress: (id) => progress.push(id),
    decide: (permission) => {
      requests.push(permission);
      return decidePermission(permission, { scratchRoot: scratchDir }).decision;
    },
  };
  return { progress, requests, request: { ...base, ...overrides } };
}

async function run(scenario: FakeScenario, overrides: Partial<CoworkTurnRequest> = {}) {
  server.scenario = scenario;
  const built = request(overrides);
  return { ...built, result: await runCoworkTurn(client, built.request) };
}

describe('runCoworkTurn', () => {
  it('runs a normal turn: text, identifier-only progress and policy decisions', async () => {
    const { result, progress, requests } = await run('normal');
    expect(result).toEqual({ text: 'Cowork done', outcome: 'completed' });
    expect(progress).toEqual([
      'turn_start',
      'permission_required:write_file',
      'tool_started:write_file',
      'tool_finished:write_file',
      'permission_required:run_shell',
      'assistant_message',
    ]);
    expect(JSON.stringify(progress)).not.toContain('SECRET');
    expect(requests).toEqual([
      { name: 'write_file', category: 'file', target: join(scratchDir, 'draft.md') },
      { name: 'run_shell', category: 'shell', target: 'echo hi' },
    ]);
    // Frames: mode, message, then an allow for the scratch write and a deny for the shell.
    expect(server.frames).toEqual([
      { type: 'set_mode', mode: 'interactive' },
      { type: 'user_message', text: 'Draft a note', model: 'anthropic:claude-test' },
      { type: 'approval', decision: 'allow' },
      { type: 'approval', decision: 'deny' },
    ]);
  });

  it('sends the requested session mode (discuss) instead of interactive', async () => {
    await run('normal', { mode: 'discuss', decide: () => 'deny' });
    expect(server.frames[0]).toEqual({ type: 'set_mode', mode: 'discuss' });
  });

  it('waits for an asynchronous decision before answering the permission', async () => {
    let release: (value: 'allow' | 'deny') => void = () => undefined;
    const waiting = new Promise<'allow' | 'deny'>((resolve) => {
      release = resolve;
    });
    let asked = 0;
    server.scenario = 'normal';
    const built = request({
      decide: () => {
        asked += 1;
        return asked === 1 ? waiting : 'deny';
      },
    });
    const pending = runCoworkTurn(client, built.request);
    while (asked === 0) await new Promise((r) => setTimeout(r, 10));
    await new Promise((r) => setTimeout(r, 100));
    expect(server.frames.some((f) => f['type'] === 'approval')).toBe(false);
    release('allow');
    expect((await pending).outcome).toBe('completed');
    expect(server.frames.filter((f) => f['type'] === 'approval')[0]).toEqual({
      type: 'approval',
      decision: 'allow',
    });
  });

  it('denies when the decision rejects or throws', async () => {
    await run('normal', { decide: () => Promise.reject(new Error('nope')) });
    expect(server.frames.filter((f) => f['type'] === 'approval')).toEqual([
      { type: 'approval', decision: 'deny' },
      { type: 'approval', decision: 'deny' },
    ]);
  });
  it('attaches the project read-only and opens the session in the scratch workspace', async () => {
    await run('normal', { persona: 'cowork' });
    expect(server.roots).toEqual([
      { sessionId: 'sess-1', body: { path: projectRoot, writable: false } },
    ]);
    const url = new URL(server.upgrades[0]!.url, 'http://127.0.0.1');
    expect(url.pathname).toBe('/ws/session/sess-1');
    expect(url.searchParams.get('workspace')).toBe(scratchDir);
    expect(url.searchParams.get('agent')).toBe('cowork');
    expect(server.upgrades[0]!.authorized).toBe(true);
  });

  it('cancel sends interrupt and reports cancelled', async () => {
    server.scenario = 'hang';
    const controller = new AbortController();
    const built = request({ signal: controller.signal });
    const pending = runCoworkTurn(client, built.request);
    while (!server.frames.some((frame) => frame['type'] === 'user_message')) {
      await new Promise((r) => setTimeout(r, 10));
    }
    controller.abort();
    expect(await pending).toEqual({ text: '', outcome: 'cancelled' });
    for (let i = 0; i < 100 && !server.frames.some((f) => f['type'] === 'interrupt'); i++) {
      await new Promise((r) => setTimeout(r, 10));
    }
    expect(server.frames.at(-1)).toEqual({ type: 'interrupt' });
  });

  it('returns cancelled without contacting the server when already aborted', async () => {
    const controller = new AbortController();
    controller.abort();
    const { result } = await run('normal', { signal: controller.signal });
    expect(result.outcome).toBe('cancelled');
    expect(server.roots).toHaveLength(0);
  });

  it('times out as failed and interrupts', async () => {
    const { result } = await run('hang', { timeoutMs: 150 });
    expect(result).toEqual({ text: '', outcome: 'failed', errorCode: COWORK_ERROR_CODES.timeout });
    for (let i = 0; i < 100 && !server.frames.some((f) => f['type'] === 'interrupt'); i++) {
      await new Promise((r) => setTimeout(r, 10));
    }
    expect(server.frames.some((f) => f['type'] === 'interrupt')).toBe(true);
  });

  it.each([
    ['malformed', COWORK_ERROR_CODES.malformedFrame],
    ['oversize', COWORK_ERROR_CODES.malformedFrame],
    ['error', COWORK_ERROR_CODES.turnError],
    ['input-rejected', COWORK_ERROR_CODES.inputRejected],
    ['close-mid-turn', COWORK_ERROR_CODES.connectionClosed],
  ] as const)('%s fails with a fixed code', async (scenario, errorCode) => {
    const { result } = await run(scenario);
    expect(result).toEqual({ text: '', outcome: 'failed', errorCode });
    expect(JSON.stringify(result)).not.toContain('SECRET');
  });

  it('fails when the HTTP token is wrong', async () => {
    const wrong = new OpenWorkerHttpClient({ port, token: 'wrong' });
    const { request: built } = request();
    expect(await runCoworkTurn(wrong, built)).toEqual({
      text: '',
      outcome: 'failed',
      errorCode: COWORK_ERROR_CODES.rootFailed,
    });
    expect(server.frames).toHaveLength(0);
  });

  it('fails when the socket handshake is refused (wrong subprotocol token)', async () => {
    const wrong = new OpenWorkerHttpClient({ port, token: 'wrong' });
    const { request: built } = request();
    const result = await runCoworkTurn(
      { attachRoot: () => Promise.resolve(), openSession: (id, o) => wrong.openSession(id, o) },
      built,
    );
    expect(result).toEqual({
      text: '',
      outcome: 'failed',
      errorCode: COWORK_ERROR_CODES.connectionClosed,
    });
    expect(server.upgrades.length).toBeGreaterThan(0);
    expect(server.upgrades.every((u) => !u.authorized)).toBe(true);
  });

  it('fails invalid requests before any network call', async () => {
    for (const bad of [
      { sessionId: '../x' },
      { prompt: '' },
      { scratchDir: 'relative' },
      { persona: 'a b' },
    ]) {
      const { result } = await run('normal', bad);
      expect(result.errorCode).toBe(COWORK_ERROR_CODES.invalidRequest);
    }
    expect(server.roots).toHaveLength(0);
  });

  it('declines folder and tool requests and completes the turn', async () => {
    const { result } = await run('declined-requests');
    expect(result).toMatchObject({ outcome: 'completed', text: 'done without them' });
    const sent = (): (string | undefined)[] =>
      server.frames.map((f) => (f as { type?: string }).type);
    await expect.poll(sent).toContain('directory_response');
    await expect.poll(sent).toContain('tool_response');
    expect(
      server.frames.find((f) => (f as { type?: string }).type === 'directory_response'),
    ).toMatchObject({ granted: false, writable: false });
    expect(
      server.frames.find((f) => (f as { type?: string }).type === 'tool_response'),
    ).toMatchObject({ approved: false });
  });

  it('ends the turn promptly when OpenWorker needs an answer, interrupting it', async () => {
    const { result } = await run('question', { timeoutMs: 60_000 });
    expect(result).toMatchObject({ outcome: 'failed', errorCode: 'OPENWORKER_INPUT_REQUIRED' });
    await expect
      .poll(() => server.frames.map((f) => (f as { type?: string }).type))
      .toContain('interrupt');
  });

  it('denies when the decider throws', async () => {
    const { result } = await run('normal', {
      decide: () => {
        throw new Error('boom');
      },
    });
    expect(result.outcome).toBe('completed');
    expect(server.frames.filter((f) => f['type'] === 'approval')).toEqual([
      { type: 'approval', decision: 'deny' },
      { type: 'approval', decision: 'deny' },
    ]);
  });
});
