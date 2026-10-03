import { describe, expect, it } from 'vitest';
import type { ApprovalDto, TurnDto } from '../shared/api.js';
import { PLANE_PROJECT_PATTERN } from '../shared/plane.js';
import {
  MAX_DIFF_LINES,
  approvalState,
  classifyDiffLine,
  clipGoal,
  currentPhase,
  diffLines,
  fallbackText,
  isCodeTurn,
  isRefusedTurn,
  pendingFor,
  shortSha,
} from './code.js';

function turn(overrides: Partial<TurnDto> = {}): TurnDto {
  return {
    id: 'turn_1',
    index: 0,
    text: 'Implement the missing part.',
    state: 'running',
    createdAt: '2026-10-03T00:00:00.000Z',
    updatedAt: '2026-10-03T00:00:00.000Z',
    tasks: [],
    artifacts: [],
    lane: { requestedLane: 'code', effectiveLane: 'code' },
    ...overrides,
  };
}

function planeApproval(overrides: Partial<ApprovalDto> = {}): ApprovalDto {
  return {
    id: 'apr_1',
    status: 'pending',
    createdAt: '',
    expiresAt: '',
    risk: 'medium',
    actionType: 'engineering.commit',
    summary: '',
    fingerprint: '',
    source: 'plane',
    sessionId: 'ses_1',
    turnId: 'turn_1',
    ...overrides,
  };
}

describe('fallbackText', () => {
  it('words the two engineering-lane fallbacks', () => {
    expect(
      fallbackText({
        requestedLane: 'code',
        effectiveLane: 'direct',
        fallbackReason: 'code-report-unavailable',
      }),
    ).toBe(
      'Read-only repository review runs with Nexar direct execution until report-only engineering plans exist.',
    );
    expect(
      fallbackText({
        requestedLane: 'code',
        effectiveLane: 'direct',
        fallbackReason: 'code-engineering-only',
      }),
    ).toBe(
      'Only engineering requests run on the engineering plane; this one ran with Nexar direct execution.',
    );
  });

  it('keeps the orchestrator-unavailable notices and ignores unknown reasons', () => {
    expect(
      fallbackText({
        requestedLane: 'cowork',
        effectiveLane: 'direct',
        fallbackReason: 'orchestrator-unavailable',
      }),
    ).toBe('OpenWorker unavailable. Using Nexar direct execution.');
    expect(
      fallbackText({
        requestedLane: 'code',
        effectiveLane: 'direct',
        fallbackReason: 'orchestrator-unavailable',
      }),
    ).toBe('Code lane (DeepSeek Harness) unavailable. Using Nexar direct execution.');
    expect(
      fallbackText({ requestedLane: 'code', effectiveLane: 'direct', fallbackReason: '<b>x</b>' }),
    ).toBeNull();
    expect(fallbackText({ requestedLane: 'code', effectiveLane: 'code' })).toBeNull();
  });
});

describe('isCodeTurn', () => {
  it('is true for a Code-lane turn or one with an engineering outcome', () => {
    expect(isCodeTurn(turn())).toBe(true);
    expect(
      isCodeTurn(
        turn({
          state: 'succeeded',
          lane: { requestedLane: 'direct', effectiveLane: 'direct' },
          outcome: { engineering: { planeTaskId: 't', status: 'committed' } },
        }),
      ),
    ).toBe(true);
  });

  it('is false for direct, waiting, declined and refused turns', () => {
    expect(isCodeTurn(turn({ lane: { requestedLane: 'code', effectiveLane: 'direct' } }))).toBe(
      false,
    );
    expect(isCodeTurn(turn({ state: 'pending-confirmation' }))).toBe(false);
    expect(isCodeTurn(turn({ state: 'declined' }))).toBe(false);
    const refused = turn({
      state: 'failed',
      outcome: { error: { code: 'SANDBOX_UNAVAILABLE', message: 'no' } },
    });
    expect(isRefusedTurn(refused)).toBe(true);
    expect(isCodeTurn(refused)).toBe(false);
  });
});

