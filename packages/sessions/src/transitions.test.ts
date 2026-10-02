import { NexarError } from '@nexar/contracts';
import { describe, expect, it } from 'vitest';
import { MAX_OUTCOME_CHARS, MAX_TURNS } from './limits.js';
import {
  beginTurn,
  completeTurn,
  createSession,
  interruptRunning,
  linkApprovals,
  linkArtifacts,
  linkTask,
  rename,
  resolveConfirmation,
  setContext,
  setMode,
  updateTask,
} from './transitions.js';
import type { LaneDecision, OperatingSession } from './types.js';

const SID = `ses_${'a'.repeat(32)}`;
const T1 = `turn_${'1'.repeat(32)}`;
const T2 = `turn_${'2'.repeat(32)}`;
const K1 = 'key-0000000000001';
const K2 = 'key-0000000000002';
const T0 = '2026-10-02T10:00:00.000Z';
const T_1 = '2026-10-02T10:00:01.000Z';
const T_2 = '2026-10-02T10:00:02.000Z';
const APR = `apr_${'b'.repeat(32)}`;

const lane: LaneDecision = {
  policy: 'lanes@1',
  mode: 'cowork',
  requestedLane: 'code',
  effectiveLane: 'code',
  mismatch: { from: 'cowork', to: 'code' },
};

function fresh(): OperatingSession {
  return createSession({ id: SID, projectId: 'demo', mode: 'cowork', title: ' Plan ', now: T0 });
}

function running(): OperatingSession {
  return beginTurn(fresh(), { turnId: T1, submissionKey: K1, text: 'hello', now: T_1 }).session;
}

function expectNexar(fn: () => unknown, code: string, reason?: string): NexarError {
  try {
    fn();
  } catch (e) {
    expect(e).toBeInstanceOf(NexarError);
    const error = e as NexarError;
    expect(error.code).toBe(code);
    if (reason !== undefined) expect(error.details?.reason).toBe(reason);
    return error;
  }
  throw new Error('expected a throw');
}

describe('createSession', () => {
  it('builds revision 1 with a trimmed title and no active turn', () => {
    expect(fresh()).toEqual({
      schemaVersion: 1,
      id: SID,
      projectId: 'demo',
      mode: 'cowork',
      title: 'Plan',
      createdAt: T0,
      updatedAt: T0,
      revision: 1,
      activeTurnId: null,
      turns: [],
    });
  });

  it('rejects bad ids, modes and titles', () => {
    const base = { id: SID, projectId: 'demo', mode: 'cowork', title: 't', now: T0 } as const;
    expectNexar(() => createSession({ ...base, id: 'nope' }), 'VALIDATION_ERROR');
    expectNexar(() => createSession({ ...base, projectId: '../x' }), 'VALIDATION_ERROR');
    expectNexar(() => createSession({ ...base, mode: 'x' as 'code' }), 'VALIDATION_ERROR');
    expectNexar(() => createSession({ ...base, title: '   ' }), 'VALIDATION_ERROR');
    expectNexar(() => createSession({ ...base, title: 'x'.repeat(201) }), 'VALIDATION_ERROR');
  });
});

