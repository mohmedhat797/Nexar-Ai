import { mkdirSync, symlinkSync, writeFileSync } from 'node:fs';
import { lstat, open } from 'node:fs/promises';
import type * as FsPromises from 'node:fs/promises';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, tempDir } from './fixtures.testkit.js';
import { aggregateLaneHistory, laneHistoryProvider, readLaneHistory } from './lane-history.js';
import type { CommandRecord, EngineeringRecord, LaneRecord, ReviewRecord } from './record.js';

vi.mock('node:fs/promises', async (importOriginal: () => Promise<typeof FsPromises>) => {
  const actual = await importOriginal();
  return { ...actual, lstat: vi.fn(actual.lstat), open: vi.fn(actual.open) };
});

const NOW = new Date('2026-06-15T12:00:00.000Z');
const dirs: string[] = [];
afterEach(() => {
  vi.mocked(lstat).mockClear();
  vi.mocked(open).mockClear();
  cleanup(...dirs.splice(0));
});

function lane(over: Partial<LaneRecord> & { role: string; resourceId?: string }): LaneRecord {
  return {
    laneId: 'l',
    round: 0,
    taskId: 't',
    reasonCodes: [],
    outcome: 'succeeded',
    latencyMs: 100,
    ...over,
  };
}

function gate(round: number, passed: boolean): CommandRecord {
  return {
    phase: 'gate',
    name: 'g',
    round,
    exitCode: passed ? 0 : 1,
    timedOut: false,
    passed,
    durationMs: 1,
    outputSha256: 'x',
    outputBytes: 0,
  };
}

function review(
  round: number,
  resourceId: string,
  verdict: ReviewRecord['verdict'],
  valid = true,
): ReviewRecord {
  return {
    round,
    resourceId,
    verdict,
    valid,
    findings: { blocker: 0, major: 0, minor: 0, nit: 0 },
    reasonCodes: [],
  };
}

function rec(over: Partial<EngineeringRecord> = {}): EngineeringRecord {
  return {
    schemaVersion: 1,
    taskId: 'task-1',
    projectId: 'p',
    planId: 'default',
    status: 'committed',
    startedAt: '2026-06-14T00:00:00.000Z',
    baseBranch: 'main',
    branch: 'nexar/task-1',
    round: 0,
    lanes: [],
    commands: [],
    patches: [],
    reviews: [],
    ...over,
  };
}

