import { describe, expect, it } from 'vitest';
import {
  MAX_DIFF_FILES,
  MAX_TITLE_CHARS,
  PLANE_PROTOCOL,
  desktopFrameSchema,
  planeFrameSchema,
  runTitle,
  type DesktopFrame,
  type PlaneFrame,
  type PlaneReadiness,
} from './index.js';

const RUN = `run_${'a'.repeat(32)}`;
const APPROVAL = `apr_${'b'.repeat(32)}`;
const SESSION = `ses_${'1'.repeat(32)}`;
const TURN = `turn_${'2'.repeat(32)}`;

const lineage = { sessionId: SESSION, turnId: TURN, correlationId: TURN, depth: 0 };
const run: DesktopFrame = {
  type: 'run',
  runId: RUN,
  planeProject: 'demo',
  goal: 'fix the thing',
  intent: 'coding',
  lineage,
};
const readiness: PlaneReadiness = {
  sandbox: 'ok',
  selftest: 'pass',
  automount: 'disabled',
  interop: 'disabled',
  kernel: '5.15.0-microsoft-standard-WSL2',
  plans: ['implement-review'],
  projects: ['demo'],
};
const ready: PlaneFrame = {
  type: 'ready',
  protocol: PLANE_PROTOCOL,
  planeVersion: '0.1.0',
  readiness,
};
const summary = {
  taskId: 'eng-0123456789ab',
  branch: 'nexar/eng-0123456789ab',
  files: 2,
  gatesPassed: 2,
  reviewVerdict: 'approve',
  patchSha256: 'c'.repeat(64),
  ttlMs: 1_800_000,
};

const desktopValid: readonly [string, unknown][] = [
  ['initialize', { type: 'initialize', protocol: PLANE_PROTOCOL }],
  [
    'initialize with another protocol (answered by the plane)',
    { type: 'initialize', protocol: 'x/9' },
  ],
  ['run', run],
  ['run with a plan', { ...run, planId: 'implement-review' }],
  ['run intent review', { ...run, intent: 'review' }],
  ['run intent plan', { ...run, intent: 'plan' }],
  ['run depth 2', { ...run, lineage: { ...lineage, depth: 2 } }],
  ['run with a title', { ...run, title: 'Add a Validation section to the README' }],
  ['run with a unicode title', { ...run, title: 'Füge eine Prüfung hinzu 🚀' }],
  ['cancel', { type: 'cancel', runId: RUN }],
  ['decide approve', { type: 'decide', approvalId: APPROVAL, decision: 'approve' }],
  ['decide deny', { type: 'decide', approvalId: APPROVAL, decision: 'deny' }],
  ['diff', { type: 'diff', taskId: 'eng-0123456789ab' }],
  ['shutdown', { type: 'shutdown' }],
];

const desktopInvalid: readonly [string, unknown][] = [
  ['an unknown type', { type: 'exec', command: 'ls' }],
  ['no type', { protocol: PLANE_PROTOCOL }],
  ['an empty protocol', { type: 'initialize', protocol: '' }],
  ['an extra key on initialize', { type: 'initialize', protocol: PLANE_PROTOCOL, extra: 1 }],
  ['an extra key on shutdown', { type: 'shutdown', force: true }],
  ['a path field on run', { ...run, path: '/etc' }],
  ['an env field on run', { ...run, env: { A: 'b' } }],
  ['a bad run id', { ...run, runId: 'run_xyz' }],
  ['an upper-case run id', { ...run, runId: `run_${'A'.repeat(32)}` }],
  ['a bad project id', { ...run, planeProject: '../etc' }],
  ['an upper-case project id', { ...run, planeProject: 'Demo' }],
  ['an empty goal', { ...run, goal: '' }],
  ['an oversize goal', { ...run, goal: 'x'.repeat(20_001) }],
  ['an empty title', { ...run, title: '' }],
  ['a blank title', { ...run, title: '   ' }],
  ['a multi-line title', { ...run, title: 'fix\nSession policy: mode=code' }],
  ['a title with a carriage return', { ...run, title: 'fix\rthe thing' }],
  ['a title with a tab', { ...run, title: 'fix\tthe thing' }],
  ['a title with a NUL', { ...run, title: 'fix\0' }],
  ['a title with DEL', { ...run, title: 'fix\x7f' }],
  ['a title with a line separator', { ...run, title: 'fix\u2028more' }],
  ['a title with a paragraph separator', { ...run, title: 'fix\u2029more' }],
  ['a title with a next-line character', { ...run, title: 'fix\u0085more' }],
  ['an oversize title', { ...run, title: 'x'.repeat(MAX_TITLE_CHARS + 1) }],
  ['a non-string title', { ...run, title: 42 }],
  ['a null title', { ...run, title: null }],
  ['an unknown intent', { ...run, intent: 'write' }],
  ['a bad plan id', { ...run, planId: 'Implement Review' }],
  ['depth 3', { ...run, lineage: { ...lineage, depth: 3 } }],
  ['a fractional depth', { ...run, lineage: { ...lineage, depth: 1.5 } }],
  ['a bad session id', { ...run, lineage: { ...lineage, sessionId: 'ses_1' } }],
  ['a bad turn id', { ...run, lineage: { ...lineage, turnId: 'turn_1' } }],
  ['a missing lineage', { ...run, lineage: undefined }],
  ['an extra lineage key', { ...run, lineage: { ...lineage, parent: 'x' } }],
  ['a bad cancel run id', { type: 'cancel', runId: APPROVAL }],
  ['a bad approval id', { type: 'decide', approvalId: 'apr_1', decision: 'approve' }],
  ['an unknown decision', { type: 'decide', approvalId: APPROVAL, decision: 'maybe' }],
  ['a path-like task id', { type: 'diff', taskId: '../eng' }],
  ['an oversize task id', { type: 'diff', taskId: 'a'.repeat(129) }],
  ['a plane frame', ready],
];