describe('beginTurn', () => {
  it('starts a running turn, sets the active turn and bumps the revision', () => {
    const { session, turn, created } = beginTurn(fresh(), {
      turnId: T1,
      submissionKey: K1,
      text: 'hello',
      now: T_1,
    });
    expect(created).toBe(true);
    expect(turn).toMatchObject({ id: T1, index: 0, state: 'running', text: 'hello', tasks: [] });
    expect(session).toMatchObject({ revision: 2, updatedAt: T_1, activeTurnId: T1 });
    expect(session.turns).toEqual([turn]);
  });

  it('is idempotent for the same key and text, and changes nothing', () => {
    const first = running();
    const again = beginTurn(first, {
      turnId: T2,
      submissionKey: K1,
      text: 'hello',
      now: T_2,
    });
    expect(again.created).toBe(false);
    expect(again.session).toBe(first);
    expect(again.turn.id).toBe(T1);
  });

  it('stays idempotent after the first turn finished', () => {
    const done = completeTurn(running(), T1, { state: 'succeeded' }, T_2).session;
    const again = beginTurn(done, { turnId: T2, submissionKey: K1, text: 'hello', now: T_2 });
    expect(again.created).toBe(false);
    expect(again.session).toBe(done);
  });

  it('rejects the same key with different text', () => {
    expectNexar(
      () => beginTurn(running(), { turnId: T2, submissionKey: K1, text: 'other', now: T_2 }),
      'VALIDATION_ERROR',
      'submission-key-reused',
    );
  });

  it('refuses a second foreground turn with session-busy details', () => {
    const error = expectNexar(
      () => beginTurn(running(), { turnId: T2, submissionKey: K2, text: 'more', now: T_2 }),
      'CONFLICT',
      'session-busy',
    );
    expect(error.details).toEqual({ reason: 'session-busy', activeTurnId: T1 });
  });

  it('refuses a full session', () => {
    let session = fresh();
    for (let i = 0; i < MAX_TURNS; i += 1) {
      const hex = i.toString(16).padStart(32, '0');
      session = beginTurn(session, {
        turnId: `turn_${hex}`,
        submissionKey: `key-${hex}`.slice(0, 40),
        text: 't',
        now: T_1,
      }).session;
      session = completeTurn(session, `turn_${hex}`, { state: 'succeeded' }, T_1).session;
    }
    expectNexar(
      () =>
        beginTurn(session, {
          turnId: T2,
          submissionKey: K2,
          text: 'x',
          now: T_2,
        }),
      'POLICY_REJECTED',
      'session-full',
    );
  });

  it('can start pending-confirmation only with a lane decision', () => {
    expectNexar(
      () =>
        beginTurn(fresh(), {
          turnId: T1,
          submissionKey: K1,
          text: 'x',
          now: T_1,
          state: 'pending-confirmation',
        }),
      'VALIDATION_ERROR',
      'lane-required',
    );
    const { turn, session } = beginTurn(fresh(), {
      turnId: T1,
      submissionKey: K1,
      text: 'x',
      now: T_1,
      state: 'pending-confirmation',
      lane,
    });
    expect(turn.state).toBe('pending-confirmation');
    expect(session.activeTurnId).toBe(T1);
  });

  it('validates ids, keys and text', () => {
    const base = { turnId: T1, submissionKey: K1, text: 'x', now: T_1 };
    expectNexar(() => beginTurn(fresh(), { ...base, turnId: 'x' }), 'VALIDATION_ERROR');
    expectNexar(() => beginTurn(fresh(), { ...base, submissionKey: 'short' }), 'VALIDATION_ERROR');
    expectNexar(() => beginTurn(fresh(), { ...base, text: '  ' }), 'VALIDATION_ERROR');
    expectNexar(
      () => beginTurn(fresh(), { ...base, text: 'x'.repeat(100_001) }),
      'VALIDATION_ERROR',
    );
  });
});