describe('aggregateLaneHistory', () => {
  it('keeps implementer and reviewer quality separate', () => {
    const lanes = aggregateLaneHistory([
      rec({
        lanes: [
          lane({ role: 'feature', resourceId: 'impl' }),
          lane({ role: 'review', resourceId: 'rev' }),
        ],
        reviews: [review(0, 'rev', 'approve')],
      }),
    ]);
    expect(lanes['impl']?.feature).toMatchObject({
      samples: 1,
      reviewVerdicts: 1,
      reviewApprovals: 1,
    });
    expect(lanes['impl']?.review).toBeUndefined();
    expect(lanes['rev']?.review).toEqual({
      samples: 1,
      p50LatencyMs: 100,
      producedVerdicts: 1,
      validVerdicts: 1,
    });
    expect(lanes['rev']?.feature).toBeUndefined();
  });

  it('counts request-changes against the implementer only', () => {
    const lanes = aggregateLaneHistory([
      rec({
        round: 1,
        lanes: [
          lane({ role: 'feature', resourceId: 'impl' }),
          lane({ role: 'feature', resourceId: 'impl', round: 1 }),
        ],
        reviews: [review(0, 'rev', 'request-changes'), review(1, 'rev', 'approve')],
      }),
    ]);
    expect(lanes['impl']?.feature).toMatchObject({ reviewVerdicts: 2, reviewApprovals: 1 });
    expect(lanes['rev']?.review).toMatchObject({ producedVerdicts: 2, validVerdicts: 2 });
  });

  it('counts an invalid verdict against the reviewer and never as an approval', () => {
    const lanes = aggregateLaneHistory([
      rec({
        lanes: [lane({ role: 'feature', resourceId: 'impl' })],
        reviews: [review(0, 'rev', 'approve', false)],
      }),
    ]);
    expect(lanes['impl']?.feature).toMatchObject({ reviewVerdicts: 1, reviewApprovals: 0 });
    expect(lanes['rev']?.review).toMatchObject({ producedVerdicts: 1, validVerdicts: 0 });
  });

  it('scores first-round gates pass and fail', () => {
    const base = { lanes: [lane({ role: 'feature', resourceId: 'impl' })] };
    const pass = aggregateLaneHistory([rec({ ...base, commands: [gate(0, true), gate(0, true)] })]);
    const fail = aggregateLaneHistory([
      rec({ ...base, commands: [gate(0, true), gate(0, false)] }),
    ]);
    expect(pass['impl']?.feature).toMatchObject({ gateSamples: 1, firstRoundGatePasses: 1 });
    expect(fail['impl']?.feature).toMatchObject({ gateSamples: 1, firstRoundGatePasses: 0 });
  });

  it('ignores later-round gates and omits gate counters without gate data', () => {
    const lanes = aggregateLaneHistory([
      rec({
        round: 1,
        lanes: [lane({ role: 'feature', resourceId: 'impl' })],
        commands: [gate(1, true)],
      }),
    ]);
    expect(lanes['impl']?.feature).not.toHaveProperty('gateSamples');
    expect(lanes['impl']?.feature).not.toHaveProperty('firstRoundGatePasses');
    expect(lanes['impl']?.feature).not.toHaveProperty('reviewVerdicts');
    expect(lanes['impl']?.feature).not.toHaveProperty('ownerDecisions');
  });

  it('accumulates rework rounds and tasks, clamping the round', () => {
    const lanes = aggregateLaneHistory([
      rec({ round: 2, lanes: [lane({ role: 'tests', resourceId: 'impl' })] }),
      rec({ taskId: 'task-2', round: 99, lanes: [lane({ role: 'tests', resourceId: 'impl' })] }),
    ]);
    expect(lanes['impl']?.tests).toMatchObject({ tasks: 2, reworkRounds: 12 });
  });

  it('attributes round outcomes to every implementer of the round', () => {
    const lanes = aggregateLaneHistory([
      rec({
        lanes: [
          lane({ role: 'feature', resourceId: 'a' }),
          lane({ role: 'tests', resourceId: 'b' }),
          lane({ role: 'tests', resourceId: 'b' }),
          lane({ role: 'debugging', resourceId: 'c', outcome: 'failed' }),
        ],
        commands: [gate(0, true)],
        reviews: [review(0, 'rev', 'approve')],
        approval: { outcome: 'approved' },
      }),
    ]);
    expect(lanes['a']?.feature).toMatchObject({
      gateSamples: 1,
      reviewVerdicts: 1,
      ownerDecisions: 1,
    });
    expect(lanes['b']?.tests).toMatchObject({
      samples: 2,
      gateSamples: 1,
      reviewVerdicts: 1,
      ownerApprovals: 1,
      tasks: 1,
    });
    // A failed lane is sampled but did not produce work the round outcome applies to.
    expect(lanes['c']?.debugging).toEqual({ samples: 1 });
  });

  it('only counts approved and denied owner decisions', () => {
    const outcomes = (outcome: string) =>
      aggregateLaneHistory([
        rec({ lanes: [lane({ role: 'feature', resourceId: 'impl' })], approval: { outcome } }),
      ])['impl']?.feature;
    expect(outcomes('approved')).toMatchObject({ ownerDecisions: 1, ownerApprovals: 1 });
    expect(outcomes('denied')).toMatchObject({ ownerDecisions: 1, ownerApprovals: 0 });
    expect(outcomes('not-required')).not.toHaveProperty('ownerDecisions');
    expect(outcomes('expired')).not.toHaveProperty('ownerDecisions');
    expect(outcomes('weird')).not.toHaveProperty('ownerDecisions');
  });

  it('attributes the owner decision to the final round implementers', () => {
    const lanes = aggregateLaneHistory([
      rec({
        round: 1,
        approval: { outcome: 'approved' },
        lanes: [
          lane({ role: 'feature', resourceId: 'first' }),
          lane({ role: 'feature', resourceId: 'second', round: 1 }),
        ],
      }),
    ]);
    expect(lanes['first']?.feature).not.toHaveProperty('ownerDecisions');
    expect(lanes['second']?.feature).toMatchObject({ ownerDecisions: 1, ownerApprovals: 1 });
  });

  it('excludes cancelled and caller/policy error lanes from samples', () => {
    const lanes = aggregateLaneHistory([
      rec({
        lanes: [
          lane({ role: 'feature', resourceId: 'r', outcome: 'cancelled' }),
          ...[
            'VALIDATION_ERROR',
            'POLICY_REJECTED',
            'CONFIGURATION_ERROR',
            'APPROVAL_DENIED',
            'SANDBOX_UNAVAILABLE',
          ].map((errorCode) =>
            lane({ role: 'feature', resourceId: 'r', outcome: 'failed', errorCode }),
          ),
          lane({
            role: 'feature',
            resourceId: 'r',
            outcome: 'failed',
            errorCode: 'RESOURCE_ERROR',
          }),
          lane({ role: 'feature' }),
          lane({ role: 'mystery', resourceId: 'r' }),
        ],
      }),
    ]);
    expect(lanes['r']?.feature).toEqual({ samples: 1 });
    expect(Object.keys(lanes['r'] ?? {})).toEqual(['feature']);
  });

  it('counts architecture samples and latency only', () => {
    const lanes = aggregateLaneHistory([
      rec({
        round: 3,
        lanes: [lane({ role: 'architecture', resourceId: 'arch', latencyMs: 250 })],
        commands: [gate(0, true)],
        approval: { outcome: 'approved' },
      }),
    ]);
    expect(lanes['arch']?.architecture).toEqual({ samples: 1, p50LatencyMs: 250 });
  });

  it('uses the nearest-rank median over succeeded lanes with clamped latency', () => {
    const latencies = [10, 20, 30, 40];
    const lanes = aggregateLaneHistory([
      rec({
        lanes: [
          ...latencies.map((latencyMs) => lane({ role: 'feature', resourceId: 'r', latencyMs })),
          lane({ role: 'feature', resourceId: 'r', outcome: 'failed', latencyMs: 9_999_999 }),
        ],
      }),
    ]);
    expect(lanes['r']?.feature).toMatchObject({ samples: 5, p50LatencyMs: 20 });

    const clamped = aggregateLaneHistory([
      rec({
        lanes: [
          lane({ role: 'feature', resourceId: 'r', latencyMs: -5 }),
          lane({ role: 'feature', resourceId: 'r', latencyMs: Number.NaN }),
          lane({ role: 'feature', resourceId: 'r', latencyMs: 1e12 }),
        ],
      }),
    ]);
    expect(clamped['r']?.feature).toMatchObject({ samples: 3, p50LatencyMs: 0 });
  });

  it('is prototype safe for hostile resource ids', () => {
    const lanes = aggregateLaneHistory([
      rec({
        lanes: [
          lane({ role: 'feature', resourceId: '__proto__' }),
          lane({ role: 'feature', resourceId: 'constructor' }),
        ],
      }),
    ]);
    expect(Object.keys(lanes).sort()).toEqual(['__proto__', 'constructor']);
    expect(Object.hasOwn(lanes, '__proto__')).toBe(true);
    expect(lanes['__proto__']?.feature).toMatchObject({ samples: 1 });
    expect(({} as Record<string, unknown>)['samples']).toBeUndefined();
    expect(Object.getPrototypeOf(lanes)).toBeNull();
  });
});

