import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  estimated,
  measured,
  resourceId,
  unavailable,
  type ExecutionRecord,
  type Measured,
  type QuotaObservation,
  type TelemetryEvent,
} from '@nexar/contracts';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { TelemetryQuotaSource, windowBounds, type QuotaAllowance } from './quota-source.js';

const R = resourceId('claude-code');
const OTHER = resourceId('other');

let dir: string;
let file: string;
beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'nexar-quota-source-'));
  file = join(dir, 'telemetry.jsonl');
});
afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

interface RunOptions {
  readonly resource?: typeof R;
  readonly input?: Measured<number>;
  readonly output?: Measured<number>;
  readonly cost?: Measured<number>;
}

function run(startedAt: string, options: RunOptions = {}): TelemetryEvent {
  const record = {
    schemaVersion: 1,
    taskId: 't',
    taskKind: 'general',
    resourceId: options.resource ?? R,
    outcome: 'succeeded',
    startedAt,
    endedAt: startedAt,
    latencyMs: 1,
    usage: {
      inputTokens: options.input ?? measured(10),
      outputTokens: options.output ?? measured(5),
      costUsd: options.cost ?? estimated(0.25, 'list price'),
    },
  } as unknown as ExecutionRecord;
  return { type: 'execution.finished', at: startedAt, record };
}

const vendorObservation = (extra: Partial<QuotaObservation> = {}): QuotaObservation => ({
  unit: 'percent',
  limit: 100,
  used: 30,
  remaining: 70,
  observedAt: '2026-10-01T11:59:00.000Z',
  provenance: { limit: 'vendor-reported', usage: 'vendor-reported' },
  label: 'claude-rate-limit',
  ...extra,
});

const signal = (at: string, observation: QuotaObservation, id = R): TelemetryEvent => ({
  type: 'quota.observed',
  at,
  resourceId: id,
  observation,
});

async function write(...events: TelemetryEvent[]): Promise<void> {
  await writeFile(file, events.map((e) => JSON.stringify(e)).join('\n') + '\n');
}

const allowance = (extra: Partial<QuotaAllowance> = {}): QuotaAllowance => ({
  resourceId: R,
  unit: 'requests',
  limit: 10,
  window: 'daily',
  ...extra,
});

async function observe(
  now: string,
  allowances: QuotaAllowance[],
  ids = [R],
): Promise<readonly QuotaObservation[]> {
  const source = new TelemetryQuotaSource({ path: file, allowances });
  return (await source.observe(ids, new Date(now))).get(R) ?? [];
}

describe('windowBounds', () => {
  it('computes UTC calendar windows', () => {
    // 2026-10-01 is a Thursday.
    const now = new Date('2026-10-01T12:00:00.000Z');
    const iso = (w: ReturnType<typeof windowBounds>) => [
      new Date(w.start).toISOString(),
      w.end === undefined ? undefined : new Date(w.end).toISOString(),
    ];
    expect(iso(windowBounds('daily', now))).toEqual([
      '2026-10-01T00:00:00.000Z',
      '2026-10-02T00:00:00.000Z',
    ]);
    expect(iso(windowBounds('weekly', now))).toEqual([
      '2026-09-28T00:00:00.000Z',
      '2026-10-05T00:00:00.000Z',
    ]);
    expect(iso(windowBounds('monthly', now))).toEqual([
      '2026-10-01T00:00:00.000Z',
      '2026-11-01T00:00:00.000Z',
    ]);
    expect(iso(windowBounds({ hours: 5 }, now))).toEqual(['2026-10-01T07:00:00.000Z', undefined]);
  });

  it('puts Monday and Sunday in the right week and rolls over months and years', () => {
    const monday = windowBounds('weekly', new Date('2026-09-28T00:00:00.000Z'));
    expect(new Date(monday.start).toISOString()).toBe('2026-09-28T00:00:00.000Z');
    const sunday = windowBounds('weekly', new Date('2026-10-04T23:59:59.999Z'));
    expect(new Date(sunday.start).toISOString()).toBe('2026-09-28T00:00:00.000Z');
    expect(new Date(sunday.end ?? 0).toISOString()).toBe('2026-10-05T00:00:00.000Z');
    expect(
      new Date(windowBounds('monthly', new Date('2026-12-31T23:00:00Z')).end ?? 0).toISOString(),
    ).toBe('2027-01-01T00:00:00.000Z');
  });
});

