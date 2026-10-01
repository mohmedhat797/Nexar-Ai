import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { TelemetryHistorySource, readExecutionHistory } from './history.js';

const NOW = new Date('2026-03-31T12:00:00.000Z');
const DAY = 86_400_000;

function finished(
  overrides: {
    resourceId?: string;
    taskKind?: string;
    outcome?: string;
    code?: string;
    startedAt?: string;
    latencyMs?: number;
    costUsd?: unknown;
  } = {},
): unknown {
  const startedAt = overrides.startedAt ?? new Date(NOW.getTime() - DAY).toISOString();
  return {
    type: 'execution.finished',
    at: startedAt,
    record: {
      schemaVersion: 1,
      taskId: 't',
      taskKind: overrides.taskKind ?? 'coding',
      resourceId: overrides.resourceId ?? 'a',
      outcome: overrides.outcome ?? 'succeeded',
      ...(overrides.code === undefined
        ? {}
        : { error: { code: overrides.code, message: 'm', retryable: false } }),
      startedAt,
      endedAt: startedAt,
      latencyMs: overrides.latencyMs ?? 100,
      usage: overrides.costUsd === undefined ? {} : { costUsd: overrides.costUsd },
    },
  };
}

describe('readExecutionHistory', () => {
  let dir: string;
  let path: string;
  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'nexar-history-'));
    path = join(dir, 'telemetry.jsonl');
  });
  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  const write = (lines: readonly unknown[]): Promise<void> =>
    writeFile(
      path,
      lines.map((l) => (typeof l === 'string' ? l : JSON.stringify(l))).join('\n') + '\n',
    );
  const read = () => readExecutionHistory(path, { now: NOW, windowDays: 30 });

  it('keeps only records started inside the window', async () => {
    await write([
      finished({ startedAt: new Date(NOW.getTime() - 31 * DAY).toISOString() }),
      finished({ startedAt: new Date(NOW.getTime() - 29 * DAY).toISOString() }),
      finished({ startedAt: new Date(NOW.getTime() + DAY).toISOString() }),
    ]);
    const h = await read();
    expect(h.executions['a']?.['coding']?.samples).toBe(1);
    expect(h.windowStart).toBe(new Date(NOW.getTime() - 30 * DAY).toISOString());
    expect(h.windowEnd).toBe(NOW.toISOString());
    expect(h.lanes).toEqual({});
  });

  it.each([
    ['PROVIDER_ERROR', 'fault'],
    ['RESOURCE_UNAVAILABLE', 'fault'],
    ['QUOTA_EXHAUSTED', 'fault'],
    ['INTEGRATION_UNAVAILABLE', 'fault'],
    ['AUTH_REQUIRED', 'fault'],
    ['INTERNAL_ERROR', 'fault'],
    ['EXECUTION_TIMEOUT', 'timeout'],
    ['VALIDATION_ERROR', 'excluded'],
    ['POLICY_REJECTED', 'excluded'],
    ['CONFIGURATION_ERROR', 'excluded'],
    ['APPROVAL_DENIED', 'excluded'],
    ['SANDBOX_UNAVAILABLE', 'excluded'],
    ['SOMETHING_NEW', 'excluded'],
  ])('classifies a failure with %s as %s', async (code, expected) => {
    await write([finished({ outcome: 'failed', code })]);
    const agg = (await read()).executions['a']?.['coding'];
    if (expected === 'excluded') {
      expect(agg).toBeUndefined();
      return;
    }
    expect(agg).toMatchObject({
      samples: 1,
      successes: 0,
      resourceFaults: 1,
      timeouts: expected === 'timeout' ? 1 : 0,
    });
  });

  it('counts timed-out runs as resource faults and excludes cancelled ones', async () => {
    await write([finished({ outcome: 'timed-out' }), finished({ outcome: 'cancelled' })]);
    expect((await read()).executions['a']?.['coding']).toMatchObject({
      samples: 1,
      resourceFaults: 1,
      timeouts: 1,
    });
  });

  it('computes nearest-rank p50/p95 over successes with clamped latency', async () => {
    const latencies = [10, 20, 30, 40, 50, 60, 70, 80, 90, -5, 1e12];
    await write([
      ...latencies.map((latencyMs) => finished({ latencyMs })),
      finished({ outcome: 'failed', code: 'PROVIDER_ERROR', latencyMs: 1 }),
    ]);
    const agg = (await read()).executions['a']?.['coding'];
    expect(agg).toMatchObject({ samples: 12, successes: 11, p50LatencyMs: 50, p95LatencyMs: DAY });
  });

  it('averages only usable measured or estimated costs, never inventing zero', async () => {
    await write([
      finished({ costUsd: { status: 'measured', value: 0.2 } }),
      finished({ costUsd: { status: 'estimated', value: 0.4, basis: 'b' } }),
      finished({ costUsd: { status: 'unavailable', reason: 'n/a' } }),
      finished({ costUsd: { status: 'measured', value: -1 } }),
      finished({}),
    ]);
    const agg = (await read()).executions['a']?.['coding'];
    expect(agg?.costSamples).toBe(2);
    expect(agg?.meanCostUsd).toBeCloseTo(0.3, 9);

    await write([finished({ costUsd: { status: 'unavailable', reason: 'n/a' } })]);
    const none = (await read()).executions['a']?.['coding'];
    expect(none?.costSamples).toBe(0);
    expect(none).not.toHaveProperty('meanCostUsd');
  });

  it('skips malformed lines and keeps prototype-like ids as plain data', async () => {
    await write([
      '{not json',
      { type: 'execution.finished', at: NOW.toISOString(), record: { resourceId: 3 } },
      finished({ resourceId: '__proto__', taskKind: 'constructor' }),
    ]);
    const h = await read();
    expect(h.skipped).toBeGreaterThanOrEqual(1);
    expect(Object.hasOwn(h.executions, '__proto__')).toBe(true);
    expect(h.executions['__proto__']?.['constructor']?.samples).toBe(1);
    expect(({} as Record<string, unknown>)['constructor']).toBe(Object);
  });

  it('returns empty history for a missing file', async () => {
    const h = await read();
    expect(h.executions).toEqual({});
    expect(h.skipped).toBe(0);
  });
});

