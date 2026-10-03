import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { NexarError } from '@nexar/contracts';
import type { Logger } from '@nexar/contracts';
import { FileSessionStore } from '@nexar/sessions';
import type { OperatingMode, OperatingSession } from '@nexar/sessions';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { MAX_CODE_GOAL_CHARS, MAX_CONCURRENT_TURNS, OperatingService } from './service.js';
import type { CodeRequest, DirectRequest, OperatingPorts } from './service.js';

let root: string;

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'nexar-operating-'));
});

afterEach(async () => {
  await rm(root, { recursive: true, force: true });
});

interface LogCall {
  readonly level: string;
  readonly msg: string;
  readonly fields: unknown;
}

function fakeLogger(calls: LogCall[]): Logger {
  const logger: Logger = {
    debug: (msg, fields) => void calls.push({ level: 'debug', msg, fields }),
    info: (msg, fields) => void calls.push({ level: 'info', msg, fields }),
    warn: (msg, fields) => void calls.push({ level: 'warn', msg, fields }),
    error: (msg, fields) => void calls.push({ level: 'error', msg, fields }),
    child: () => logger,
  };
  return logger;
}

interface Harness {
  readonly store: FileSessionStore;
  readonly service: OperatingService;
  readonly requests: DirectRequest[];
  readonly logs: LogCall[];
  readonly changes: string[];
  readonly progress: string[];
  readonly availability: { cowork: boolean; code: boolean };
  newSession(mode?: OperatingMode): Promise<OperatingSession>;
  session(id: string): Promise<OperatingSession>;
  makeService(overrides?: Partial<OperatingPorts>, withCode?: boolean): OperatingService;
}

type Execute = OperatingPorts['executeDirect'];

let counter = 0;

async function harness(execute?: Execute): Promise<Harness> {
  let n = 0;
  const store = new FileSessionStore(join(root, 'sessions'), {
    newId: () => {
      n += 1;
      return (n + counter * 100_000).toString(16).padStart(32, '0');
    },
    isProcessAlive: () => false,
  });
  counter += 1;
  await store.acquireLease();
  const requests: DirectRequest[] = [];
  const logs: LogCall[] = [];
  const changes: string[] = [];
  const progress: string[] = [];
  const availability = { cowork: false, code: false };
  let taskCount = 0;

  const defaultExecute: Execute = async (request) => {
    requests.push(request);
    taskCount += 1;
    const taskId = `task-${String(taskCount)}`;
    await request.onTask(taskId);
    request.onProgress('status', 'working');
    return {
      taskId,
      text: `answer ${String(taskCount)}`,
      artifacts: [{ uri: `file:///projects/p/out-${String(taskCount)}.md`, label: 'draft' }],
      resourceId: 'echo',
      policyId: 'deterministic@1',
      fallback: false,
    };
  };
  const run: Execute = execute ?? defaultExecute;
  const recording: Execute = (request, signal) => {
    if (execute !== undefined) requests.push(request);
    return run(request, signal);
  };

  // A fake Code executor over the same recording executor, so Code-lane turns are counted too.
  const executeCode: NonNullable<OperatingPorts['executeCode']> = async (request, signal) => {
    const result = await recording(
      {
        sessionId: request.sessionId,
        turnId: request.turnId,
        projectId: request.projectId,
        kind: request.intent,
        prompt: request.goal,
        correlation: request.correlation,
        onTask: request.onTask,
        onProgress: request.onProgress,
      },
      signal,
    );
    return {
      taskId: result.taskId,
      text: result.text,
      engineering: {
        planeTaskId: result.taskId,
        status: 'committed',
        files: 1,
        gatesPassed: 1,
        reviewVerdict: 'approve',
      },
    };
  };

  const makeService = (
    overrides: Partial<OperatingPorts> = {},
    withCode = true,
  ): OperatingService =>
    new OperatingService({
      store,
      lanes: { available: (lane) => availability[lane] },
      executeDirect: recording,
      ...(withCode ? { executeCode } : {}),
      describeArtifact: (ref) => ref.label,
      onTurnChanged: (_s, t) => void changes.push(t),
      onProgress: (_s, _t, _type, message) => void progress.push(message),
      logger: fakeLogger(logs),
      ...overrides,
    });

  return {
    store,
    service: makeService(),
    requests,
    logs,
    changes,
    progress,
    availability,
    makeService,
    newSession: (mode = 'cowork') =>
      store.create({ projectId: 'proj-1', mode, title: 'Conversation' }),
    session: async (id) => {
      const session = await store.get(id);
      if (session === undefined) throw new Error('missing session');
      return session;
    },
  };
}

let keys = 0;
const nextKey = (): string => `submission-key-${String((keys += 1)).padStart(8, '0')}`;

