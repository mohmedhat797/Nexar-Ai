import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  isEngineeringLineage,
  isStrategyRecord,
  readEngineeringRecord,
  type EngineeringRecord,
} from './index.js';
import { writeEngineeringRecord } from './record.js';

const lineage = {
  sessionId: `ses_${'a'.repeat(32)}`,
  turnId: `turn_${'b'.repeat(32)}`,
  correlationId: `turn_${'b'.repeat(32)}`,
  depth: 0,
};

const base: EngineeringRecord = {
  schemaVersion: 1,
  taskId: 'eng-0123456789ab',
  projectId: 'demo',
  planId: 'implement-review',
  status: 'running',
  startedAt: '2026-10-03T10:00:00.000Z',
  baseBranch: 'main',
  branch: 'nexar/eng-0123456789ab',
  round: 0,
  lanes: [],
  commands: [],
  patches: [],
  reviews: [],
};

const dirs: string[] = [];
const tempState = (): string => {
  const dir = mkdtempSync(join(tmpdir(), 'nexar-record-'));
  dirs.push(dir);
  return dir;
};
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

describe('isEngineeringLineage', () => {
  it('accepts exactly the four id fields', () => {
    expect(isEngineeringLineage(lineage)).toBe(true);
    expect(isEngineeringLineage({ ...lineage, depth: 2 })).toBe(true);
  });

  it.each([
    ['null', null],
    ['an array', [lineage]],
    ['a string', 'ses_x'],
    ['a missing field', { sessionId: lineage.sessionId, turnId: lineage.turnId, depth: 0 }],
    ['an extra field', { ...lineage, goal: 'x' }],
    ['a bad session id', { ...lineage, sessionId: 'ses_1' }],
    ['a bad turn id', { ...lineage, turnId: 'turn_ZZ' }],
    ['a path as the correlation id', { ...lineage, correlationId: '../x' }],
    ['depth 3', { ...lineage, depth: 3 }],
    ['a negative depth', { ...lineage, depth: -1 }],
    ['a fractional depth', { ...lineage, depth: 0.5 }],
    ['a string depth', { ...lineage, depth: '0' }],
  ])('rejects %s', (_name, value) => {
    expect(isEngineeringLineage(value)).toBe(false);
  });
});

describe('engineering record lineage', () => {
  it('round-trips a record with lineage', async () => {
    const state = tempState();
    await writeEngineeringRecord(state, { ...base, lineage });
    expect((await readEngineeringRecord(state, base.taskId))?.lineage).toEqual(lineage);
  });

  it('reads a record that has no lineage', async () => {
    const state = tempState();
    await writeEngineeringRecord(state, base);
    const read = await readEngineeringRecord(state, base.taskId);
    expect(read).toBeDefined();
    expect(read).not.toHaveProperty('lineage');
  });

  it('refuses a record whose lineage is malformed', async () => {
    const state = tempState();
    const dir = join(state, 'engineering', base.taskId);
    mkdirSync(dir, { recursive: true });
    writeFileSync(
      join(dir, 'record.json'),
      JSON.stringify({ ...base, lineage: { ...lineage, sessionId: 'nope' } }),
    );
    await expect(readEngineeringRecord(state, base.taskId)).rejects.toMatchObject({
      code: 'INTERNAL_ERROR',
    });
  });
});

describe('engineering record strategy', () => {
  const strategy = {
    policy: 'strategy@1',
    configId: 'abc123def456',
    units: 2,
    fallback: 'INTERNAL_ERROR',
  };
  const lane = {
    laneId: 'feature',
    role: 'feature',
    round: 0,
    taskId: 't1',
    reasonCodes: [],
    outcome: 'succeeded' as const,
    latencyMs: 1,
  };

  const writeRaw = (state: string, body: unknown): void => {
    const dir = join(state, 'engineering', base.taskId);
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, 'record.json'), JSON.stringify(body));
  };

  it('round-trips the strategy stamp and planned/fallback lane fields', async () => {
    const state = tempState();
    const lanes = [{ ...lane, planned: 'impl', fallback: true }];
    await writeEngineeringRecord(state, { ...base, strategy, lanes });
    const read = await readEngineeringRecord(state, base.taskId);
    expect(read?.strategy).toEqual(strategy);
    expect(read?.lanes[0]).toMatchObject({ planned: 'impl', fallback: true });
  });

  it('reads an old record without strategy, planned or fallback', async () => {
    const state = tempState();
    await writeEngineeringRecord(state, { ...base, lanes: [lane] });
    const read = await readEngineeringRecord(state, base.taskId);
    expect(read).not.toHaveProperty('strategy');
    expect(read?.lanes[0]).not.toHaveProperty('planned');
  });

  it('accepts a minimal strategy stamp', () => {
    expect(isStrategyRecord({ policy: 'strategy@1', units: 0 })).toBe(true);
  });

  it.each([
    ['null', null],
    ['an array', []],
    ['a missing policy', { units: 1 }],
    ['a free-text policy', { policy: 'plan the goal now', units: 1 }],
    ['an oversized configId', { policy: 'strategy@1', configId: 'a'.repeat(129), units: 1 }],
    ['an extra field', { policy: 'strategy@1', units: 1, goal: 'x' }],
    ['a string count', { policy: 'strategy@1', units: '1' }],
    ['a negative count', { policy: 'strategy@1', units: -1 }],
    ['a fractional count', { policy: 'strategy@1', units: 1.5 }],
    ['an absurd count', { policy: 'strategy@1', units: 1_000_000 }],
    ['a non-code fallback', { policy: 'strategy@1', units: 1, fallback: 'two words' }],
  ])('rejects a strategy with %s', (_name, value) => {
    expect(isStrategyRecord(value)).toBe(false);
  });

  it.each([
    ['a malformed strategy', { strategy: { policy: '../x', units: 1 } }],
    ['a non-string planned', { lanes: [{ ...lane, planned: 7 }] }],
    ['a path as planned', { lanes: [{ ...lane, planned: '../../etc/passwd' }] }],
    ['a non-boolean fallback', { lanes: [{ ...lane, fallback: 'yes' }] }],
    ['a non-object lane', { lanes: ['feature'] }],
  ])('refuses a record with %s', async (_name, patch) => {
    const state = tempState();
    writeRaw(state, { ...base, ...patch });
    await expect(readEngineeringRecord(state, base.taskId)).rejects.toMatchObject({
      code: 'INTERNAL_ERROR',
    });
  });
});