describe('resolveConfirmation', () => {
  function pending(): OperatingSession {
    return beginTurn(fresh(), {
      turnId: T1,
      submissionKey: K1,
      text: 'x',
      now: T_1,
      state: 'pending-confirmation',
      lane,
    }).session;
  }

  it('confirm runs the turn, marks the lane confirmed and may pick the effective lane', () => {
    const { session, turn } = resolveConfirmation(
      pending(),
      T1,
      { decision: 'confirm', effectiveLane: 'direct' },
      T_2,
    );
    expect(turn.state).toBe('running');
    expect(turn.lane).toMatchObject({ confirmed: true, effectiveLane: 'direct' });
    expect(session.activeTurnId).toBe(T1);
    expect(session.revision).toBe(3);
  });

  it('confirm keeps the effective lane when none is given', () => {
    const { turn } = resolveConfirmation(pending(), T1, { decision: 'confirm' }, T_2);
    expect(turn.lane?.effectiveLane).toBe('code');
  });

  it('confirm sets, clears or keeps the fallback reason', () => {
    const set = resolveConfirmation(
      pending(),
      T1,
      { decision: 'confirm', effectiveLane: 'direct', fallbackReason: 'orchestrator-unavailable' },
      T_2,
    );
    expect(set.turn.lane?.fallbackReason).toBe('orchestrator-unavailable');
    const stale = beginTurn(fresh(), {
      turnId: T1,
      submissionKey: K1,
      text: 'x',
      now: T_1,
      state: 'pending-confirmation',
      lane: { ...lane, fallbackReason: 'orchestrator-unavailable' },
    }).session;
    const cleared = resolveConfirmation(
      stale,
      T1,
      { decision: 'confirm', fallbackReason: null },
      T_2,
    );
    expect(cleared.turn.lane).not.toHaveProperty('fallbackReason');
    const kept = resolveConfirmation(stale, T1, { decision: 'confirm' }, T_2);
    expect(kept.turn.lane?.fallbackReason).toBe('orchestrator-unavailable');
  });

  it('decline ends the turn as declined and frees the session', () => {
    const { session, turn } = resolveConfirmation(pending(), T1, { decision: 'decline' }, T_2);
    expect(turn.state).toBe('declined');
    expect(session.activeTurnId).toBeNull();
  });

  it('refuses a turn that is not pending and finished turns', () => {
    expectNexar(
      () => resolveConfirmation(running(), T1, { decision: 'confirm' }, T_2),
      'CONFLICT',
      'not-pending-confirmation',
    );
    const declined = resolveConfirmation(pending(), T1, { decision: 'decline' }, T_2).session;
    expectNexar(
      () => resolveConfirmation(declined, T1, { decision: 'confirm' }, T_2),
      'CONFLICT',
      'turn-finished',
    );
  });
});

describe('task, artifact, approval and context links', () => {
  it('links and updates tasks', () => {
    const linked = linkTask(running(), T1, { taskId: 'task-1', state: 'running' }, T_2);
    expect(linked.turn.tasks).toEqual([{ taskId: 'task-1', state: 'running' }]);
    expect(linked.session.revision).toBe(3);
    const updated = updateTask(
      linked.session,
      T1,
      'task-1',
      { state: 'succeeded', resourceId: 'res', fallback: false },
      T_2,
    );
    expect(updated.turn.tasks).toEqual([
      { taskId: 'task-1', state: 'succeeded', resourceId: 'res', fallback: false },
    ]);
  });

  it('rejects duplicate, unknown and excess tasks', () => {
    const linked = linkTask(running(), T1, { taskId: 'task-1', state: 'running' }, T_2).session;
    expectNexar(
      () => linkTask(linked, T1, { taskId: 'task-1', state: 'running' }, T_2),
      'VALIDATION_ERROR',
      'duplicate-task',
    );
    expectNexar(() => updateTask(linked, T1, 'nope', {}, T_2), 'VALIDATION_ERROR', 'unknown-task');
    let session = running();
    for (let i = 0; i < 32; i += 1) {
      session = linkTask(session, T1, { taskId: `t${String(i)}`, state: 'running' }, T_2).session;
    }
    expectNexar(
      () => linkTask(session, T1, { taskId: 'extra', state: 'running' }, T_2),
      'POLICY_REJECTED',
      'too-many-tasks',
    );
  });

  it('dedupes artifacts by uri and approvals by id', () => {
    const a = { uri: 'nexar-artifact://t/a.md', label: 'A' };
    const once = linkArtifacts(running(), T1, [a, a], T_2);
    const twice = linkArtifacts(once.session, T1, [a, { uri: 'nexar-artifact://t/b.md' }], T_2);
    expect(twice.turn.artifacts.map((x) => x.uri)).toEqual([
      'nexar-artifact://t/a.md',
      'nexar-artifact://t/b.md',
    ]);
    const approvals = linkApprovals(
      linkApprovals(running(), T1, [APR, APR], T_2).session,
      T1,
      [APR],
      T_2,
    );
    expect(approvals.turn.approvalIds).toEqual([APR]);
    expectNexar(() => linkApprovals(running(), T1, ['nope'], T_2), 'VALIDATION_ERROR');
  });

  it('bounds artifacts and approvals per turn', () => {
    const many = Array.from({ length: 65 }, (_, i) => ({ uri: `nexar-artifact://t/${String(i)}` }));
    expectNexar(
      () => linkArtifacts(running(), T1, many, T_2),
      'POLICY_REJECTED',
      'too-many-artifacts',
    );
    const ids = Array.from({ length: 33 }, (_, i) => `apr_${i.toString(16).padStart(32, '0')}`);
    expectNexar(
      () => linkApprovals(running(), T1, ids, T_2),
      'POLICY_REJECTED',
      'too-many-approvals',
    );
  });

  it('stores the context manifest', () => {
    const context = {
      policy: 'context@1',
      turnIds: [],
      omittedTurns: 0,
      truncatedTurnIds: [],
      chars: 10,
      artifactIds: [],
      hash: 'abc',
    };
    expect(setContext(running(), T1, context, T_2).turn.context).toEqual(context);
  });

  it('works on a pending-confirmation turn too (not yet terminal)', () => {
    const pending = beginTurn(fresh(), {
      turnId: T1,
      submissionKey: K1,
      text: 'x',
      now: T_1,
      state: 'pending-confirmation',
      lane,
    }).session;
    expect(linkApprovals(pending, T1, [APR], T_2).turn.approvalIds).toEqual([APR]);
  });
});

