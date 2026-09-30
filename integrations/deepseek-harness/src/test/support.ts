import { mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { taskId } from '@nexar/contracts';
import type { ExecutionContext, ExecutionEvent, Logger, NexarTask } from '@nexar/contracts';
import type { BinarySpec } from '../runtime-process.js';

export const FAKE_DSH_PATH = fileURLToPath(new URL('./fake-dsh.mjs', import.meta.url));

export interface FakeRecord {
  argv: string[];
  envKeys: string[];
  dshHome?: string;
  cwd: string;
  overlayPath?: string;
  overlay?: string | null;
  requests: { method: string; params?: Record<string, unknown> }[];
}

export function makeTempDir(prefix = 'nexar-dsh-'): string {
  return mkdtempSync(join(process.env.TMPDIR ?? tmpdir(), prefix));
}

/** Launch spec for the fake runtime; settings travel as argv because the child env is allowlisted. */
export function fakeBinary(settings: Record<string, string> = {}): BinarySpec {
  return {
    command: process.execPath,
    args: [FAKE_DSH_PATH, ...Object.entries(settings).map(([k, v]) => `--fake-${k}=${v}`)],
  };
}

export function readRecord(path: string): FakeRecord {
  return JSON.parse(readFileSync(path, 'utf8')) as FakeRecord;
}

export function makeTask(
  overrides: Partial<NexarTask> & { workingDirectory?: string } = {},
): NexarTask {
  const { workingDirectory, ...rest } = overrides;
  return {
    id: taskId('t1'),
    kind: 'general',
    input: {
      prompt: 'SECRET-PROMPT-TEXT say hi',
      ...(workingDirectory === undefined ? {} : { workingDirectory }),
    },
    requirements: { capabilities: ['text-generation'] },
    origin: { source: 'test' },
    createdAt: '2026-01-01T00:00:00.000Z',
    ...rest,
  };
}

export interface LogLine {
  level: string;
  msg: string;
  fields: unknown;
}

export function makeLogger(lines: LogLine[] = []): Logger {
  const logger: Logger = {
    debug: (msg, fields) => void lines.push({ level: 'debug', msg, fields }),
    info: (msg, fields) => void lines.push({ level: 'info', msg, fields }),
    warn: (msg, fields) => void lines.push({ level: 'warn', msg, fields }),
    error: (msg, fields) => void lines.push({ level: 'error', msg, fields }),
    child: () => logger,
  };
  return logger;
}

export function makeContext(
  overrides: { signal?: AbortSignal; events?: ExecutionEvent[]; logs?: LogLine[] } = {},
): ExecutionContext {
  const events = overrides.events;
  return {
    signal: overrides.signal ?? new AbortController().signal,
    logger: makeLogger(overrides.logs),
    ...(events === undefined ? {} : { onEvent: (e: ExecutionEvent) => void events.push(e) }),
  };
}
