import { createHash } from 'node:crypto';
import { mkdir, mkdtemp, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { ApprovalGate, InMemoryApprovalStore, type OutwardAction } from '@nexar/approvals';
import { isNexarError, type ProcessLauncher } from '@nexar/contracts';
import type {
  EngineeringInput,
  EngineeringOutcome,
  EngineeringProgress,
  EngineeringRecord,
  EngineeringRunOptions,
} from '@nexar/engineering';
import {
  MAX_DIFF_BYTES,
  MAX_DIFF_FILES,
  MAX_FRAME_BYTES,
  PLANE_PROTOCOL,
  createPlaneFrameDecoder,
  encodeFrame,
  type DesktopFrame,
  type PlaneFrame,
} from '@nexar/plane-protocol';
import type { SandboxAvailability, SelfTestResult } from '@nexar/sandbox';
import type { CliSeams, EngineeringRunnerPort } from './args.js';
import { runCli } from './cli.js';
import type { CliIo } from './io.js';

const GOAL_MARKER = 'GOAL-MARKER-55aa91';
const TASK = 'eng-aaaaaaaaaaaa';
const RUN = `run_${'a'.repeat(32)}`;
const RUN2 = `run_${'b'.repeat(32)}`;
const PATCH_SHA = 'c'.repeat(64);
const lineage = {
  sessionId: `ses_${'1'.repeat(32)}`,
  turnId: `turn_${'2'.repeat(32)}`,
  correlationId: `turn_${'2'.repeat(32)}`,
  depth: 0,
};

const echo = {
  id: 'local-echo',
  displayName: 'Local Echo',
  kind: { type: 'model', provider: 'nexar', model: 'echo', access: 'local' },
  capabilities: ['text-generation', 'coding'],
  runtime: { adapter: 'echo', locality: 'local' },
  auth: { mode: 'none' },
  cost: { model: 'free' },
  dataLocality: 'local',
};

const fakeLauncher: ProcessLauncher = {
  isolation: 'sandbox',
  prepare: () => Promise.reject(new Error('the fake launcher never launches')),
};

/** A pushable standard input. */
class Input implements AsyncIterable<string | Uint8Array> {
  private readonly queue: (string | Uint8Array)[] = [];
  private waiting: ((r: IteratorResult<string | Uint8Array>) => void) | undefined;
  private ended = false;
  returned = false;

  push(chunk: string | Uint8Array): void {
    if (this.waiting !== undefined) {
      const resolve = this.waiting;
      this.waiting = undefined;
      resolve({ value: chunk, done: false });
    } else this.queue.push(chunk);
  }

  end(): void {
    this.ended = true;
    if (this.waiting !== undefined) {
      const resolve = this.waiting;
      this.waiting = undefined;
      resolve({ value: undefined, done: true });
    }
  }

  frame(frame: DesktopFrame): void {
    this.push(encodeFrame(frame));
  }

  [Symbol.asyncIterator](): AsyncIterator<string | Uint8Array> {
    return {
      next: () => {
        const chunk = this.queue.shift();
        if (chunk !== undefined) return Promise.resolve({ value: chunk, done: false });
        if (this.ended) return Promise.resolve({ value: undefined, done: true });
        return new Promise((resolve) => {
          this.waiting = resolve;
        });
      },
      return: () => {
        this.returned = true;
        return Promise.resolve({ value: undefined, done: true });
      },
    };
  }
}

const waitFor = async (condition: () => boolean, what: string): Promise<void> => {
  const deadline = Date.now() + 5000;
  while (!condition()) {
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${what}`);
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
};

const step = (
  name: Extract<EngineeringProgress, { type: 'step' }>['step'],
  detail: Record<string, string | number | boolean>,
): EngineeringProgress => ({ type: 'step', step: name, detail });

const awaiting: EngineeringProgress = {
  type: 'awaiting-approval',
  taskId: TASK,
  projectId: 'demo',
  branch: `nexar/${TASK}`,
  baseCommit: 'a'.repeat(40),
  patchSha256: PATCH_SHA,
  files: 2,
  gatesPassed: 2,
  reviewVerdict: 'approve',
  ttlMs: 60_000,
};

const initialize: DesktopFrame = { type: 'initialize', protocol: PLANE_PROTOCOL };
const runFrame = (over: Partial<Extract<DesktopFrame, { type: 'run' }>> = {}): DesktopFrame => ({
  type: 'run',
  runId: RUN,
  planeProject: 'demo',
  goal: `fix ${GOAL_MARKER}`,
  intent: 'coding',
  lineage,
  ...over,
});

const available: SandboxAvailability = {
  available: true,
  bwrapPath: '/usr/bin/bwrap',
  socatPath: '/usr/bin/socat',
  detail: 'ok',
};
const pass: SelfTestResult = { name: 'isolation', passed: true, detail: '' };

describe('nexar plane serve --stdio (in-process, offline)', () => {
  let dir: string;
  let input: Input;
  let out: string;
  let err: string;
  let store: InMemoryApprovalStore;
  let inputs: EngineeringInput[];
  let runnerCalls: number;
  let exitCode: Promise<number> | undefined;

  beforeEach(async () => {
    dir = await realpath(await mkdtemp(join(tmpdir(), 'nexar-cli-plane-')));
    await mkdir(join(dir, 'repo'));
    input = new Input();
    out = '';
    err = '';
    store = new InMemoryApprovalStore();
    inputs = [];
    runnerCalls = 0;
    exitCode = undefined;
    await writeConfig();
  });
  afterEach(async () => {
    input.end();
    await exitCode?.catch(() => undefined);
    await rm(dir, { recursive: true, force: true });
  });

  async function writeConfig(engineering: unknown = {}): Promise<void> {
    await writeFile(
      join(dir, 'nexar.config.json'),
      JSON.stringify({
        version: 1,
        resources: [echo],
        routing: { policy: 'deterministic', defaultResourceId: 'local-echo' },
        engineering: {
          toolchainPaths: [],
          worktreesDir: join(dir, 'wt'),
          ...(engineering as object),
        },
        projects: [
          {
            id: 'demo',
            displayName: 'Demo',
            roots: ['repo'],
            engineering: { gates: [{ name: 'test', command: ['true'] }] },
          },
          { id: 'plain', displayName: 'Plain', roots: ['repo'] },
        ],
      }),
    );
  }

  const io = (): CliIo => ({
    stdout: (s) => (out += s),
    stderr: (s) => (err += s),
    env: { PATH: process.env['PATH'] ?? '' },
    cwd: dir,
    stdinChunks: () => input,
  });

  /** Frames written to stdout so far; fails if anything on stdout is not a valid frame. */
  const frames = (): PlaneFrame[] => {
    const decoder = createPlaneFrameDecoder();
    const results = decoder.push(out);
    expect(decoder.end()).toEqual([]);
    const bad = results.filter((r) => !r.ok);
    expect(bad).toEqual([]);
    return results.flatMap((r) => (r.ok ? [r.frame] : []));
  };
  const framesOf = <T extends PlaneFrame['type']>(type: T): Extract<PlaneFrame, { type: T }>[] =>
    frames().filter((f): f is Extract<PlaneFrame, { type: T }> => f.type === type);

  /** A runner that behaves like the real one around approval: it asks the real gate and waits. */
  function approvalRunner(events: readonly EngineeringProgress[] = []): EngineeringRunnerPort {
    const gate = new ApprovalGate({ mode: 'store', store, pollIntervalMs: 5 });
    const action: OutwardAction = {
      type: 'engineering.commit',
      target: `demo:nexar/${TASK}`,
      parameters: {
        repository: 'repo',
        baseCommit: 'a'.repeat(40),
        patchSha256: PATCH_SHA,
        branch: `nexar/${TASK}`,
      },
    };
    return {
      run: async (
        runInput: EngineeringInput,
        options: EngineeringRunOptions = {},
      ): Promise<EngineeringOutcome> => {
        runnerCalls += 1;
        inputs.push(runInput);
        for (const event of events) options.onProgress?.(event);
        options.onProgress?.(awaiting);
        try {
          const grant = await gate.request(action, {
            summary: 'nexar: fix',
            risk: 'medium',
            taskId: TASK,
            projectId: 'demo',
            metadata: { engineeringTaskId: TASK, patchSha256: PATCH_SHA },
            ttlMs: 60_000,
            ...(options.signal === undefined ? {} : { signal: options.signal }),
          });
          await grant.consume(action);
          return {
            taskId: TASK,
            status: 'committed',
            branch: `nexar/${TASK}`,
            commit: 'd'.repeat(40),
            recordPath: '/abs/secret/location/record.json',
          };
        } catch (error) {
          if (options.signal?.aborted === true) {
            return { taskId: TASK, status: 'cancelled', reason: 'cancelled', recordPath: '' };
          }
          if (isNexarError(error) && error.code === 'APPROVAL_DENIED') {
            return {
              taskId: TASK,
              status: 'not-accepted',
              reason: 'approval.denied',
              recordPath: '',
            };
          }
          throw error;
        }
      },
      cleanup: () => Promise.resolve(),
    };
  }

  function start(runner: EngineeringRunnerPort = approvalRunner(), extra: CliSeams = {}): void {
    exitCode = runCli(['plane', 'serve', '--stdio'], io(), {
      engineering: { runner, launcher: fakeLauncher },
      sandbox: {
        availability: () => Promise.resolve(available),
        runSelfTest: () => Promise.resolve([pass]),
      },
      plane: {
        approvalStore: store,
        readText: (path) =>
          Promise.resolve(
            path === '/etc/wsl.conf'
              ? '[automount]\nenabled = false\n[interop]\nenabled=false\n'
              : '5.15.153.1-microsoft-standard-WSL2\n',
          ),
        planIds: () => Promise.resolve(['implement-review']),
        approvalPollMs: 5,
        settleTimeoutMs: 2000,
        user: 'tester',
      },
      ...extra,
    });
  }

  async function handshake(): Promise<void> {
    input.frame(initialize);
    await waitFor(() => out.includes('"type":"ready"'), 'ready');
  }

  describe('handshake', () => {
    it('answers initialize with ready and exits 0 on shutdown', async () => {
      start();
      await handshake();
      const [ready] = framesOf('ready');
      expect(ready).toMatchObject({
        protocol: PLANE_PROTOCOL,
        readiness: {
          sandbox: 'ok',
          selftest: 'pass',
          automount: 'disabled',
          interop: 'disabled',
          kernel: '5.15.153.1-microsoft-standard-WSL2',
          plans: ['implement-review'],
          projects: ['demo'],
        },
      });
      expect(ready?.planeVersion).toMatch(/\S/);
      input.frame({ type: 'shutdown' });
      expect(await exitCode).toBe(0);
      expect(input.returned).toBe(true);
    });

    it('rejects another protocol with an error frame, never ready, and exits 1', async () => {
      start();
      input.frame({ type: 'initialize', protocol: 'nexar-plane/9' });
      expect(await exitCode).toBe(1);
      const all = frames();
      expect(all.map((f) => f.type)).toEqual(['error']);
      expect(all[0]).toMatchObject({ code: 'VALIDATION_ERROR' });
      expect(out).not.toContain('nexar-plane/9');
    });

    it('rejects any other first frame with an error and exits 1', async () => {
      start();
      input.frame(runFrame());
      expect(await exitCode).toBe(1);
      expect(frames().map((f) => f.type)).toEqual(['error']);
      expect(runnerCalls).toBe(0);
    });

    it('rejects a first line that is not a frame', async () => {
      start();
      input.push('not json\n');
      expect(await exitCode).toBe(1);
      expect(frames().map((f) => f.type)).toEqual(['error']);
    });

    it('reports an unreadable configuration as an error frame without any path', async () => {
      await writeFile(join(dir, 'nexar.config.json'), '{ not json');
      start();
      input.frame(initialize);
      expect(await exitCode).toBe(1);
      const all = frames();
      expect(all.map((f) => f.type)).toEqual(['error']);
      expect(out).not.toContain(dir);
    });

    it('treats a second initialize as an error and keeps serving', async () => {
      start();
      await handshake();
      input.frame(initialize);
      await waitFor(() => framesOf('error').length === 1, 'error');
      input.frame({ type: 'shutdown' });
      expect(await exitCode).toBe(0);
    });
  });

  describe('readiness', () => {
    const readinessWith = async (
      over: { conf?: string | undefined; kernel?: string | undefined; seams?: CliSeams } = {},
    ) => {
      const readText = (path: string): Promise<string | undefined> =>
        Promise.resolve(path === '/etc/wsl.conf' ? over.conf : over.kernel);
      start(approvalRunner(), {
        ...over.seams,
        plane: { approvalStore: store, readText, planIds: () => Promise.resolve([]) },
      });
      await handshake();
      const ready = framesOf('ready')[0];
      input.frame({ type: 'shutdown' });
      await exitCode;
      return ready?.readiness;
    };

    it('reports automount and interop as unknown when wsl.conf is missing, and the kernel too', async () => {
      expect(await readinessWith({})).toMatchObject({
        automount: 'unknown',
        interop: 'unknown',
        kernel: 'unknown',
      });
    });

    it('keeps the WSL defaults (enabled) when wsl.conf does not mention them', async () => {
      expect(await readinessWith({ conf: '[boot]\nsystemd=true\n' })).toMatchObject({
        automount: 'enabled',
        interop: 'enabled',
      });
    });

    it('maps each toggle independently', async () => {
      expect(
        await readinessWith({ conf: '[automount]\nenabled=false\n[interop]\nenabled=true\n' }),
      ).toMatchObject({ automount: 'disabled', interop: 'enabled' });
    });

    it('reports a sandbox that is not available, with the self-test skipped', async () => {
      const readiness = await readinessWith({
        seams: {
          sandbox: {
            availability: () => Promise.resolve({ available: false, detail: 'no bwrap' }),
            runSelfTest: () => Promise.reject(new Error('must not run')),
          },
        },
      });
      expect(readiness).toMatchObject({ sandbox: 'unavailable', selftest: 'skipped' });
    });

    it.each([
      ['a failed check', () => Promise.resolve([pass, { ...pass, passed: false }])],
      ['no checks', () => Promise.resolve([])],
      ['a throwing self-test', () => Promise.reject(new Error('boom'))],
    ])('reports selftest fail for %s', async (_name, runSelfTest) => {
      const readiness = await readinessWith({
        seams: { sandbox: { availability: () => Promise.resolve(available), runSelfTest } },
      });
      expect(readiness).toMatchObject({ sandbox: 'ok', selftest: 'fail' });
    });

    it('treats a throwing availability probe as unavailable', async () => {
      const readiness = await readinessWith({
        seams: { sandbox: { availability: () => Promise.reject(new Error('boom')) } },
      });
      expect(readiness).toMatchObject({ sandbox: 'unavailable', selftest: 'skipped' });
    });

    it('lists the built-in plans when no seam replaces them', async () => {
      start(approvalRunner(), {
        plane: { approvalStore: store, readText: () => Promise.resolve(undefined) },
      });
      await handshake();
      expect(framesOf('ready')[0]?.readiness.plans).toContain('implement-review');
    });
  });

  describe('run', () => {
    it('forwards progress, announces the approval once, and commits after the owner approves', async () => {
      start(
        approvalRunner([
          { type: 'lane.started', lane: 'feature', role: 'feature', round: 0 },
          step('gate.completed', { phase: 'gate', name: 'test', round: 0, passed: true }),
        ]),
      );
      await handshake();
      input.frame(runFrame({ planId: 'implement-review' }));
      await waitFor(() => framesOf('approval-required').length === 1, 'approval-required');

      const [required] = framesOf('approval-required');
      expect(required).toMatchObject({
        runId: RUN,
        summary: {
          taskId: TASK,
          branch: `nexar/${TASK}`,
          files: 2,
          gatesPassed: 2,
          reviewVerdict: 'approve',
          patchSha256: PATCH_SHA,
          ttlMs: 60_000,
        },
      });
      const approvalId = required?.approvalId as string;
      const progress = framesOf('progress').map((f) => f.event.type);
      expect(progress).toEqual(['lane.started', 'step', 'awaiting-approval']);

      // Nothing is decided on its own.
      expect((await store.get(approvalId))?.status).toBe('pending');
      input.frame({ type: 'decide', approvalId, decision: 'approve' });
      await waitFor(() => framesOf('completed').length === 1, 'completed');

      expect(framesOf('decided')).toEqual([{ type: 'decided', approvalId, status: 'approved' }]);
      expect(framesOf('completed')[0]).toEqual({
        type: 'completed',
        runId: RUN,
        outcome: {
          taskId: TASK,
          status: 'committed',
          branch: `nexar/${TASK}`,
          commit: 'd'.repeat(40),
        },
      });
      expect((await store.get(approvalId))?.decidedBy).toBe('desktop:tester');
      expect(framesOf('approval-required')).toHaveLength(1);

      // The runner got exactly the allowed fields, with the lineage.
      expect(inputs).toEqual([
        { projectId: 'demo', goal: `fix ${GOAL_MARKER}`, planId: 'implement-review', lineage },
      ]);
    });

    it('records a denial as not-accepted', async () => {
      start();
      await handshake();
      input.frame(runFrame());
      await waitFor(() => framesOf('approval-required').length === 1, 'approval-required');
      const approvalId = framesOf('approval-required')[0]?.approvalId as string;
      input.frame({ type: 'decide', approvalId, decision: 'deny' });
      await waitFor(() => framesOf('completed').length === 1, 'completed');
      expect(framesOf('decided')[0]).toMatchObject({ approvalId, status: 'denied' });
      expect(framesOf('completed')[0]?.outcome).toMatchObject({
        status: 'not-accepted',
        reason: 'approval.denied',
      });
      expect(inputs[0]).not.toHaveProperty('planId');
    });

    it('cancels the active run and reports it cancelled', async () => {
      start();
      await handshake();
      input.frame(runFrame());
      await waitFor(() => framesOf('approval-required').length === 1, 'approval-required');
      input.frame({ type: 'cancel', runId: RUN });
      await waitFor(() => framesOf('completed').length === 1, 'completed');
      expect(framesOf('completed')[0]?.outcome).toMatchObject({ status: 'cancelled' });
      // The pending approval was cancelled by the gate, so it can no longer be decided.
      const approvalId = framesOf('approval-required')[0]?.approvalId as string;
      expect((await store.get(approvalId))?.status).toBe('cancelled');
      input.frame({ type: 'decide', approvalId, decision: 'approve' });
      await waitFor(() => framesOf('error').length === 1, 'error');
      expect(framesOf('error')[0]).toMatchObject({ code: 'POLICY_REJECTED' });
    });

    it('answers cancel for an unknown run with an error and keeps serving', async () => {
      start();
      await handshake();
      input.frame({ type: 'cancel', runId: RUN2 });
      await waitFor(() => framesOf('error').length === 1, 'error');
      expect(framesOf('error')[0]).toMatchObject({ runId: RUN2, code: 'VALIDATION_ERROR' });
      input.frame({ type: 'shutdown' });
      expect(await exitCode).toBe(0);
    });

    it('allows one run at a time', async () => {
      start();
      await handshake();
      input.frame(runFrame());
      await waitFor(() => framesOf('approval-required').length === 1, 'approval-required');
      input.frame(runFrame({ runId: RUN2 }));
      await waitFor(() => framesOf('error').length === 1, 'error');
      expect(framesOf('error')[0]).toMatchObject({ runId: RUN2, code: 'CONFLICT' });
      expect(runnerCalls).toBe(1);
    });

    it('can start another run once the first has completed', async () => {
      start();
      await handshake();
      input.frame(runFrame());
      await waitFor(() => framesOf('approval-required').length === 1, 'approval-required');
      input.frame({ type: 'cancel', runId: RUN });
      await waitFor(() => framesOf('completed').length === 1, 'completed');
      input.frame(runFrame({ runId: RUN2 }));
      await waitFor(() => runnerCalls === 2, 'second run');
      expect(framesOf('error')).toEqual([]);
    });

    it('rejects the review intent before touching the runner', async () => {
      start();
      await handshake();
      input.frame(runFrame({ intent: 'review' }));
      await waitFor(() => framesOf('error').length === 1, 'error');
      expect(framesOf('error')[0]).toEqual({
        type: 'error',
        runId: RUN,
        code: 'POLICY_REJECTED',
        message: 'Report-only engineering plans are not available yet',
      });
      expect(runnerCalls).toBe(0);
    });

    it.each([
      ['an unknown project', 'ghost'],
      ['a project without engineering settings', 'plain'],
    ])('rejects %s without echoing anything', async (_name, planeProject) => {
      start();
      await handshake();
      input.frame(runFrame({ planeProject }));
      await waitFor(() => framesOf('error').length === 1, 'error');
      expect(framesOf('error')[0]).toMatchObject({ runId: RUN, code: 'VALIDATION_ERROR' });
      expect(runnerCalls).toBe(0);
      // A rejected run does not occupy the plane.
      input.frame(runFrame({ runId: RUN2 }));
      await waitFor(() => runnerCalls === 1, 'next run');
    });

    it('turns a runner failure into an error frame with a fixed message', async () => {
      const failing: EngineeringRunnerPort = {
        run: () =>
          Promise.reject(
            Object.assign(new Error(`boom ${dir} ${GOAL_MARKER}`), {
              name: 'NexarError',
              code: 'CONFIGURATION_ERROR',
            }),
          ),
        cleanup: () => Promise.resolve(),
      };
      start(failing);
      await handshake();
      input.frame(runFrame());
      await waitFor(() => framesOf('error').length === 1, 'error');
      expect(framesOf('error')[0]).toMatchObject({ runId: RUN, code: 'CONFIGURATION_ERROR' });
      expect(out).not.toContain(dir);
      expect(out).not.toContain('boom');
    });

    it('never puts the goal, a path or the record location on stdout or stderr', async () => {
      start();
      await handshake();
      input.frame(runFrame());
      await waitFor(() => framesOf('approval-required').length === 1, 'approval-required');
      input.frame({ type: 'cancel', runId: RUN });
      await waitFor(() => framesOf('completed').length === 1, 'completed');
      for (const text of [out, err]) {
        expect(text).not.toContain(GOAL_MARKER);
        expect(text).not.toContain('/abs/secret');
        expect(text).not.toContain(dir);
      }
    });

    it('ends the run when standard input ends, then exits 0', async () => {
      start();
      await handshake();
      input.frame(runFrame());
      await waitFor(() => framesOf('approval-required').length === 1, 'approval-required');
      input.end();
      expect(await exitCode).toBe(0);
      expect(framesOf('completed')[0]?.outcome).toMatchObject({ status: 'cancelled' });
    });

    it('aborts the run and waits for it on shutdown', async () => {
      start();
      await handshake();
      input.frame(runFrame());
      await waitFor(() => framesOf('approval-required').length === 1, 'approval-required');
      input.frame({ type: 'shutdown' });
      expect(await exitCode).toBe(0);
      expect(framesOf('completed')).toHaveLength(1);
    });
  });

  describe('decide', () => {
    it('refuses an approval id this plane never announced, even a real pending one', async () => {
      start();
      await handshake();
      // Someone else's pending approval, as `nexar approvals list` would show it.
      const gate = new ApprovalGate({ mode: 'store', store, pollIntervalMs: 5 });
      const abort = new AbortController();
      const waiting = gate
        .request(
          { type: 'engineering.commit', target: 'x', parameters: {} },
          { summary: 's', risk: 'low', ttlMs: 60_000, signal: abort.signal },
        )
        .catch(() => undefined);
      let foreign: Awaited<ReturnType<typeof store.list>>[number] | undefined;
      for (let i = 0; i < 200 && foreign === undefined; i += 1) {
        foreign = (await store.list({ status: 'pending' }))[0];
        if (foreign === undefined) await new Promise((resolve) => setTimeout(resolve, 5));
      }
      expect(foreign).toBeDefined();
      input.frame({ type: 'decide', approvalId: foreign?.id as string, decision: 'approve' });
      input.frame({ type: 'decide', approvalId: `apr_${'f'.repeat(32)}`, decision: 'approve' });
      await waitFor(() => framesOf('error').length === 2, 'errors');
      expect(framesOf('error').map((f) => f.code)).toEqual(['POLICY_REJECTED', 'POLICY_REJECTED']);
      expect((await store.get(foreign?.id as string))?.status).toBe('pending');
      abort.abort();
      await waiting;
    });

    it('refuses a second decision on the same approval', async () => {
      start();
      await handshake();
      input.frame(runFrame());
      await waitFor(() => framesOf('approval-required').length === 1, 'approval-required');
      const approvalId = framesOf('approval-required')[0]?.approvalId as string;
      input.frame({ type: 'decide', approvalId, decision: 'deny' });
      input.frame({ type: 'decide', approvalId, decision: 'approve' });
      await waitFor(() => framesOf('error').length === 1, 'error');
      expect(framesOf('decided')).toHaveLength(1);
      expect(framesOf('error')[0]).toMatchObject({ code: 'POLICY_REJECTED' });
      expect((await store.get(approvalId))?.status).toBe('denied');
    });
  });

  describe('diff', () => {
    const sha = (text: string): string => createHash('sha256').update(text).digest('hex');

    function fileDiff(path: string, lines: readonly string[]): string {
      return [
        `diff --git a/${path} b/${path}`,
        'new file mode 100644',
        `index 0000000000000000000000000000000000000000..${'1'.repeat(40)}`,
        '--- /dev/null',
        `+++ b/${path}`,
        `@@ -0,0 +1,${String(lines.length)} @@`,
        ...lines.map((l) => `+${l}`),
        '',
      ].join('\n');
    }

    /** Writes the record and patch the runner would have left for TASK. */
    async function leavePatch(patch: string): Promise<void> {
      const record: EngineeringRecord = {
        schemaVersion: 1,
        taskId: TASK,
        projectId: 'demo',
        planId: 'implement-review',
        status: 'running',
        startedAt: '2026-10-03T10:00:00.000Z',
        baseBranch: 'main',
        branch: `nexar/${TASK}`,
        round: 0,
        lanes: [],
        commands: [],
        patches: [
          {
            round: 0,
            sha256: sha(patch),
            bytes: Buffer.byteLength(patch),
            files: 1,
            valid: true,
            violations: [],
          },
        ],
        reviews: [],
      };
      const taskState = join(dir, '.nexar', 'engineering', TASK);
      await mkdir(taskState, { recursive: true });
      await writeFile(join(taskState, 'record.json'), JSON.stringify(record));
      const out = join(dir, 'wt', 'demo', TASK, 'out');
      await mkdir(out, { recursive: true });
      await writeFile(join(out, 'patch-0.diff'), patch);
    }

    /** Runs to the approval point so the task id is known to this process. */
    async function knowTask(): Promise<void> {
      start();
      await handshake();
      input.frame(runFrame());
      await waitFor(() => framesOf('approval-required').length === 1, 'approval-required');
    }

    it('serves the patch of a task this process produced', async () => {
      const patch = fileDiff('src/a.ts', ['one', 'two']);
      await leavePatch(patch);
      await knowTask();
      input.frame({ type: 'diff', taskId: TASK });
      await waitFor(() => framesOf('diff').length === 1, 'diff');
      expect(framesOf('diff')[0]).toEqual({
        type: 'diff',
        taskId: TASK,
        text: patch,
        truncated: false,
        files: ['src/a.ts'],
      });
    });

    it('bounds the text to 256 KiB and says so', async () => {
      const patch = fileDiff(
        'big.txt',
        Array.from({ length: 400 }, () => 'x'.repeat(1000)),
      );
      expect(Buffer.byteLength(patch)).toBeGreaterThan(MAX_DIFF_BYTES);
      await leavePatch(patch);
      await knowTask();
      input.frame({ type: 'diff', taskId: TASK });
      await waitFor(() => framesOf('diff').length === 1, 'diff');
      const [frame] = framesOf('diff');
      expect(frame?.truncated).toBe(true);
      expect(Buffer.byteLength(frame?.text ?? '')).toBeLessThanOrEqual(MAX_DIFF_BYTES);
      expect(patch.startsWith(frame?.text ?? 'x')).toBe(true);
    });

    it('bounds the file list to 500', async () => {
      const patch = Array.from({ length: MAX_DIFF_FILES + 20 }, (_, i) =>
        fileDiff(`f${String(i)}.txt`, ['x']),
      ).join('');
      await leavePatch(patch);
      await knowTask();
      input.frame({ type: 'diff', taskId: TASK });
      await waitFor(() => framesOf('diff').length === 1, 'diff');
      expect(framesOf('diff')[0]?.files).toHaveLength(MAX_DIFF_FILES);
    });

    it('shrinks text whose JSON escapes would exceed the frame cap', async () => {
      const patch = fileDiff('ctl.bin', ['\u0001'.repeat(200_000)]);
      expect(Buffer.byteLength(patch)).toBeLessThan(MAX_DIFF_BYTES);
      await leavePatch(patch);
      await knowTask();
      input.frame({ type: 'diff', taskId: TASK });
      await waitFor(() => framesOf('diff').length === 1, 'diff');
      const [frame] = framesOf('diff');
      expect(frame?.truncated).toBe(true);
      expect(Buffer.byteLength(JSON.stringify(frame))).toBeLessThanOrEqual(MAX_FRAME_BYTES);
    });

    it('refuses a task this process did not produce, even if its record exists', async () => {
      await leavePatch(fileDiff('src/a.ts', ['one']));
      start();
      await handshake();
      input.frame({ type: 'diff', taskId: TASK });
      await waitFor(() => framesOf('error').length === 1, 'error');
      expect(framesOf('error')[0]).toMatchObject({ code: 'POLICY_REJECTED' });
      expect(framesOf('diff')).toEqual([]);
    });

    it('reports a missing patch without a path', async () => {
      await knowTask();
      input.frame({ type: 'diff', taskId: TASK });
      await waitFor(() => framesOf('error').length === 1, 'error');
      expect(framesOf('error')[0]).toMatchObject({ code: 'VALIDATION_ERROR' });
      expect(out).not.toContain(dir);
    });
  });

  describe('malformed input', () => {
    it('answers bad frames with an error and keeps serving', async () => {
      start();
      await handshake();
      input.push('{"type":"run"\n');
      input.push('{"type":"cancel","runId":"nope"}\n');
      input.push('{"type":"cancel","runId":"x","__proto__":{}}\n');
      await waitFor(() => framesOf('error').length === 3, 'errors');
      input.frame({ type: 'cancel', runId: RUN });
      await waitFor(() => framesOf('error').length === 4, 'a valid frame still works');
      expect(framesOf('error')[3]).toMatchObject({ runId: RUN });
      input.frame({ type: 'shutdown' });
      expect(await exitCode).toBe(0);
    });

    it('recovers from an oversize line', async () => {
      start();
      await handshake();
      input.push('x'.repeat(MAX_FRAME_BYTES + 10));
      input.push('x'.repeat(100));
      input.push(`\n${encodeFrame({ type: 'cancel', runId: RUN })}`);
      await waitFor(() => framesOf('error').length === 2, 'errors');
      const [oversize, unknownRun] = framesOf('error');
      expect(oversize?.message).toMatch(/size limit/);
      expect(unknownRun).toMatchObject({ runId: RUN });
      input.frame({ type: 'shutdown' });
      expect(await exitCode).toBe(0);
    });

    it('exits 1 after more than 8 consecutive decode failures', async () => {
      start();
      await handshake();
      for (let i = 0; i < 9; i += 1) input.push('garbage\n');
      expect(await exitCode).toBe(1);
      expect(framesOf('error')).toHaveLength(9);
    });

    it('counts only consecutive failures', async () => {
      start();
      await handshake();
      for (let round = 0; round < 3; round += 1) {
        for (let i = 0; i < 8; i += 1) input.push('garbage\n');
        input.frame({ type: 'cancel', runId: RUN });
      }
      await waitFor(() => framesOf('error').length === 27, 'errors');
      input.frame({ type: 'shutdown' });
      expect(await exitCode).toBe(0);
    });

    it('ends the connection on an unknown frame type', async () => {
      start();
      await handshake();
      input.push('{"type":"exec","command":"ls"}\n');
      expect(await exitCode).toBe(1);
      const errors = framesOf('error');
      expect(errors).toHaveLength(1);
      expect(out).not.toContain('exec');
    });

    it('accepts frames split across chunks and CRLF line ends', async () => {
      start();
      await handshake();
      const line = JSON.stringify({ type: 'cancel', runId: RUN });
      input.push(line.slice(0, 10));
      input.push(`${line.slice(10)}\r\n`);
      await waitFor(() => framesOf('error').length === 1, 'error');
      expect(framesOf('error')[0]).toMatchObject({ runId: RUN, code: 'VALIDATION_ERROR' });
    });
  });

  describe('command line', () => {
    const run = async (...argv: string[]): Promise<{ code: number; stdout: string }> => {
      let stdout = '';
      const code = await runCli(argv, { ...io(), stdout: (s) => (stdout += s) });
      return { code, stdout };
    };

    it.each([
      [['plane']],
      [['plane', 'serve']],
      [['plane', '--stdio']],
      [['plane', 'serve', '--stdio', 'extra']],
      [['plane', 'serve', '--stdio', '--json']],
      [['plane', 'listen', '--stdio']],
      [['plane', 'serve', '--stdio', '--socket', 'x']],
    ])('exits 2 for %j', async (argv) => {
      const result = await run(...argv);
      expect(result.code).toBe(2);
      expect(result.stdout).toBe('');
    });

    it('prints help and is listed in the command summary', async () => {
      const help = await run('plane', '--help');
      expect(help.code).toBe(0);
      expect(help.stdout).toContain('nexar plane serve --stdio');
      expect((await run('--help')).stdout).toMatch(/\bplane\b/);
    });

    it('needs a standard input stream', async () => {
      let stderr = '';
      const code = await runCli(['plane', 'serve', '--stdio'], {
        stdout: () => undefined,
        stderr: (s) => (stderr += s),
        env: {},
        cwd: dir,
      });
      expect(code).toBe(2);
      expect(stderr).toContain('standard input');
    });
  });
});