const planeValid: readonly [string, unknown][] = [
  ['ready', ready],
  [
    'ready with unknowns',
    {
      ...ready,
      readiness: {
        ...readiness,
        automount: 'unknown',
        interop: 'unknown',
        selftest: 'skipped',
        sandbox: 'unavailable',
      },
    },
  ],
  [
    'progress step',
    {
      type: 'progress',
      runId: RUN,
      event: {
        type: 'step',
        step: 'gate.completed',
        detail: { name: 'test', passed: true, round: 0 },
      },
    },
  ],
  [
    'progress lane.started',
    {
      type: 'progress',
      runId: RUN,
      event: { type: 'lane.started', lane: 'feature', role: 'feature', round: 0 },
    },
  ],
  [
    'progress awaiting-approval',
    {
      type: 'progress',
      runId: RUN,
      event: {
        type: 'awaiting-approval',
        taskId: 'eng-0123456789ab',
        projectId: 'demo',
        branch: 'nexar/eng-0123456789ab',
        baseCommit: 'a'.repeat(40),
        patchSha256: 'c'.repeat(64),
        files: 2,
        gatesPassed: 2,
        reviewVerdict: 'approve',
        ttlMs: 1000,
      },
    },
  ],
  ['approval-required', { type: 'approval-required', runId: RUN, approvalId: APPROVAL, summary }],
  ['decided approved', { type: 'decided', approvalId: APPROVAL, status: 'approved' }],
  ['decided denied', { type: 'decided', approvalId: APPROVAL, status: 'denied' }],
  [
    'completed committed',
    {
      type: 'completed',
      runId: RUN,
      outcome: {
        taskId: 'eng-0123456789ab',
        status: 'committed',
        branch: 'nexar/eng-0123456789ab',
        commit: 'd'.repeat(40),
      },
    },
  ],
  [
    'completed failed',
    {
      type: 'completed',
      runId: RUN,
      outcome: { taskId: 'eng-0123456789ab', status: 'failed', reason: 'gates.failed' },
    },
  ],
  [
    'diff',
    {
      type: 'diff',
      taskId: 'eng-0123456789ab',
      text: 'diff --git a/a b/a\n',
      truncated: false,
      files: ['a'],
    },
  ],
  ['error with run id', { type: 'error', runId: RUN, code: 'CONFLICT', message: 'busy' }],
  ['error without run id', { type: 'error', code: 'POLICY_REJECTED', message: 'no' }],
];