describe('TelemetryQuotaSource: accounting', () => {
  it('counts requests in the daily window, including the boundaries', async () => {
    await write(
      run('2026-09-30T23:59:59.999Z'),
      run('2026-10-01T00:00:00.000Z'),
      run('2026-10-01T11:00:00.000Z'),
      run('2026-10-01T11:00:00.000Z', { resource: OTHER }),
      run('2026-10-02T00:00:00.000Z'),
    );
    const [o] = await observe('2026-10-01T12:00:00.000Z', [allowance({ label: 'daily cap' })]);
    expect(o).toEqual({
      unit: 'requests',
      limit: 10,
      used: 2,
      remaining: 8,
      window: 'daily',
      resetsAt: '2026-10-02T00:00:00.000Z',
      observedAt: '2026-10-01T12:00:00.000Z',
      provenance: { limit: 'owner-declared', usage: 'nexar-accounting' },
      label: 'daily cap',
    });
  });

  it('resets at the next boundary', async () => {
    await write(run('2026-10-01T23:59:59.000Z'));
    const [o] = await observe('2026-10-02T00:00:00.000Z', [allowance()]);
    expect(o?.used).toBe(0);
    expect(o?.remaining).toBe(10);
  });

  it('uses Monday-to-Monday weeks', async () => {
    await write(run('2026-09-27T23:00:00.000Z'), run('2026-09-28T00:00:00.000Z'));
    const [o] = await observe('2026-10-01T12:00:00.000Z', [allowance({ window: 'weekly' })]);
    expect(o).toMatchObject({ used: 1, resetsAt: '2026-10-05T00:00:00.000Z' });
  });

  it('uses calendar months', async () => {
    await write(run('2026-09-30T23:00:00.000Z'), run('2026-10-01T00:00:00.000Z'));
    const [o] = await observe('2026-10-15T12:00:00.000Z', [allowance({ window: 'monthly' })]);
    expect(o).toMatchObject({ used: 1, resetsAt: '2026-11-01T00:00:00.000Z' });
  });

  it('uses rolling windows without a reset time', async () => {
    await write(
      run('2026-10-01T06:59:59.000Z'),
      run('2026-10-01T07:00:00.000Z'),
      run('2026-10-01T11:00:00.000Z'),
      run('2026-10-01T13:00:00.000Z'),
    );
    const [o] = await observe('2026-10-01T12:00:00.000Z', [allowance({ window: { hours: 5 } })]);
    expect(o?.used).toBe(2);
    expect(o).not.toHaveProperty('resetsAt');
    expect(o?.window).toEqual({ hours: 5 });
  });

  it('floors remaining at zero when over the limit', async () => {
    await write(
      run('2026-10-01T01:00:00Z'),
      run('2026-10-01T02:00:00Z'),
      run('2026-10-01T03:00:00Z'),
    );
    const [o] = await observe('2026-10-01T12:00:00.000Z', [allowance({ limit: 2 })]);
    expect(o).toMatchObject({ used: 3, remaining: 0 });
  });

  it('sums tokens and counts runs without usage as unaccounted, never zero', async () => {
    await write(
      run('2026-10-01T01:00:00Z', { input: measured(100), output: measured(50) }),
      run('2026-10-01T02:00:00Z', { input: estimated(10, 'chars/4'), output: measured(5) }),
      run('2026-10-01T03:00:00Z', { input: unavailable('n/a'), output: measured(5) }),
      run('2026-10-01T04:00:00Z', { input: measured(7), output: unavailable() }),
    );
    const [o] = await observe('2026-10-01T12:00:00.000Z', [
      allowance({ unit: 'tokens', limit: 1000 }),
    ]);
    expect(o).toMatchObject({ unit: 'tokens', used: 165, remaining: 835, unaccountedRuns: 2 });
  });

  it('omits unaccountedRuns when everything was accounted', async () => {
    await write(run('2026-10-01T01:00:00Z'));
    const [o] = await observe('2026-10-01T12:00:00.000Z', [
      allowance({ unit: 'tokens', limit: 100 }),
    ]);
    expect(o).not.toHaveProperty('unaccountedRuns');
  });

  it('sums usd from measured or estimated cost; others are unaccounted', async () => {
    await write(
      run('2026-10-01T01:00:00Z', { cost: estimated(0.25, 'list') }),
      run('2026-10-01T02:00:00Z', { cost: measured(0.5) }),
      run('2026-10-01T03:00:00Z', { cost: unavailable('n/a') }),
    );
    const [o] = await observe('2026-10-01T12:00:00.000Z', [allowance({ unit: 'usd', limit: 5 })]);
    expect(o).toMatchObject({ unit: 'usd', used: 0.75, remaining: 4.25, unaccountedRuns: 1 });
  });

  it('emits one observation per allowance, only for requested resources', async () => {
    await write(run('2026-10-01T01:00:00Z'));
    const source = new TelemetryQuotaSource({
      path: file,
      allowances: [
        allowance(),
        allowance({ window: 'weekly', limit: 50 }),
        allowance({ resourceId: OTHER }),
      ],
    });
    const result = await source.observe([R], new Date('2026-10-01T12:00:00.000Z'));
    expect(result.get(R)?.map((o) => o.window)).toEqual(['daily', 'weekly']);
    expect(result.has(OTHER)).toBe(false);
  });

  it('skips allowances with an unusable limit', async () => {
    await write(run('2026-10-01T01:00:00Z'));
    const result = await new TelemetryQuotaSource({
      path: file,
      allowances: [allowance({ limit: 0 }), allowance({ limit: Number.NaN })],
    }).observe([R], new Date('2026-10-01T12:00:00.000Z'));
    expect(result.size).toBe(0);
  });

  it('reports zero used for a missing file (nothing has run yet)', async () => {
    const [o] = await observe('2026-10-01T12:00:00.000Z', [allowance()]);
    expect(o).toMatchObject({ used: 0, remaining: 10 });
  });

  it('degrades to no observations when the file cannot be read, never to zero used', async () => {
    // A directory cannot be read as a file, whatever the privileges.
    const source = new TelemetryQuotaSource({ path: dir, allowances: [allowance()] });
    expect((await source.observe([R], new Date('2026-10-01T12:00:00.000Z'))).size).toBe(0);
  });

  it('ignores garbage lines', async () => {
    await writeFile(file, `{broken\n${JSON.stringify(run('2026-10-01T01:00:00Z'))}\nnull\n`);
    const [o] = await observe('2026-10-01T12:00:00.000Z', [allowance()]);
    expect(o?.used).toBe(1);
  });
});

