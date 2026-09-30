import { mkdtemp, readFile, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { resourceId, type TaskId, type TelemetryEvent, type TelemetrySink } from '@nexar/contracts';
import {
  CompositeTelemetrySink,
  InMemoryTelemetrySink,
  JsonlFileTelemetrySink,
  createJsonLogger,
  noopLogger,
  redact,
} from './index.js';

const fixedClock = () => new Date('2026-01-01T00:00:00.000Z');

function capture(options: Parameters<typeof createJsonLogger>[0] = {}) {
  const lines: string[] = [];
  const logger = createJsonLogger({ clock: fixedClock, ...options, write: (l) => lines.push(l) });
  const parsed = () => lines.map((l) => JSON.parse(l) as Record<string, unknown>);
  return { logger, lines, parsed };
}

function startedEvent(
  n: number,
  resource = 'local-echo',
): Extract<TelemetryEvent, { type: 'execution.started' }> {
  return {
    type: 'execution.started',
    at: fixedClock().toISOString(),
    taskId: `task_${String(n)}` as TaskId,
    resourceId: resourceId(resource),
  };
}

describe('createJsonLogger', () => {
  it('writes one JSON object per line with time, level, msg and fields', () => {
    const { logger, parsed } = capture();
    logger.info('hello', { a: 1 });
    expect(parsed()).toEqual([
      { time: '2026-01-01T00:00:00.000Z', level: 'info', msg: 'hello', a: 1 },
    ]);
  });

  it('filters by level (default info)', () => {
    const { logger, parsed } = capture();
    logger.debug('d');
    logger.info('i');
    logger.warn('w');
    logger.error('e');
    expect(parsed().map((p) => p['msg'])).toEqual(['i', 'w', 'e']);
  });

  it('honors an explicit level', () => {
    const { logger, parsed } = capture({ level: 'error' });
    logger.warn('w');
    logger.error('e');
    expect(parsed().map((p) => p['msg'])).toEqual(['e']);
  });

  it('merges child bindings, with call fields winning', () => {
    const { logger, parsed } = capture({ bindings: { app: 'nexar', x: 1 } });
    logger.child({ task: 't1', x: 2 }).info('m', { x: 3 });
    logger.info('plain');
    expect(parsed()[0]).toMatchObject({ app: 'nexar', task: 't1', x: 3 });
    expect(parsed()[1]).not.toHaveProperty('task');
  });

  it('redacts sensitive fields', () => {
    const { logger, lines } = capture();
    logger.info('m', { apiKey: 'sk-secret', nested: { token: 't' } });
    expect(lines[0]).not.toContain('sk-secret');
    expect(lines[0]).toContain('[REDACTED]');
  });

  it('noopLogger discards output and children stay no-op', () => {
    expect(() => noopLogger.child({ a: 1 }).error('x')).not.toThrow();
  });
});

describe('redact', () => {
  it('keeps token-count usage fields but masks token credentials', () => {
    expect(
      redact({ inputTokens: 5, maxTokens: 3, tokenizer: 'x', accessToken: 'a', token: 'b' }),
    ).toEqual({
      inputTokens: 5,
      maxTokens: 3,
      tokenizer: 'x',
      accessToken: '[REDACTED]',
      token: '[REDACTED]',
    });
  });

  it('masks sensitive keys recursively, including arrays', () => {
    const out = redact({
      API_KEY: 'a',
      'api-key': 'b',
      Authorization: 'c',
      list: [{ password: 'p', keep: 1 }],
      deep: { inner: { clientSecret: 's', cookie: 'c' } },
      credential: { source: 'env' },
      ok: 'fine',
    });
    expect(out).toEqual({
      API_KEY: '[REDACTED]',
      'api-key': '[REDACTED]',
      Authorization: '[REDACTED]',
      list: [{ password: '[REDACTED]', keep: 1 }],
      deep: { inner: { clientSecret: '[REDACTED]', cookie: '[REDACTED]' } },
      credential: '[REDACTED]',
      ok: 'fine',
    });
  });

  it('does not mutate its input', () => {
    const input = { token: 'x', nested: { secret: 'y' } };
    const snapshot = structuredClone(input);
    redact(input);
    expect(input).toEqual(snapshot);
  });

  it('handles cycles', () => {
    const a: Record<string, unknown> = { name: 'a' };
    a['self'] = a;
    const out = redact(a);
    expect(out['self']).toBe('[Circular]');
  });

  it('does not flag shared non-circular references as cycles', () => {
    const shared = { v: 1 };
    const out = redact({ a: shared, b: shared });
    expect(out).toEqual({ a: { v: 1 }, b: { v: 1 } });
  });
});

describe('InMemoryTelemetrySink', () => {
  it('collects events and exposes finished records', () => {
    const sink = new InMemoryTelemetrySink();
    sink.emit(startedEvent(1));
    expect(sink.events).toHaveLength(1);
    expect(sink.records()).toEqual([]);
  });
});

describe('JsonlFileTelemetrySink', () => {
  let dir: string;
  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'nexar-telemetry-'));
  });
  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it('creates parent directories, appends lines and uses mode 0600', async () => {
    const file = join(dir, 'a', 'b', 'telemetry.jsonl');
    const sink = new JsonlFileTelemetrySink(file);
    await sink.emit(startedEvent(1));
    await sink.emit(startedEvent(2));
    const lines = (await readFile(file, 'utf8')).trimEnd().split('\n');
    expect(lines.map((l) => (JSON.parse(l) as { taskId: string }).taskId)).toEqual([
      'task_1',
      'task_2',
    ]);
    expect((await stat(file)).mode & 0o777).toBe(0o600);
  });

  it('keeps concurrent emits intact and ordered', async () => {
    const file = join(dir, 'telemetry.jsonl');
    const sink = new JsonlFileTelemetrySink(file);
    const pad = 'x'.repeat(100);
    await Promise.all(Array.from({ length: 50 }, (_, i) => sink.emit(startedEvent(i, pad))));
    const lines = (await readFile(file, 'utf8')).trimEnd().split('\n');
    expect(lines).toHaveLength(50);
    expect(lines.map((l) => (JSON.parse(l) as { taskId: string }).taskId)).toEqual(
      Array.from({ length: 50 }, (_, i) => `task_${String(i)}`),
    );
  });

  it('recovers after a failed write', async () => {
    const file = join(dir, 'f', 'telemetry.jsonl');
    const sink = new JsonlFileTelemetrySink(join(dir, 'blocker', 'x', 'y.jsonl'));
    // Make the parent path impossible: a file where a directory is needed.
    await new JsonlFileTelemetrySink(join(dir, 'blocker')).emit(startedEvent(0));
    await expect(sink.emit(startedEvent(1))).rejects.toBeDefined();
    await expect(sink.emit(startedEvent(2))).rejects.toBeDefined();
    await expect(new JsonlFileTelemetrySink(file).emit(startedEvent(3))).resolves.toBeUndefined();
  });
});

describe('CompositeTelemetrySink', () => {
  it('fans out and isolates failing sinks, reporting via onError', async () => {
    const good = new InMemoryTelemetrySink();
    const syncBad: TelemetrySink = {
      emit: () => {
        throw new Error('sync boom');
      },
    };
    const asyncBad: TelemetrySink = { emit: () => Promise.reject(new Error('async boom')) };
    const errors: string[] = [];
    const composite = new CompositeTelemetrySink([syncBad, asyncBad, good], (e) =>
      errors.push((e as Error).message),
    );
    await composite.emit(startedEvent(1));
    expect(good.events).toHaveLength(1);
    expect(errors.sort()).toEqual(['async boom', 'sync boom']);
  });

  it('swallows errors when no onError is given', async () => {
    const bad: TelemetrySink = { emit: () => Promise.reject(new Error('x')) };
    await expect(new CompositeTelemetrySink([bad]).emit(startedEvent(1))).resolves.toBeUndefined();
  });
});