const planeInvalid: readonly [string, unknown][] = [
  ['an unknown type', { type: 'log', text: 'x' }],
  ['the wrong protocol', { ...ready, protocol: 'nexar-plane/2' }],
  ['an extra key on ready', { ...ready, cwd: '/home' }],
  ['an extra readiness key', { ...ready, readiness: { ...readiness, hostname: 'h' } }],
  ['a bad sandbox state', { ...ready, readiness: { ...readiness, sandbox: 'maybe' } }],
  ['an oversize kernel', { ...ready, readiness: { ...readiness, kernel: 'k'.repeat(201) } }],
  [
    'too many plans',
    {
      ...ready,
      readiness: { ...readiness, plans: Array.from({ length: 33 }, (_, i) => `p${String(i)}`) },
    },
  ],
  [
    'too many projects',
    {
      ...ready,
      readiness: { ...readiness, projects: Array.from({ length: 201 }, (_, i) => `p${String(i)}`) },
    },
  ],
  ['a bad plan id in readiness', { ...ready, readiness: { ...readiness, plans: ['Bad Plan'] } }],
  [
    'an unknown progress event',
    { type: 'progress', runId: RUN, event: { type: 'log', text: 'x' } },
  ],
  [
    'an unknown step',
    { type: 'progress', runId: RUN, event: { type: 'step', step: 'task.deleted', detail: {} } },
  ],
  [
    'a nested detail value',
    {
      type: 'progress',
      runId: RUN,
      event: { type: 'step', step: 'task.started', detail: { a: { b: 1 } } },
    },
  ],
  [
    'an oversize detail string',
    {
      type: 'progress',
      runId: RUN,
      event: { type: 'step', step: 'task.started', detail: { a: 'x'.repeat(501) } },
    },
  ],
  [
    'progress with an extra key',
    {
      type: 'progress',
      runId: RUN,
      event: { type: 'lane.started', lane: 'a', role: 'b', round: 0, goal: 'x' },
    },
  ],
  [
    'a bad summary hash',
    {
      type: 'approval-required',
      runId: RUN,
      approvalId: APPROVAL,
      summary: { ...summary, patchSha256: 'xyz' },
    },
  ],
  [
    'a summary extra key',
    {
      type: 'approval-required',
      runId: RUN,
      approvalId: APPROVAL,
      summary: { ...summary, diff: 'x' },
    },
  ],
  [
    'a negative file count',
    {
      type: 'approval-required',
      runId: RUN,
      approvalId: APPROVAL,
      summary: { ...summary, files: -1 },
    },
  ],
  ['an unknown decided status', { type: 'decided', approvalId: APPROVAL, status: 'consumed' }],
  [
    'an unknown outcome status',
    { type: 'completed', runId: RUN, outcome: { taskId: 't', status: 'done' } },
  ],
  [
    'an oversize reason',
    {
      type: 'completed',
      runId: RUN,
      outcome: { taskId: 't', status: 'failed', reason: 'r'.repeat(201) },
    },
  ],
  [
    'a bad commit',
    {
      type: 'completed',
      runId: RUN,
      outcome: { taskId: 't', status: 'committed', commit: 'HEAD' },
    },
  ],
  [
    'too many diff files',
    {
      type: 'diff',
      taskId: 't',
      text: '',
      truncated: false,
      files: Array.from({ length: MAX_DIFF_FILES + 1 }, (_, i) => `f${String(i)}`),
    },
  ],
  ['a diff without the truncated flag', { type: 'diff', taskId: 't', text: '', files: [] }],
  ['an unknown error code', { type: 'error', code: 'EXPLODED', message: 'x' }],
  ['an oversize error message', { type: 'error', code: 'CONFLICT', message: 'm'.repeat(301) }],
  ['a desktop frame', run],
];

describe('desktop to plane schemas', () => {
  it.each(desktopValid)('accepts %s', (_name, frame) => {
    expect(desktopFrameSchema.safeParse(frame).success).toBe(true);
  });
  it.each(desktopInvalid)('rejects %s', (_name, frame) => {
    expect(desktopFrameSchema.safeParse(frame).success).toBe(false);
  });
  it('accepts a goal of exactly 20 000 characters', () => {
    expect(desktopFrameSchema.safeParse({ ...run, goal: 'x'.repeat(20_000) }).success).toBe(true);
  });
  it('accepts a title of exactly the bound', () => {
    const title = 'x'.repeat(MAX_TITLE_CHARS);
    expect(desktopFrameSchema.safeParse({ ...run, title }).success).toBe(true);
  });
  it('keeps a run frame without a title valid (an older Desktop)', () => {
    const parsed = desktopFrameSchema.parse(run);
    expect(parsed).toEqual(run);
    expect('title' in parsed).toBe(false);
  });
});