describe('completeTurn', () => {
  it.each(['succeeded', 'failed', 'cancelled'] as const)('ends the turn as %s', (state) => {
    const { session, turn } = completeTurn(
      running(),
      T1,
      { state, outcome: { text: 'done' } },
      T_2,
    );
    expect(turn).toMatchObject({ state, outcome: { text: 'done' }, updatedAt: T_2 });
    expect(session.activeTurnId).toBeNull();
    expect(session.revision).toBe(3);
  });

  it('truncates long output and flags it', () => {
    const { turn } = completeTurn(
      running(),
      T1,
      { state: 'succeeded', outcome: { text: 'x'.repeat(MAX_OUTCOME_CHARS + 50) } },
      T_2,
    );
    expect(turn.outcome?.text).toHaveLength(MAX_OUTCOME_CHARS);
    expect(turn.outcome?.textTruncated).toBe(true);
  });

  it('does not split a surrogate pair when truncating', () => {
    const text = `${'x'.repeat(MAX_OUTCOME_CHARS - 1)}\u{1F600}`;
    const { turn } = completeTurn(running(), T1, { state: 'succeeded', outcome: { text } }, T_2);
    expect(turn.outcome?.text).toHaveLength(MAX_OUTCOME_CHARS - 1);
  });

  it('bounds the error message', () => {
    const { turn } = completeTurn(
      running(),
      T1,
      {
        state: 'failed',
        outcome: { error: { code: 'PROVIDER_ERROR', message: 'm'.repeat(5000) } },
      },
      T_2,
    );
    expect(turn.outcome?.error?.message).toHaveLength(2000);
  });

  it('refuses pending-confirmation turns and invalid states', () => {
    const pending = beginTurn(fresh(), {
      turnId: T1,
      submissionKey: K1,
      text: 'x',
      now: T_1,
      state: 'pending-confirmation',
      lane,
    }).session;
    expectNexar(
      () => completeTurn(pending, T1, { state: 'cancelled' }, T_2),
      'CONFLICT',
      'turn-not-running',
    );
    expectNexar(
      () => completeTurn(running(), T1, { state: 'running' as 'failed' }, T_2),
      'VALIDATION_ERROR',
    );
  });
});

