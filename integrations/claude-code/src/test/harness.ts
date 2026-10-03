import { mkdtempSync, existsSync, readFileSync } from 'node:fs';
import { rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { taskId } from '@nexar/contracts';
import type { ExecutionContext, ExecutionEvent, Logger, NexarTask } from '@nexar/contracts';
import { ClaudeCodeExecutionAdapter } from '../adapter.js';
import type { ClaudeCodeAdapterOptions } from '../adapter.js';

export const FAKE_CLAUDE = fileURLToPath(new URL('./fake-claude.mjs', import.meta.url));

export interface FakeInvocation {
  readonly argv: readonly string[];
  readonly stdin: string;
  readonly cwd: string;
  readonly pid: number;
  readonly envNames: readonly string[];
  readonly env: Readonly<Record<string, string | undefined>>;
}

export const silentLogger: Logger = {
  debug: () => undefined,
  info: () => undefined,
  warn: () => undefined,
  error: () => undefined,
  child: () => silentLogger,
};

export function task(overrides: Partial<NexarTask['input']> = {}): NexarTask {
  return {
    id: taskId('t-1'),
    kind: 'general',
    input: { prompt: 'PROMPT-SENTINEL', ...overrides },
    requirements: { capabilities: ['text-generation'] },
    origin: { source: 'test' },
    createdAt: '2026-01-01T00:00:00.000Z',
  };
}

export interface Harness {
  readonly adapter: ClaudeCodeExecutionAdapter;
  readonly events: ExecutionEvent[];
  /** The file fake-claude appends invocations to (a launcher must forward it as `FAKE_CLAUDE_RECORD`). */
  readonly recordFile: string;
  context(signal?: AbortSignal): ExecutionContext;
  /** Every recorded fake-claude invocation so far. */
  invocations(): FakeInvocation[];
  cleanup(): Promise<void>;
}

/** An adapter wired to the fake binary; `env` is merged over the fake's control variables. */
export function harness(
  env: NodeJS.ProcessEnv = {},
  options: Omit<ClaudeCodeAdapterOptions, 'binary' | 'env'> = {},
): Harness {
  const dir = mkdtempSync(join(tmpdir(), 'nexar-fake-claude-'));
  const record = join(dir, 'record.json');
  const events: ExecutionEvent[] = [];
  const adapter = new ClaudeCodeExecutionAdapter({
    binary: { command: process.execPath, args: [FAKE_CLAUDE] },
    env: { PATH: process.env['PATH'], FAKE_CLAUDE_RECORD: record, ...env },
    ...options,
  });
  return {
    adapter,
    events,
    recordFile: record,
    context: (signal = new AbortController().signal) => ({
      signal,
      logger: silentLogger,
      onEvent: (e) => events.push(e),
    }),
    invocations: () =>
      existsSync(record) ? (JSON.parse(readFileSync(record, 'utf8')) as FakeInvocation[]) : [],
    // Async rm honours the bounded retry (rmSync does not): a killed fake runtime's process can
    // hold its working directory briefly on Windows (EBUSY/EPERM) after the outcome settles.
    cleanup: () => rm(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 }),
  };
}

export async function waitFor<T>(fn: () => T | undefined, timeoutMs = 5000): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const v = fn();
    if (v !== undefined) return v;
    if (Date.now() > deadline) throw new Error('waitFor timed out');
    await new Promise((r) => setTimeout(r, 20));
  }
}

export function isAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}