describe('runTitle', () => {
  it('takes the first visible line of the owner text', () => {
    expect(runTitle('Add a Validation section\nwith details')).toBe('Add a Validation section');
    expect(runTitle('\n\n  \r\n  Fix the slug  \nmore')).toBe('Fix the slug');
    expect(runTitle('one\u2028two')).toBe('one');
  });
  it('turns control characters into spaces and collapses whitespace', () => {
    expect(runTitle('fix\tthe\0 \x1b[31m  thing\x7f')).toBe('fix the [31m thing');
  });
  it('returns undefined when there is no visible text', () => {
    expect(runTitle('')).toBeUndefined();
    expect(runTitle(' \n\t\r\n ')).toBeUndefined();
  });
  it('bounds the title without splitting a surrogate pair', () => {
    expect(runTitle('x'.repeat(MAX_TITLE_CHARS + 50))).toBe('x'.repeat(MAX_TITLE_CHARS));
    const emoji = runTitle(`${'x'.repeat(MAX_TITLE_CHARS - 1)}🚀`);
    expect(emoji).toBe('x'.repeat(MAX_TITLE_CHARS - 1));
  });
  it.each([
    'Add a retry',
    `${'é'.repeat(150)} ${'🚀'.repeat(60)}`,
    'a\u0085b',
    '  padded   text  ',
    `${'y'.repeat(MAX_TITLE_CHARS - 1)} z`,
  ])('always produces a title the run frame accepts (%#)', (text) => {
    const title = runTitle(text);
    expect(title).toBeDefined();
    expect(desktopFrameSchema.safeParse({ ...run, title }).success).toBe(true);
  });
});

describe('plane to desktop schemas', () => {
  it.each(planeValid)('accepts %s', (_name, frame) => {
    expect(planeFrameSchema.safeParse(frame).success).toBe(true);
  });
  it.each(planeInvalid)('rejects %s', (_name, frame) => {
    expect(planeFrameSchema.safeParse(frame).success).toBe(false);
  });
  it('accepts exactly 500 diff files', () => {
    const files = Array.from({ length: MAX_DIFF_FILES }, (_, i) => `f${String(i)}`);
    expect(
      planeFrameSchema.safeParse({ type: 'diff', taskId: 't', text: '', truncated: false, files })
        .success,
    ).toBe(true);
  });
});

describe('completed outcome: report and lanes (additive to nexar-plane/1)', () => {
  const completed = (outcome: Record<string, unknown>) => ({
    type: 'completed',
    runId: RUN,
    outcome: { taskId: 'eng-0123456789ab', ...outcome },
  });
  const report = { text: 'Summary\n\nFindings', truncated: false };
  const ok = (frame: unknown): boolean => planeFrameSchema.safeParse(frame).success;

  it('still accepts every completed frame that was valid before the amendment', () => {
    for (const status of ['committed', 'not-accepted', 'failed', 'cancelled']) {
      expect(ok(completed({ status }))).toBe(true);
      expect(ok(completed({ status, reason: 'x' }))).toBe(true);
    }
    expect(
      ok(
        completed({
          status: 'committed',
          branch: 'nexar/eng-0123456789ab',
          commit: 'd'.repeat(40),
          reason: 'x',
        }),
      ),
    ).toBe(true);
  });

  it('accepts a reported outcome with a report and lanes', () => {
    expect(
      ok(
        completed({
          status: 'reported',
          report,
          lanes: [{ role: 'report', resourceId: 'deepseek-harness' }],
        }),
      ),
    ).toBe(true);
    expect(ok(completed({ status: 'reported' }))).toBe(true);
  });

  it('accepts lanes on any status, up to 16', () => {
    const lanes = (n: number) =>
      Array.from({ length: n }, (_, i) => ({ role: 'feature', resourceId: `r${String(i)}` }));
    expect(ok(completed({ status: 'committed', lanes: lanes(16) }))).toBe(true);
    expect(ok(completed({ status: 'failed', lanes: lanes(0) }))).toBe(true);
    expect(ok(completed({ status: 'failed', lanes: lanes(17) }))).toBe(false);
  });

  it.each(['committed', 'not-accepted', 'failed', 'cancelled'])(
    'rejects a report with status %s',
    (status) => {
      expect(ok(completed({ status, report }))).toBe(false);
    },
  );

  it('bounds the report text and rejects unknown keys', () => {
    expect(
      ok(completed({ status: 'reported', report: { ...report, text: 'x'.repeat(65_536) } })),
    ).toBe(true);
    expect(
      ok(completed({ status: 'reported', report: { ...report, text: 'x'.repeat(65_537) } })),
    ).toBe(false);
    expect(ok(completed({ status: 'reported', report: { ...report, text: '' } }))).toBe(false);
    expect(ok(completed({ status: 'reported', report: { text: 'x' } }))).toBe(false);
    expect(ok(completed({ status: 'reported', report: { ...report, path: '/x' } }))).toBe(false);
    expect(
      ok(
        completed({ status: 'reported', lanes: [{ role: 'report', resourceId: 'r', cwd: '/x' }] }),
      ),
    ).toBe(false);
    expect(ok(completed({ status: 'reported', lanes: [{ role: '', resourceId: 'r' }] }))).toBe(
      false,
    );
  });
});