describe('TelemetryHistorySource', () => {
  let dir: string;
  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'nexar-history-src-'));
  });
  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it('merges lane aggregates and sums skipped counts', async () => {
    const path = join(dir, 't.jsonl');
    await writeFile(path, `{bad\n${JSON.stringify(finished())}\n`);
    const source = new TelemetryHistorySource({
      path,
      windowDays: 30,
      lanes: () => Promise.resolve({ lanes: { a: { review: { samples: 3 } } }, skipped: 2 }),
    });
    const h = await source.read(NOW);
    expect(h.executions['a']?.['coding']?.samples).toBe(1);
    expect(h.lanes).toEqual({ a: { review: { samples: 3 } } });
    expect(h.skipped).toBe(3);
  });

  it('treats a failing lane provider as no lane history', async () => {
    const source = new TelemetryHistorySource({
      path: join(dir, 'missing.jsonl'),
      windowDays: 30,
      lanes: () => Promise.reject(new Error('boom')),
    });
    const h = await source.read(NOW);
    expect(h.lanes).toEqual({});
    expect(h.executions).toEqual({});
  });

  it('reads lane history even without a telemetry file', async () => {
    const source = new TelemetryHistorySource({
      windowDays: 30,
      lanes: () => Promise.resolve({ lanes: { a: { feature: { samples: 1 } } }, skipped: 0 }),
    });
    const h = await source.read(NOW);
    expect(h.executions).toEqual({});
    expect(h.lanes).toEqual({ a: { feature: { samples: 1 } } });
  });

  it('never throws for an unreadable path', async () => {
    // A directory where a file is expected.
    const source = new TelemetryHistorySource({ path: dir, windowDays: 30 });
    const h = await source.read(NOW);
    expect(h.executions).toEqual({});
  });
});
