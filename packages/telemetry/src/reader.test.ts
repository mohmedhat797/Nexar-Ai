import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { isExecutionFinished, isQuotaObserved, readTelemetryEvents } from './reader.js';

let dir: string;
let file: string;
beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'nexar-telemetry-reader-'));
  file = join(dir, 'telemetry.jsonl');
});
afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

const record = (n: number) => ({
  schemaVersion: 1,
  taskId: `t${n}`,
  taskKind: 'general',
  resourceId: 'r',
  outcome: 'succeeded',
  startedAt: '2026-10-01T10:00:00.000Z',
  endedAt: '2026-10-01T10:00:01.000Z',
  latencyMs: 1000,
  usage: {},
});
const finished = (n: number) => ({
  type: 'execution.finished',
  at: '2026-10-01T10:00:01.000Z',
  record: record(n),
});
const quota = {
  type: 'quota.observed',
  at: '2026-10-01T10:00:01.000Z',
  resourceId: 'r',
  observation: {
    unit: 'percent',
    limit: 100,
    used: 10,
    remaining: 90,
    observedAt: '2026-10-01T10:00:01.000Z',
    provenance: { limit: 'vendor-reported', usage: 'vendor-reported' },
  },
};
const lines = (...events: unknown[]): string =>
  events.map((e) => JSON.stringify(e)).join('\n') + '\n';

describe('readTelemetryEvents', () => {
  it('returns an empty result for a missing file', async () => {
    expect(await readTelemetryEvents(join(dir, 'nope.jsonl'))).toEqual({ events: [], skipped: 0 });
  });

  it('reports an unreadable file (a directory) without throwing', async () => {
    const result = await readTelemetryEvents(dir);
    expect(result.events).toEqual([]);
    expect(result.unreadable).toBe(true);
  });

  it('reads events in order', async () => {
    await writeFile(file, lines(finished(1), quota, finished(2)));
    const { events, skipped } = await readTelemetryEvents(file);
    expect(skipped).toBe(0);
    expect(events.map((e) => e.type)).toEqual([
      'execution.finished',
      'quota.observed',
      'execution.finished',
    ]);
  });

  it('skips malformed JSON and lines failing the shape guards', async () => {
    await writeFile(
      file,
      [
        JSON.stringify(finished(1)),
        '{ not json',
        '"a string"',
        '[1,2]',
        'null',
        JSON.stringify({ type: 'execution.finished', at: '2026-10-01T10:00:00Z', record: {} }),
        JSON.stringify({ type: 'quota.observed', at: 'bad', resourceId: 'r' }),
        JSON.stringify({ type: 5, at: '2026-10-01T10:00:00Z' }),
        '',
        JSON.stringify(finished(2)),
      ].join('\n'),
    );
    const { events, skipped } = await readTelemetryEvents(file);
    expect(events).toHaveLength(2);
    expect(skipped).toBe(7);
  });

  it('reads only the tail within maxBytes and drops the first partial line', async () => {
    const all = [finished(1), finished(2), finished(3), finished(4)];
    await writeFile(file, lines(...all));
    const oneLine = Buffer.byteLength(JSON.stringify(finished(1))) + 1;
    // Room for two whole lines plus a fragment of the one before.
    const { events, skipped } = await readTelemetryEvents(file, { maxBytes: oneLine * 2 + 10 });
    expect(skipped).toBe(0);
    expect(events.map((e) => (e.type === 'execution.finished' ? e.record.taskId : ''))).toEqual([
      't3',
      't4',
    ]);
  });

  it('does not drop the first line when the whole file fits', async () => {
    await writeFile(file, lines(finished(1), finished(2)));
    const { events } = await readTelemetryEvents(file, { maxBytes: 1_000_000 });
    expect(events).toHaveLength(2);
  });

  it('keeps the newest maxLines lines', async () => {
    await writeFile(file, lines(finished(1), finished(2), finished(3)));
    const { events } = await readTelemetryEvents(file, { maxLines: 2 });
    expect(events.map((e) => (e.type === 'execution.finished' ? e.record.taskId : ''))).toEqual([
      't2',
      't3',
    ]);
  });

  it('treats content as data: no evaluation, even for hostile values', async () => {
    const hostile = { ...finished(1), record: { ...record(1), taskKind: '__proto__' } };
    await writeFile(file, lines(hostile, { constructor: { prototype: { polluted: true } } }));
    const { events } = await readTelemetryEvents(file);
    expect(events).toHaveLength(1);
    expect(({} as { polluted?: boolean }).polluted).toBeUndefined();
  });
});

describe('shape guards', () => {
  it('accepts well-formed events', () => {
    expect(isExecutionFinished(finished(1))).toBe(true);
    expect(isQuotaObserved(quota)).toBe(true);
  });

  it.each([
    ['not an object', 'x'],
    ['array', []],
    ['wrong type', { ...finished(1), type: 'execution.started' }],
    ['bad timestamp', { ...finished(1), at: 'soon' }],
    ['no record', { type: 'execution.finished', at: '2026-10-01T10:00:00Z' }],
    ['non-numeric latency', { ...finished(1), record: { ...record(1), latencyMs: '5' } }],
    ['no usage', { ...finished(1), record: { ...record(1), usage: undefined } }],
    ['bad startedAt', { ...finished(1), record: { ...record(1), startedAt: 'x' } }],
  ])('isExecutionFinished rejects %s', (_name, value) => {
    expect(isExecutionFinished(value)).toBe(false);
  });

  it.each([
    ['unknown unit', { unit: 'apples' }],
    ['string limit', { limit: '100' }],
    ['infinite used', { used: null }],
    ['bad observedAt', { observedAt: 'x' }],
    ['bad resetsAt', { resetsAt: 'x' }],
    ['non-string label', { label: 7 }],
    ['no provenance', { provenance: undefined }],
  ])('isQuotaObserved rejects %s', (_name, patch) => {
    const bad = { ...quota, observation: { ...quota.observation, ...patch } };
    // `null` is JSON for a non-finite number.
    expect(isQuotaObserved(bad)).toBe(false);
  });

  it('isQuotaObserved rejects a missing resourceId', () => {
    expect(isQuotaObserved({ ...quota, resourceId: undefined })).toBe(false);
  });
});