describe('TelemetryQuotaSource: vendor-reported signals', () => {
  const NOW = '2026-10-01T12:00:00.000Z';

  it('passes the latest observation per label through unchanged', async () => {
    const older = vendorObservation({ used: 10, remaining: 90 });
    const newer = vendorObservation({ used: 55, remaining: 45 });
    const other = vendorObservation({ label: 'other-window', used: 5, remaining: 95 });
    await write(
      signal('2026-10-01T10:00:00.000Z', older),
      signal('2026-10-01T11:59:00.000Z', newer),
      signal('2026-10-01T11:00:00.000Z', other),
      signal('2026-10-01T11:59:30.000Z', vendorObservation(), OTHER),
    );
    const observations = await observe(NOW, []);
    expect(observations).toEqual([newer, other]);
  });

  it('does not judge freshness itself', async () => {
    const old = vendorObservation({ observedAt: '2026-09-30T00:00:00.000Z' });
    await write(signal('2026-09-30T00:00:00.000Z', old));
    expect(await observe(NOW, [])).toEqual([old]);
  });

  it('drops signals older than seven days', async () => {
    await write(
      signal('2026-09-24T11:59:59.000Z', vendorObservation({ label: 'too-old' })),
      signal('2026-09-24T12:00:00.000Z', vendorObservation({ label: 'edge' })),
    );
    expect((await observe(NOW, [])).map((o) => o.label)).toEqual(['edge']);
  });

  it('ignores signals dated in the future', async () => {
    await write(signal('2026-10-01T12:00:01.000Z', vendorObservation()));
    expect(await observe(NOW, [])).toEqual([]);
  });

  it('does not accept owner-declared or accounting provenance from the file', async () => {
    await write(
      signal(
        '2026-10-01T11:00:00.000Z',
        vendorObservation({ provenance: { limit: 'owner-declared', usage: 'nexar-accounting' } }),
      ),
    );
    expect(await observe(NOW, [])).toEqual([]);
  });

  it('combines accounting and vendor observations', async () => {
    await write(
      run('2026-10-01T01:00:00Z'),
      signal('2026-10-01T11:00:00.000Z', vendorObservation()),
    );
    const observations = await observe(NOW, [allowance()]);
    expect(observations.map((o) => o.provenance.usage)).toEqual([
      'nexar-accounting',
      'vendor-reported',
    ]);
  });
});