describe('approvalState', () => {
  const pending = planeApproval();
  const done = (status: 'committed' | 'not-accepted' | 'failed', approvalId?: string): TurnDto =>
    turn({
      state: status === 'committed' ? 'succeeded' : 'failed',
      outcome: {
        engineering: {
          planeTaskId: 't',
          status,
          ...(approvalId === undefined ? {} : { approvalId }),
        },
      },
    });

  it('reads the pending approval while the turn runs', () => {
    expect(approvalState(turn(), pending, undefined)).toBe('pending');
    expect(approvalState(turn(), undefined, undefined)).toBe('not-requested');
  });

  it('remembers a decision made here until the record catches up', () => {
    expect(approvalState(turn(), pending, 'approved')).toBe('approved');
    expect(approvalState(turn(), undefined, 'denied')).toBe('denied');
  });

  it('derives the state of a finished turn from its outcome', () => {
    expect(approvalState(done('committed', 'apr_1'), undefined, undefined)).toBe('approved');
    expect(approvalState(done('not-accepted', 'apr_1'), undefined, undefined)).toBe('not-approved');
    expect(approvalState(done('not-accepted', 'apr_1'), undefined, 'denied')).toBe('denied');
    expect(approvalState(done('committed'), undefined, undefined)).toBe('not-required');
  });
});

describe('pendingFor', () => {
  it('matches plane approvals of the same session and turn only', () => {
    const list = [
      planeApproval({ id: 'apr_a', turnId: 'turn_2' }),
      planeApproval({ id: 'apr_b', sessionId: 'ses_2' }),
      planeApproval({ id: 'apr_c', status: 'approved' }),
      planeApproval({ id: 'apr_e' }),
    ];
    expect(pendingFor(list, 'ses_1', 'turn_1')?.id).toBe('apr_e');
    expect(pendingFor(list, 'ses_9', 'turn_1')).toBeUndefined();
    const own: ApprovalDto = {
      id: 'apr_own',
      status: 'pending',
      createdAt: '',
      expiresAt: '',
      risk: 'low',
      actionType: 'x',
      summary: '',
      fingerprint: '',
      sessionId: 'ses_1',
      turnId: 'turn_1',
    };
    expect(pendingFor([own], 'ses_1', 'turn_1')).toBeUndefined();
  });
});

describe('text helpers', () => {
  it('shortens commits and goals and shows the last progress line of a running turn', () => {
    expect(shortSha('c'.repeat(40))).toBe('c'.repeat(12));
    expect(clipGoal('a\n\n b')).toBe('a b');
    expect(clipGoal('x'.repeat(500))).toHaveLength(241);
    expect(currentPhase(turn(), ['one', 'two'])).toBe('two');
    expect(currentPhase(turn({ state: 'succeeded' }), ['one'])).toBeUndefined();
    expect(currentPhase(turn(), [])).toBeUndefined();
  });

  it('validates plane project ids like the main process', () => {
    expect(PLANE_PROJECT_PATTERN.test('plane-proj')).toBe(true);
    expect(PLANE_PROJECT_PATTERN.test('C:\\repo')).toBe(false);
    expect(PLANE_PROJECT_PATTERN.test('../x')).toBe(false);
    expect(PLANE_PROJECT_PATTERN.test('')).toBe(false);
  });
});

describe('diffLines', () => {
  it('classifies lines by their first characters', () => {
    expect(classifyDiffLine('@@ -1 +1 @@')).toBe('hunk');
    expect(classifyDiffLine('+++ b/a.txt')).toBe('meta');
    expect(classifyDiffLine('--- a/a.txt')).toBe('meta');
    expect(classifyDiffLine('diff --git a/a b/a')).toBe('meta');
    expect(classifyDiffLine('+new')).toBe('add');
    expect(classifyDiffLine('-old')).toBe('del');
    expect(classifyDiffLine(' same')).toBe('ctx');
  });

  it('keeps markup as text and drops the empty tail', () => {
    const view = diffLines({ text: '+<img src=x onerror=alert(1)>\n-old\n' });
    expect(view.lines).toEqual([
      { kind: 'add', text: '+<img src=x onerror=alert(1)>' },
      { kind: 'del', text: '-old' },
    ]);
    expect(view.clipped).toBe(false);
  });

  it('bounds the number of rendered lines', () => {
    const view = diffLines({ text: '+x\n'.repeat(MAX_DIFF_LINES + 5) });
    expect(view.lines).toHaveLength(MAX_DIFF_LINES);
    expect(view.clipped).toBe(true);
  });
});