function blocking(): { execute: Execute; release: () => void; started: Promise<void> } {
  let release!: () => void;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  let started!: () => void;
  const startedPromise = new Promise<void>((resolve) => {
    started = resolve;
  });
  const execute: Execute = async (request, signal) => {
    await request.onTask(`task-${request.turnId.slice(-6)}`);
    started();
    await new Promise<void>((resolve, reject) => {
      signal.addEventListener('abort', () =>
        reject(new NexarError('EXECUTION_CANCELLED', 'aborted')),
      );
      void gate.then(resolve);
    });
    return { taskId: `task-${request.turnId.slice(-6)}`, text: 'done', artifacts: [] };
  };
  return { execute, release, started: startedPromise };
}

describe('OperatingService', () => {
  it('rejects an unknown session', async () => {
    const h = await harness();
    await expect(
      h.service.submit({
        sessionId: `ses_${'0'.repeat(32)}`,
        submissionKey: nextKey(),
        text: 'hi',
      }),
    ).rejects.toMatchObject({ code: 'VALIDATION_ERROR' });
  });

  describe('run path', () => {
    it('runs end to end, stores the context manifest and feeds prior turns forward', async () => {
      const h = await harness();
      const s = await h.newSession();

      const first = await h.service.submit({
        sessionId: s.id,
        submissionKey: nextKey(),
        text: 'What is on my plate?',
      });
      expect(first).toMatchObject({ created: true, action: 'run' });
      expect(first.turn.state).toBe('running');
      expect(first.turn.intent).toMatchObject({ kind: 'general', ruleIds: ['default'] });
      await h.service.whenIdle();

      let session = await h.session(s.id);
      const t1 = session.turns[0];
      expect(t1).toMatchObject({
        state: 'succeeded',
        outcome: { text: 'answer 1' },
        tasks: [
          { taskId: 'task-1', state: 'succeeded', resourceId: 'echo', policyId: 'deterministic@1' },
        ],
        artifacts: [{ label: 'draft' }],
      });
      expect(t1?.context).toMatchObject({ policy: 'context@1', turnIds: [], omittedTurns: 0 });
      // The Desktop state: no orchestrated lanes, so the fallback is recorded honestly.
      expect(t1?.lane).toMatchObject({
        requestedLane: 'cowork',
        effectiveLane: 'direct',
        fallbackReason: 'orchestrator-unavailable',
      });
      expect(session.activeTurnId).toBeNull();
      expect(h.service.executions()).toBe(0);
      expect(h.progress).toContain('working');
      expect(h.changes).toContain(first.turn.id);

      await h.service.submit({
        sessionId: s.id,
        submissionKey: nextKey(),
        text: 'And tomorrow?',
      });
      await h.service.whenIdle();

      session = await h.session(s.id);
      const t2 = session.turns[1];
      expect(t2?.state).toBe('succeeded');
      expect(t2?.context?.turnIds).toEqual([t1?.id]);
      expect(t2?.context?.artifactIds).toEqual(['draft']);
      const request = h.requests[1];
      expect(request?.prompt).toContain('[turn 1] Owner: What is on my plate?');
      expect(request?.prompt).toContain('[turn 1] Nexar: answer 1');
      expect(request?.prompt).toContain('And tomorrow?');
      expect(request?.prompt).not.toContain('file:///');
      expect(request).toMatchObject({ projectId: 'proj-1', kind: 'general', sessionId: s.id });
    });

    it('passes a depth 0 root correlation bound to the turn', async () => {
      const h = await harness();
      const s = await h.newSession();
      const { turn } = await h.service.submit({
        sessionId: s.id,
        submissionKey: nextKey(),
        text: 'hello',
      });
      await h.service.whenIdle();
      expect(h.requests[0]?.correlation).toEqual({
        rootSessionId: s.id,
        turnId: turn.id,
        rootOrchestrator: 'nexar',
        chain: ['nexar'],
        currentOrchestrator: 'nexar',
        depth: 0,
        correlationId: turn.id,
      });
    });

    it('forwards the explicit kind and run options', async () => {
      const h = await harness();
      const s = await h.newSession('code');
      await h.service.submit({
        sessionId: s.id,
        submissionKey: nextKey(),
        text: 'anything at all',
        explicitKind: 'analysis',
        preferredResourceIds: ['echo'],
        maxCostUsd: 0.5,
      });
      await h.service.whenIdle();
      expect(h.requests[0]).toMatchObject({
        kind: 'analysis',
        preferredResourceIds: ['echo'],
        maxCostUsd: 0.5,
      });
      const session = await h.session(s.id);
      expect(session.turns[0]?.intent).toMatchObject({ source: 'explicit', ruleIds: ['explicit'] });
    });
  });

  describe('confirm path', () => {
    it('pauses a coding turn in cowork mode, then runs it once confirmed', async () => {
      const h = await harness();
      h.availability.code = true;
      const s = await h.newSession('cowork');

      const submitted = await h.service.submit({
        sessionId: s.id,
        submissionKey: nextKey(),
        text: 'Implement the missing backend endpoint.',
      });
      expect(submitted).toMatchObject({ created: true, action: 'confirm' });
      expect(submitted.turn.state).toBe('pending-confirmation');
      expect(submitted.turn.lane).toMatchObject({
        mismatch: { from: 'cowork', to: 'code' },
        effectiveLane: 'code',
      });
      expect(h.requests).toHaveLength(0);
      expect(h.service.executions()).toBe(0);

      const running = await h.service.confirm({
        sessionId: s.id,
        turnId: submitted.turn.id,
        decision: 'confirm',
      });
      expect(running.state).toBe('running');
      await h.service.whenIdle();

      const session = await h.session(s.id);
      expect(session.mode).toBe('cowork'); // confirmation never changes the mode
      expect(session.turns[0]).toMatchObject({
        state: 'succeeded',
        lane: { confirmed: true, effectiveLane: 'code', mode: 'cowork' },
      });
      expect(h.requests).toHaveLength(1);
      expect(h.requests[0]).toMatchObject({ kind: 'coding' });
    });

    it('refuses a Code-lane run that carries a cost ceiling instead of dropping it', async () => {
      const h = await harness();
      h.availability.code = true;
      const s = await h.newSession('code');
      await h.service.submit({
        sessionId: s.id,
        submissionKey: nextKey(),
        text: 'Implement the missing backend endpoint.',
        maxCostUsd: 1,
      });
      await h.service.whenIdle();
      const turn = (await h.session(s.id)).turns[0];
      expect(turn?.state).toBe('failed');
      expect(turn?.outcome?.error?.code).toBe('POLICY_REJECTED');
      expect(h.requests).toHaveLength(0);
    });

    it('declining runs nothing and frees the session', async () => {
      const h = await harness();
      h.availability.code = true;
      const s = await h.newSession('cowork');
      const { turn } = await h.service.submit({
        sessionId: s.id,
        submissionKey: nextKey(),
        text: 'Implement the missing part.',
      });
      const declined = await h.service.confirm({
        sessionId: s.id,
        turnId: turn.id,
        decision: 'decline',
      });
      expect(declined.state).toBe('declined');
      await h.service.whenIdle();
      expect(h.requests).toHaveLength(0);
      const session = await h.session(s.id);
      expect(session.activeTurnId).toBeNull();
      expect(session.turns[0]?.tasks).toEqual([]);
    });

    it('re-checks availability at confirmation and refuses an engineering write', async () => {
      const h = await harness();
      h.availability.code = true;
      const s = await h.newSession('cowork');
      const { turn } = await h.service.submit({
        sessionId: s.id,
        submissionKey: nextKey(),
        text: 'Implement the missing part.',
      });
      h.availability.code = false; // the world changed while pending

      const failed = await h.service.confirm({
        sessionId: s.id,
        turnId: turn.id,
        decision: 'confirm',
      });
      expect(failed.state).toBe('failed');
      expect(failed.outcome?.error?.code).toBe('SANDBOX_UNAVAILABLE');
      expect(h.requests).toHaveLength(0);
      expect((await h.session(s.id)).activeTurnId).toBeNull();
    });

    it('rejects confirming a turn that is not pending, and a second confirmation', async () => {
      const h = await harness();
      h.availability.code = true;
      const s = await h.newSession('cowork');
      const { turn } = await h.service.submit({
        sessionId: s.id,
        submissionKey: nextKey(),
        text: 'Implement the missing part.',
      });
      await h.service.confirm({ sessionId: s.id, turnId: turn.id, decision: 'confirm' });
      await h.service.whenIdle();
      await expect(
        h.service.confirm({ sessionId: s.id, turnId: turn.id, decision: 'confirm' }),
      ).rejects.toMatchObject({ code: 'CONFLICT' });
      expect(h.requests).toHaveLength(1);
      await expect(
        h.service.confirm({
          sessionId: s.id,
          turnId: `turn_${'9'.repeat(32)}`,
          decision: 'confirm',
        }),
      ).rejects.toMatchObject({ code: 'VALIDATION_ERROR' });
    });

    it('fails closed when a pending confirmation lost its in-memory options', async () => {
      const h = await harness();
      h.availability.code = true;
      const s = await h.newSession('cowork');
      const { turn } = await h.service.submit({
        sessionId: s.id,
        submissionKey: nextKey(),
        text: 'Implement the missing part.',
        maxCostUsd: 0.01,
      });
      const restarted = h.makeService(); // e.g. after an app restart: no options remembered
      await expect(
        restarted.confirm({ sessionId: s.id, turnId: turn.id, decision: 'confirm' }),
      ).rejects.toMatchObject({ code: 'CONFLICT', details: { reason: 'confirmation-expired' } });
      expect(h.requests).toHaveLength(0);
      const declined = await restarted.confirm({
        sessionId: s.id,
        turnId: turn.id,
        decision: 'decline',
      });
      expect(declined.state).toBe('declined');
    });
  });

  describe('refuse path', () => {
    it('fails a coding turn with SANDBOX_UNAVAILABLE and executes nothing', async () => {
      const h = await harness();
      const s = await h.newSession('code');
      const result = await h.service.submit({
        sessionId: s.id,
        submissionKey: nextKey(),
        text: 'Please implement the retry logic.',
      });
      expect(result).toMatchObject({ created: true, action: 'refuse' });
      expect(result.turn.state).toBe('failed');
      expect(result.turn.outcome?.error).toEqual({
        code: 'SANDBOX_UNAVAILABLE',
        message:
          'Engineering changes need the Code lane (WSL2 engineering plane), which is not available yet.',
      });
      expect(result.turn.lane).toMatchObject({ fallbackReason: 'code-lane-unavailable' });
      expect(h.requests).toHaveLength(0);
      expect(h.service.executions()).toBe(0);
      expect((await h.session(s.id)).activeTurnId).toBeNull();
    });

    it('refuses before asking for a confirmation (cowork mode)', async () => {
      const h = await harness();
      const s = await h.newSession('cowork');
      const result = await h.service.submit({
        sessionId: s.id,
        submissionKey: nextKey(),
        text: 'Implement the missing part.',
      });
      expect(result.action).toBe('refuse');
      expect(result.turn.state).toBe('failed');
    });
  });

  describe('fallback path', () => {
    it('runs read/draft work directly when the lane is unavailable and records why', async () => {
      const h = await harness();
      const s = await h.newSession('code');
      const result = await h.service.submit({
        sessionId: s.id,
        submissionKey: nextKey(),
        text: 'Analyze the numbers for me',
      });
      expect(result.action).toBe('run');
      await h.service.whenIdle();
      const session = await h.session(s.id);
      expect(session.turns[0]).toMatchObject({
        state: 'succeeded',
        intent: { kind: 'analysis' },
        lane: {
          requestedLane: 'code',
          effectiveLane: 'direct',
          fallbackReason: 'orchestrator-unavailable',
        },
      });
      expect(h.requests).toHaveLength(1);
    });

    it('records a non-engineering turn in Code mode as direct, with the reason', async () => {
      const h = await harness();
      h.availability.code = true;
      const service = h.makeService({
        executeCode: () => Promise.reject(new Error('must not run')),
      });
      const s = await h.newSession('code');
      await service.submit({ sessionId: s.id, submissionKey: nextKey(), text: 'Explain this' });
      await service.whenIdle();
      const session = await h.session(s.id);
      expect(session.turns[0]?.lane).toMatchObject({
        requestedLane: 'code',
        effectiveLane: 'direct',
        fallbackReason: 'code-engineering-only',
      });
      expect(session.turns[0]?.state).toBe('succeeded');
      expect(h.requests).toHaveLength(1);
    });

    it('records a review turn as direct while the Code lane cannot run reports', async () => {
      const h = await harness();
      h.availability.code = true;
      const service = h.makeService({
        lanes: {
          available: (lane) => h.availability[lane],
          supports: (lane, kind) => !(lane === 'code' && kind === 'review'),
        },
        executeCode: () => Promise.reject(new Error('must not run')),
      });
      const s = await h.newSession('code');
      await service.submit({
        sessionId: s.id,
        submissionKey: nextKey(),
        text: 'Now verify whether the repository implementation supports this proposal.',
      });
      await service.whenIdle();
      const turn = (await h.session(s.id)).turns[0];
      expect(turn?.intent?.kind).toBe('review');
      expect(turn?.lane).toMatchObject({
        effectiveLane: 'direct',
        fallbackReason: 'code-report-unavailable',
      });
      expect(turn?.state).toBe('succeeded');
    });
  });

  describe('idempotent submission', () => {
    it('starts one execution for a repeated submission key', async () => {
      const h = await harness();
      const s = await h.newSession();
      const key = nextKey();
      const [a, b] = await Promise.all([
        h.service.submit({ sessionId: s.id, submissionKey: key, text: 'hello' }),
        h.service.submit({ sessionId: s.id, submissionKey: key, text: 'hello' }),
      ]);
      await h.service.whenIdle();
      expect([a.created, b.created].sort()).toEqual([false, true]);
      expect(a.turn.id).toBe(b.turn.id);
      expect(h.requests).toHaveLength(1);

      const again = await h.service.submit({ sessionId: s.id, submissionKey: key, text: 'hello' });
      expect(again.created).toBe(false);
      expect(again.action).toBe('run');
      expect(h.requests).toHaveLength(1);
      expect((await h.session(s.id)).turns).toHaveLength(1);
    });

    it('rejects a key reused with different text', async () => {
      const h = await harness();
      const s = await h.newSession();
      const key = nextKey();
      await h.service.submit({ sessionId: s.id, submissionKey: key, text: 'hello' });
      await h.service.whenIdle();
      await expect(
        h.service.submit({ sessionId: s.id, submissionKey: key, text: 'other' }),
      ).rejects.toMatchObject({ code: 'VALIDATION_ERROR' });
    });

    it('replays refusal and pending confirmation with the matching action', async () => {
      const h = await harness();
      const code = await h.newSession('code');
      const refusedKey = nextKey();
      const text = 'Implement the missing part.';
      await h.service.submit({ sessionId: code.id, submissionKey: refusedKey, text });
      expect(
        await h.service.submit({ sessionId: code.id, submissionKey: refusedKey, text }),
      ).toMatchObject({ created: false, action: 'refuse' });

      h.availability.code = true;
      const cowork = await h.newSession('cowork');
      const pendingKey = nextKey();
      await h.service.submit({ sessionId: cowork.id, submissionKey: pendingKey, text });
      expect(
        await h.service.submit({ sessionId: cowork.id, submissionKey: pendingKey, text }),
      ).toMatchObject({ created: false, action: 'confirm' });
    });

    it('keeps the session single-flight', async () => {
      const gate = blocking();
      const h = await harness(gate.execute);
      const s = await h.newSession();
      await h.service.submit({ sessionId: s.id, submissionKey: nextKey(), text: 'one' });
      await gate.started;
      await expect(
        h.service.submit({ sessionId: s.id, submissionKey: nextKey(), text: 'two' }),
      ).rejects.toMatchObject({ code: 'CONFLICT' });
      gate.release();
      await h.service.whenIdle();
    });
  });

  describe('cancel', () => {
    it('aborts the in-flight execution and records cancelled turn and task', async () => {
      const gate = blocking();
      const h = await harness(gate.execute);
      const s = await h.newSession();
      const { turn } = await h.service.submit({
        sessionId: s.id,
        submissionKey: nextKey(),
        text: 'a long job',
      });
      await gate.started;
      expect(h.service.executions()).toBe(1);

      expect(h.service.cancel(s.id, turn.id)).toBe(true);
      await h.service.whenIdle();

      const session = await h.session(s.id);
      expect(session.turns[0]).toMatchObject({
        state: 'cancelled',
        tasks: [{ state: 'cancelled' }],
      });
      expect(session.activeTurnId).toBeNull();
      expect(h.service.executions()).toBe(0);
      expect(h.service.cancel(s.id, turn.id)).toBe(false);
    });

    it('returns false for an unknown or finished turn', async () => {
      const h = await harness();
      const s = await h.newSession();
      expect(h.service.cancel(s.id, `turn_${'1'.repeat(32)}`)).toBe(false);
    });
  });

  describe('failures', () => {
    it('records a NexarError code and message', async () => {
      const h = await harness(async (request) => {
        await request.onTask('task-x');
        throw new NexarError('QUOTA_EXHAUSTED', 'No quota left');
      });
      const s = await h.newSession();
      await h.service.submit({ sessionId: s.id, submissionKey: nextKey(), text: 'hello' });
      await h.service.whenIdle();
      const session = await h.session(s.id);
      expect(session.turns[0]).toMatchObject({
        state: 'failed',
        outcome: { error: { code: 'QUOTA_EXHAUSTED', message: 'No quota left' } },
        tasks: [{ taskId: 'task-x', state: 'failed' }],
      });
    });

    it('hides unexpected errors behind INTERNAL_ERROR and never logs content', async () => {
      const h = await harness(() => {
        throw new Error('C:\\secret\\path leaked OWNER-TEXT');
      });
      const s = await h.newSession();
      await h.service.submit({
        sessionId: s.id,
        submissionKey: nextKey(),
        text: 'OWNER-TEXT please',
      });
      await h.service.whenIdle();
      const session = await h.session(s.id);
      expect(session.turns[0]?.outcome?.error).toEqual({
        code: 'INTERNAL_ERROR',
        message: 'Internal error',
      });
      expect(session.activeTurnId).toBeNull();
      expect(JSON.stringify(h.logs)).not.toMatch(/secret|OWNER-TEXT/);
    });

    it('logs store failures during completion by code only', async () => {
      const h = await harness();
      const s = await h.newSession();
      const failing = h.makeService({
        store: {
          get: (id) => h.store.get(id),
          beginTurn: (...args) => h.store.beginTurn(...args),
          resolveConfirmation: (...args) => h.store.resolveConfirmation(...args),
          linkTask: (...args) => h.store.linkTask(...args),
          updateTask: (...args) => h.store.updateTask(...args),
          linkArtifacts: (...args) => h.store.linkArtifacts(...args),
          linkApprovals: (...args) => h.store.linkApprovals(...args),
          setContext: (...args) => h.store.setContext(...args),
          completeTurn: () => Promise.reject(new NexarError('CONFLICT', 'disk says OWNER-TEXT')),
        },
      });
      await failing.submit({ sessionId: s.id, submissionKey: nextKey(), text: 'OWNER-TEXT' });
      await failing.whenIdle();
      const warnings = h.logs.filter((l) => l.level === 'warn');
      expect(warnings.length).toBeGreaterThan(0);
      for (const call of warnings) expect(call.fields).toEqual({ code: 'CONFLICT' });
      expect(JSON.stringify(h.logs)).not.toContain('OWNER-TEXT');
      expect(failing.executions()).toBe(0);
    });

    it('survives throwing listeners', async () => {
      const h = await harness();
      const noisy = h.makeService({
        onTurnChanged: () => {
          throw new Error('listener boom');
        },
        onProgress: () => {
          throw new Error('listener boom');
        },
      });
      const s = await h.newSession();
      await noisy.submit({ sessionId: s.id, submissionKey: nextKey(), text: 'hello' });
      await noisy.whenIdle();
      expect((await h.session(s.id)).turns[0]?.state).toBe('succeeded');
    });
  });

  describe('concurrency limit', () => {
    it('rejects the 17th concurrent turn without creating it', async () => {
      const gate = blocking();
      const h = await harness(gate.execute);
      const sessions = await Promise.all(
        Array.from({ length: MAX_CONCURRENT_TURNS + 1 }, () => h.newSession()),
      );
      const accepted = await Promise.all(
        sessions
          .slice(0, MAX_CONCURRENT_TURNS)
          .map((s) =>
            h.service.submit({ sessionId: s.id, submissionKey: nextKey(), text: 'work' }),
          ),
      );
      expect(accepted.every((r) => r.action === 'run')).toBe(true);
      expect(h.service.executions()).toBe(MAX_CONCURRENT_TURNS);

      const extra = sessions[MAX_CONCURRENT_TURNS];
      if (extra === undefined) throw new Error('missing session');
      await expect(
        h.service.submit({ sessionId: extra.id, submissionKey: nextKey(), text: 'work' }),
      ).rejects.toMatchObject({ code: 'POLICY_REJECTED' });
      expect((await h.session(extra.id)).turns).toHaveLength(0);

      gate.release();
      await h.service.whenIdle();
      expect(h.service.executions()).toBe(0);
      await h.service.submit({ sessionId: extra.id, submissionKey: nextKey(), text: 'work' });
      await h.service.whenIdle();
    });
  });

  describe('lane availability per project and refusal reason', () => {
    it('asks the lanes port about the session project and appends its fixed reason', async () => {
      const h = await harness();
      const asked: string[] = [];
      const service = h.makeService({
        lanes: {
          available: (lane, projectId) => {
            asked.push(`${lane}:${projectId}`);
            return false;
          },
          reason: (lane, projectId) => (lane === 'code' ? `unmapped for ${projectId}` : undefined),
        },
      });
      const s = await h.newSession('code');
      const result = await service.submit({
        sessionId: s.id,
        submissionKey: nextKey(),
        text: 'Please implement the retry logic.',
      });
      expect(result.action).toBe('refuse');
      expect(result.turn.outcome?.error).toEqual({
        code: 'SANDBOX_UNAVAILABLE',
        message:
          'Engineering changes need the Code lane (WSL2 engineering plane), which is not available yet. (unmapped for proj-1)',
      });
      expect(asked).toContain('code:proj-1');
      expect(asked).toContain('cowork:proj-1');
    });

    it('keeps the router message when there is no reason, or the reason port throws', async () => {
      const h = await harness();
      const s = await h.newSession('code');
      for (const reason of [undefined, () => '', () => undefined]) {
        const service = h.makeService({
          lanes: { available: () => false, ...(reason === undefined ? {} : { reason }) },
        });
        const result = await service.submit({
          sessionId: s.id,
          submissionKey: nextKey(),
          text: 'Please implement the retry logic.',
        });
        expect(result.turn.outcome?.error?.message).toBe(
          'Engineering changes need the Code lane (WSL2 engineering plane), which is not available yet.',
        );
      }
      const throwing = h.makeService({
        lanes: {
          available: () => false,
          reason: () => {
            throw new Error('boom');
          },
        },
      });
      const result = await throwing.submit({
        sessionId: s.id,
        submissionKey: nextKey(),
        text: 'Please implement the retry logic.',
      });
      expect(result.turn.outcome?.error?.message).not.toContain('boom');
    });

    it('applies the reason on a confirmed turn that loses the lane while pending', async () => {
      const h = await harness();
      let codeUp = true;
      const service = h.makeService({
        lanes: {
          available: (lane) => lane === 'code' && codeUp,
          reason: () => 'plane-unreachable',
        },
        executeCode: () => Promise.reject(new Error('must not run')),
      });
      const s = await h.newSession('cowork');
      const submitted = await service.submit({
        sessionId: s.id,
        submissionKey: nextKey(),
        text: 'Implement the missing part.',
      });
      expect(submitted.action).toBe('confirm');
      codeUp = false;
      const turn = await service.confirm({
        sessionId: s.id,
        turnId: submitted.turn.id,
        decision: 'confirm',
      });
      expect(turn.state).toBe('failed');
      expect(turn.outcome?.error?.message).toMatch(/\(plane-unreachable\)$/);
    });
  });

  describe('code lane', () => {
    const engineering = (status: 'committed' | 'not-accepted' | 'failed' | 'cancelled') => ({
      planeTaskId: 'task_9',
      status,
      ...(status === 'committed' ? { branch: 'nexar/task-9', commit: 'a'.repeat(40) } : {}),
      files: 2,
      gatesPassed: 3,
      reviewVerdict: 'approve',
    });

    async function codeHarness(execute?: NonNullable<OperatingPorts['executeCode']>) {
      const h = await harness();
      h.availability.code = true;
      const requests: CodeRequest[] = [];
      const run: NonNullable<OperatingPorts['executeCode']> =
        execute ??
        (async (request) => {
          await request.onTask('task_9');
          request.onProgress('status', 'Engineering step: task.started');
          await request.onApproval(`apr_${'c'.repeat(32)}`);
          return {
            taskId: 'task_9',
            text: 'Committed 2 files',
            engineering: engineering('committed'),
          };
        });
      const service = h.makeService({
        executeCode: (request, signal) => {
          requests.push(request);
          return run(request, signal);
        },
      });
      return { h, service, requests };
    }

    it('runs a coding turn through executeCode and records the engineering outcome', async () => {
      const { h, service, requests } = await codeHarness();
      const s = await h.newSession('code');
      const { turn } = await service.submit({
        sessionId: s.id,
        submissionKey: nextKey(),
        text: 'Please implement the retry logic.',
      });
      await service.whenIdle();

      expect(h.requests).toHaveLength(0); // executeDirect never ran
      expect(requests).toHaveLength(1);
      expect(requests[0]).toMatchObject({
        sessionId: s.id,
        turnId: turn.id,
        projectId: 'proj-1',
        intent: 'coding',
        correlation: { depth: 0, rootSessionId: s.id, turnId: turn.id },
      });
      expect(requests[0]?.goal).toContain('Please implement the retry logic.');
      expect(requests[0]?.goal).toContain('<untrusted-input name="request">');

      const stored = (await h.session(s.id)).turns[0];
      expect(stored).toMatchObject({
        state: 'succeeded',
        lane: { effectiveLane: 'code' },
        tasks: [{ taskId: 'task_9', state: 'succeeded' }],
        approvalIds: [`apr_${'c'.repeat(32)}`],
        context: { policy: 'context@1/code-goal:context' },
        outcome: { text: 'Committed 2 files', engineering: engineering('committed') },
      });
      expect(h.progress).toContain('Engineering step: task.started');
    });

    it('maps review turns to the review intent', async () => {
      const { h, service, requests } = await codeHarness();
      const s = await h.newSession('code');
      await service.submit({
        sessionId: s.id,
        submissionKey: nextKey(),
        text: 'Review the code in this repository.',
      });
      await service.whenIdle();
      expect(requests[0]?.intent).toBe('review');
    });

    it('ends a reported review as succeeded with the report text and its truncation flag', async () => {
      const { h, service } = await codeHarness(async (request) => {
        await request.onTask('task_9');
        return {
          taskId: 'task_9',
          text: '# Report',
          textTruncated: true,
          engineering: {
            planeTaskId: 'task_9',
            status: 'reported' as const,
            lanes: [{ role: 'report', resourceId: 'dsh:deepseek' }],
          },
        };
      });
      const s = await h.newSession('code');
      await service.submit({
        sessionId: s.id,
        submissionKey: nextKey(),
        text: 'Review the code in this repository.',
      });
      await service.whenIdle();
      const stored = (await h.session(s.id)).turns[0];
      expect(stored?.state).toBe('succeeded');
      expect(stored?.tasks[0]?.state).toBe('succeeded');
      expect(stored?.outcome).toMatchObject({
        text: '# Report',
        textTruncated: true,
        engineering: {
          status: 'reported',
          lanes: [{ role: 'report', resourceId: 'dsh:deepseek' }],
        },
      });
      expect(stored?.outcome?.error).toBeUndefined();
    });

    it('never turns a non-engineering turn into an engineering write', async () => {
      const { h, service, requests } = await codeHarness();
      const s = await h.newSession('code');
      await service.submit({
        sessionId: s.id,
        submissionKey: nextKey(),
        text: 'Explain this',
      });
      await service.whenIdle();
      expect(requests).toHaveLength(0);
      expect(h.requests).toHaveLength(1);
    });

    it('refuses an engineering write when no Code executor exists, executing nothing', async () => {
      const h = await harness();
      h.availability.code = true;
      const service = h.makeService({}, false);
      const s = await h.newSession('code');
      const submitted = await service.submit({
        sessionId: s.id,
        submissionKey: nextKey(),
        text: 'Please implement the retry logic.',
      });
      await service.whenIdle();
      expect(submitted.action).toBe('refuse');
      expect((await h.session(s.id)).turns[0]?.outcome?.error?.code).toBe('SANDBOX_UNAVAILABLE');
      expect(h.requests).toHaveLength(0);
    });

    it.each([
      ['not-accepted', 'failed', 'POLICY_REJECTED', 'failed'],
      ['failed', 'failed', 'INTERNAL_ERROR', 'failed'],
      ['cancelled', 'cancelled', undefined, 'cancelled'],
    ] as const)(
      'ends the turn for plane status %s as %s',
      async (status, turnState, errorCode, taskState) => {
        const { h, service } = await codeHarness(async (request) => {
          await request.onTask('task_9');
          return { taskId: 'task_9', text: 'summary', engineering: engineering(status) };
        });
        const s = await h.newSession('code');
        await service.submit({
          sessionId: s.id,
          submissionKey: nextKey(),
          text: 'Please implement the retry logic.',
        });
        await service.whenIdle();
        const stored = (await h.session(s.id)).turns[0];
        expect(stored?.state).toBe(turnState);
        expect(stored?.outcome?.error?.code).toBe(errorCode);
        expect(stored?.outcome?.engineering?.status).toBe(status);
        expect(stored?.tasks[0]?.state).toBe(taskState);
      },
    );

    it('records a plane error code and keeps the linked task failed', async () => {
      const { h, service } = await codeHarness(async (request) => {
        await request.onTask('task_9');
        throw new NexarError('POLICY_REJECTED', 'The request was rejected by plane policy');
      });
      const s = await h.newSession('code');
      await service.submit({
        sessionId: s.id,
        submissionKey: nextKey(),
        text: 'Please implement the retry logic.',
      });
      await service.whenIdle();
      const stored = (await h.session(s.id)).turns[0];
      expect(stored).toMatchObject({
        state: 'failed',
        outcome: {
          error: { code: 'POLICY_REJECTED', message: 'The request was rejected by plane policy' },
        },
        tasks: [{ taskId: 'task_9', state: 'failed' }],
      });
    });

    it('aborts the code run like a direct run on cancel', async () => {
      let seen: AbortSignal | undefined;
      let started!: () => void;
      const startedPromise = new Promise<void>((resolve) => {
        started = resolve;
      });
      const { h, service } = await codeHarness(
        (_request, signal) =>
          new Promise((_resolve, reject) => {
            seen = signal;
            started();
            signal.addEventListener('abort', () =>
              reject(new NexarError('EXECUTION_CANCELLED', 'aborted')),
            );
          }),
      );
      const s = await h.newSession('code');
      const { turn } = await service.submit({
        sessionId: s.id,
        submissionKey: nextKey(),
        text: 'Please implement the retry logic.',
      });
      await startedPromise;
      expect(service.cancel(s.id, turn.id)).toBe(true);
      await service.whenIdle();
      expect(seen?.aborted).toBe(true);
      expect((await h.session(s.id)).turns[0]?.state).toBe('cancelled');
    });

    it('sends only the turn text, and records it, when the context goal is too long', async () => {
      const { h, service, requests } = await codeHarness();
      const s = await h.newSession('code');
      // A long previous turn pushes the rendered context over the plane's goal limit.
      const long = `Implement ${'x'.repeat(19_950)}`;
      await service.submit({ sessionId: s.id, submissionKey: nextKey(), text: long });
      await service.whenIdle();
      expect(requests[0]?.goal.length).toBeGreaterThan(MAX_CODE_GOAL_CHARS - 1_000);
      expect(requests[0]?.goal).toBe(long); // exact text, no wrapper
      const stored = (await h.session(s.id)).turns[0];
      expect(stored?.context).toMatchObject({
        policy: 'context@1/code-goal:request-only',
        chars: long.length,
        turnIds: [],
      });
      expect(stored?.state).toBe('succeeded');
    });

    it('fails with a constant reason when even the turn text exceeds the goal limit', async () => {
      const { h, service, requests } = await codeHarness();
      const s = await h.newSession('code');
      await service.submit({
        sessionId: s.id,
        submissionKey: nextKey(),
        text: `Implement ${'y'.repeat(MAX_CODE_GOAL_CHARS)}`,
      });
      await service.whenIdle();
      expect(requests).toHaveLength(0);
      const stored = (await h.session(s.id)).turns[0];
      expect(stored?.state).toBe('failed');
      expect(stored?.outcome?.error?.code).toBe('VALIDATION_ERROR');
      expect(JSON.stringify(stored?.outcome)).not.toContain('yyyy');
    });

    it('still completes the turn when linking an approval fails', async () => {
      const { h, service } = await codeHarness(async (request) => {
        await request.onTask('task_9');
        await request.onApproval('not-an-approval-id');
        return { taskId: 'task_9', text: 'ok', engineering: engineering('committed') };
      });
      const s = await h.newSession('code');
      await service.submit({
        sessionId: s.id,
        submissionKey: nextKey(),
        text: 'Please implement the retry logic.',
      });
      await service.whenIdle();
      const stored = (await h.session(s.id)).turns[0];
      expect(stored?.state).toBe('succeeded');
      expect(stored?.approvalIds).toEqual([]);
      expect(h.logs.some((l) => l.level === 'warn' && JSON.stringify(l).includes('approval'))).toBe(
        true,
      );
    });

    it('confirming a lane never changes permissions: a confirmed coding turn runs once', async () => {
      const { h, service, requests } = await codeHarness();
      const s = await h.newSession('cowork');
      const submitted = await service.submit({
        sessionId: s.id,
        submissionKey: nextKey(),
        text: 'Implement the missing part.',
      });
      expect(submitted.action).toBe('confirm');
      expect(requests).toHaveLength(0);
      await service.confirm({ sessionId: s.id, turnId: submitted.turn.id, decision: 'confirm' });
      await service.whenIdle();
      expect(requests).toHaveLength(1);
      const session = await h.session(s.id);
      expect(session.mode).toBe('cowork');
      expect(session.turns[0]?.lane).toMatchObject({ confirmed: true, effectiveLane: 'code' });
    });
  });
});