describe('terminal immutability', () => {
  const mutations: readonly [string, (s: OperatingSession) => unknown][] = [
    ['completeTurn', (s) => completeTurn(s, T1, { state: 'failed' }, T_2)],
    ['linkTask', (s) => linkTask(s, T1, { taskId: 'x', state: 'running' }, T_2)],
    ['updateTask', (s) => updateTask(s, T1, 'x', { state: 'failed' }, T_2)],
    ['linkArtifacts', (s) => linkArtifacts(s, T1, [{ uri: 'u' }], T_2)],
    ['linkApprovals', (s) => linkApprovals(s, T1, [APR], T_2)],
    ['setContext', (s) => setContext(s, T1, { policy: 'p' } as never, T_2)],
    ['resolveConfirmation', (s) => resolveConfirmation(s, T1, { decision: 'confirm' }, T_2)],
  ];

  it.each(['succeeded', 'failed', 'cancelled'] as const)(
    'refuses every mutation of a %s turn',
    (state) => {
      const done = completeTurn(running(), T1, { state }, T_2).session;
      for (const [, mutate] of mutations) {
        expectNexar(() => mutate(done), 'CONFLICT', 'turn-finished');
      }
    },
  );

  it('refuses every mutation of interrupted and declined turns', () => {
    const interrupted = interruptRunning(running(), T_2).session;
    const declined = resolveConfirmation(
      beginTurn(fresh(), {
        turnId: T1,
        submissionKey: K1,
        text: 'x',
        now: T_1,
        state: 'pending-confirmation',
        lane,
      }).session,
      T1,
      { decision: 'decline' },
      T_2,
    ).session;
    for (const session of [interrupted, declined]) {
      for (const [, mutate] of mutations) {
        expectNexar(() => mutate(session), 'CONFLICT', 'turn-finished');
      }
    }
  });

  it('rejects unknown and malformed turn ids', () => {
    expectNexar(
      () => completeTurn(running(), T2, { state: 'failed' }, T_2),
      'VALIDATION_ERROR',
      'unknown-turn',
    );
    expectNexar(() => completeTurn(running(), 'bad', { state: 'failed' }, T_2), 'VALIDATION_ERROR');
  });
});

describe('interruptRunning', () => {
  it('interrupts running turns, clears the active turn and bumps the revision', () => {
    const { session, interrupted } = interruptRunning(running(), T_2);
    expect(interrupted).toBe(1);
    expect(session.turns[0]?.state).toBe('interrupted');
    expect(session).toMatchObject({ activeTurnId: null, revision: 3, updatedAt: T_2 });
  });

  it('keeps pending-confirmation turns and the active turn', () => {
    const pending = beginTurn(fresh(), {
      turnId: T1,
      submissionKey: K1,
      text: 'x',
      now: T_1,
      state: 'pending-confirmation',
      lane,
    }).session;
    const result = interruptRunning(pending, T_2);
    expect(result.interrupted).toBe(0);
    expect(result.session).toBe(pending);
    expect(result.session.activeTurnId).toBe(T1);
  });

  it('leaves finished sessions untouched', () => {
    const done = completeTurn(running(), T1, { state: 'succeeded' }, T_2).session;
    expect(interruptRunning(done, T_2)).toEqual({ session: done, interrupted: 0 });
  });

  it('changes nothing else on the interrupted turn', () => {
    const before = running();
    const after = interruptRunning(before, T_2).session;
    expect({ ...after.turns[0], state: 'running', updatedAt: T_1 }).toEqual(before.turns[0]);
  });
});

describe('setMode and rename', () => {
  it('records modeChangedAt and applies to the next turn only', () => {
    const base = running();
    const changed = setMode(base, 'code', T_2);
    expect(changed).toMatchObject({ mode: 'code', modeChangedAt: T_2, revision: 3 });
    expect(changed.turns[0]?.state).toBe('running');
    expect(changed.turns[0]?.lane).toBeUndefined();
  });

  it('is a no-op for the same mode and rejects an invalid mode', () => {
    const base = fresh();
    expect(setMode(base, 'cowork', T_2)).toBe(base);
    expectNexar(() => setMode(base, 'x' as 'code', T_2), 'VALIDATION_ERROR');
  });

  it('renames with validation', () => {
    expect(rename(fresh(), '  New  ', T_2)).toMatchObject({ title: 'New', revision: 2 });
    expectNexar(() => rename(fresh(), '', T_2), 'VALIDATION_ERROR');
  });

  it('never changes the project id (no API exists)', () => {
    let session = running();
    session = setMode(session, 'code', T_2);
    session = rename(session, 'x', T_2);
    session = completeTurn(session, T1, { state: 'succeeded' }, T_2).session;
    expect(session.projectId).toBe('demo');
  });
});