function writeRecord(stateDir: string, name: string, record: unknown): string {
  const dir = join(stateDir, 'engineering', name);
  mkdirSync(dir, { recursive: true });
  const path = join(dir, 'record.json');
  writeFileSync(path, typeof record === 'string' ? record : JSON.stringify(record));
  return path;
}

function state(): string {
  const dir = tempDir();
  dirs.push(dir);
  return dir;
}

const implLane = (resourceId: string) => lane({ role: 'feature', resourceId });
const window = { now: NOW, windowDays: 7 };

describe('readLaneHistory', () => {
  it('returns an empty result when the directory is missing', async () => {
    expect(await readLaneHistory(state(), window)).toEqual({ lanes: {}, skipped: 0 });
  });

  it('reads records inside the window and ignores others', async () => {
    const dir = state();
    writeRecord(dir, 'in', rec({ taskId: 'in', lanes: [implLane('r')] }));
    writeRecord(
      dir,
      'old',
      rec({ taskId: 'old', startedAt: '2026-05-01T00:00:00.000Z', lanes: [implLane('r')] }),
    );
    writeRecord(
      dir,
      'future',
      rec({ taskId: 'future', startedAt: '2026-07-01T00:00:00.000Z', lanes: [implLane('r')] }),
    );
    writeRecord(
      dir,
      'badtime',
      rec({ taskId: 'badtime', startedAt: 'nope', lanes: [implLane('r')] }),
    );
    const result = await readLaneHistory(dir, window);
    expect(result.lanes['r']?.feature).toMatchObject({ samples: 1, tasks: 1 });
    expect(result.skipped).toBe(0);
  });

  it('ignores running records', async () => {
    const dir = state();
    writeRecord(dir, 'run', rec({ taskId: 'run', status: 'running', lanes: [implLane('r')] }));
    expect(await readLaneHistory(dir, window)).toEqual({ lanes: {}, skipped: 0 });
  });

  it('skips malformed, foreign and mistyped records without throwing', async () => {
    const dir = state();
    writeRecord(dir, 'junk', '{not json');
    writeRecord(dir, 'v2', { ...rec(), schemaVersion: 2 });
    writeRecord(dir, 'arr', []);
    writeRecord(dir, 'nolanes', { ...rec(), lanes: 'x' });
    writeRecord(dir, 'badlane', { ...rec(), lanes: [{ role: 5 }] });
    writeRecord(dir, 'badappr', { ...rec(), approval: { outcome: 3 } });
    writeRecord(dir, 'good', rec({ lanes: [implLane('r')] }));
    const result = await readLaneHistory(dir, window);
    expect(result.skipped).toBe(6);
    expect(result.lanes['r']?.feature).toMatchObject({ samples: 1 });
  });

  it('skips a symlinked record and never follows it', async (context) => {
    const dir = state();
    const outside = state();
    const target = join(outside, 'real.json');
    writeFileSync(target, JSON.stringify(rec({ lanes: [implLane('leak')] })));
    mkdirSync(join(dir, 'engineering', 'link'), { recursive: true });
    try {
      symlinkSync(target, join(dir, 'engineering', 'link', 'record.json'), 'file');
    } catch (error) {
      if (process.platform === 'win32' && (error as NodeJS.ErrnoException).code === 'EPERM') {
        context.skip(
          'Windows file symlinks require Developer Mode or SeCreateSymbolicLinkPrivilege',
        );
      }
      throw error;
    }
    const result = await readLaneHistory(dir, window);
    expect(result).toEqual({ lanes: {}, skipped: 1 });
  });

  it('skips a symlinked task directory and never follows it', async () => {
    const dir = state();
    const outside = state();
    writeRecord(outside, 'real', rec({ lanes: [implLane('leak')] }));
    mkdirSync(join(dir, 'engineering'), { recursive: true });
    symlinkSync(
      join(outside, 'engineering', 'real'),
      join(dir, 'engineering', 'link'),
      process.platform === 'win32' ? 'junction' : 'dir',
    );
    const result = await readLaneHistory(dir, window);
    expect(result).toEqual({ lanes: {}, skipped: 1 });
  });

  it('rejects a different file opened after the record was checked, without reading it', async () => {
    const actual = await vi.importActual<typeof FsPromises>('node:fs/promises');
    const dir = state();
    writeRecord(dir, 'safe', rec({ lanes: [implLane('safe')] }));
    const foreign = writeRecord(state(), 'foreign', rec({ lanes: [implLane('leak')] }));
    const handle = await actual.open(foreign, 'r');
    const read = vi.spyOn(handle, 'readFile');
    const close = vi.spyOn(handle, 'close');
    vi.mocked(open).mockResolvedValueOnce(handle);
    expect(await readLaneHistory(dir, window)).toEqual({ lanes: {}, skipped: 1 });
    expect(read).not.toHaveBeenCalled();
    expect(close).toHaveBeenCalledOnce();
  });

  it.each(['record', 'task directory'])(
    'rejects a %s path replaced after opening, without reading the handle',
    async (replaced) => {
      const actual = await vi.importActual<typeof FsPromises>('node:fs/promises');
      const dir = state();
      const record = writeRecord(dir, 'safe', rec({ lanes: [implLane('safe')] }));
      const taskDir = join(dir, 'engineering', 'safe');
      const foreign = writeRecord(state(), 'foreign', rec({ lanes: [implLane('leak')] }));
      const foreignDir = state();
      const handle = await actual.open(record, 'r');
      const read = vi.spyOn(handle, 'readFile');
      const close = vi.spyOn(handle, 'close');
      vi.mocked(open).mockResolvedValueOnce(handle);
      vi.mocked(lstat)
        .mockResolvedValueOnce(await actual.lstat(taskDir, { bigint: true }))
        .mockResolvedValueOnce(await actual.lstat(record, { bigint: true }))
        .mockResolvedValueOnce(
          await actual.lstat(replaced === 'record' ? foreign : record, { bigint: true }),
        )
        .mockResolvedValueOnce(
          await actual.lstat(replaced === 'task directory' ? foreignDir : taskDir, {
            bigint: true,
          }),
        );
      expect(await readLaneHistory(dir, window)).toEqual({ lanes: {}, skipped: 1 });
      expect(read).not.toHaveBeenCalled();
      expect(close).toHaveBeenCalledOnce();
    },
  );

  it('skips an oversize record', async () => {
    const dir = state();
    writeRecord(dir, 'big', rec({ lanes: [implLane('r')] }));
    const result = await readLaneHistory(dir, { ...window, maxRecordBytes: 10 });
    expect(result).toEqual({ lanes: {}, skipped: 1 });
  });

  it('skips entries whose names are not task ids without counting them', async () => {
    const dir = state();
    writeRecord(dir, '.hidden', rec({ lanes: [implLane('r')] }));
    writeRecord(dir, 'has space', rec({ lanes: [implLane('r')] }));
    writeRecord(dir, '-leading', rec({ lanes: [implLane('r')] }));
    writeFileSync(join(dir, 'engineering', 'stray file.txt'), 'x');
    expect(await readLaneHistory(dir, window)).toEqual({ lanes: {}, skipped: 0 });
  });

  it('caps the number of records read and counts the excess as skipped', async () => {
    const dir = state();
    for (const name of ['a', 'b', 'c', 'd']) {
      writeRecord(dir, name, rec({ taskId: name, lanes: [implLane(`res-${name}`)] }));
    }
    const result = await readLaneHistory(dir, { ...window, maxRecords: 2 });
    expect(Object.keys(result.lanes)).toEqual(['res-a', 'res-b']);
    expect(result.skipped).toBe(2);
  });

  it('handles a __proto__ resource id from disk', async () => {
    const dir = state();
    writeRecord(dir, 'p', rec({ lanes: [implLane('__proto__')] }));
    const result = await readLaneHistory(dir, window);
    expect(Object.hasOwn(result.lanes, '__proto__')).toBe(true);
    expect(({} as Record<string, unknown>)['feature']).toBeUndefined();
  });

  it('is deterministic and carries no content or paths', async () => {
    const dir = state();
    writeRecord(dir, 'b', rec({ taskId: 'b', lanes: [implLane('y'), implLane('x')] }));
    writeRecord(
      dir,
      'a',
      rec({
        taskId: 'a',
        lanes: [implLane('x')],
        approval: { id: 'secret-id', outcome: 'approved' },
      }),
    );
    const first = await readLaneHistory(dir, window);
    const second = await readLaneHistory(dir, window);
    expect(JSON.stringify(first)).toBe(JSON.stringify(second));
    expect(Object.keys(first.lanes)).toEqual(['x', 'y']);
    expect(JSON.stringify(first)).not.toMatch(/secret-id|engineering|\//);
  });
});

describe('laneHistoryProvider', () => {
  it('closes over the state dir and window', async () => {
    const dir = state();
    writeRecord(dir, 'in', rec({ taskId: 'in', lanes: [implLane('r')] }));
    const provider = laneHistoryProvider(dir, 7);
    expect((await provider(NOW)).lanes['r']?.feature).toMatchObject({ samples: 1 });
    expect(await laneHistoryProvider(dir, 7)(new Date('2027-01-01T00:00:00Z'))).toEqual({
      lanes: {},
      skipped: 0,
    });
  });
});
