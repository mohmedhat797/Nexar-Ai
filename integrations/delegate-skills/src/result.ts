import { constants } from 'node:fs';
import { open } from 'node:fs/promises';
import { measured, unavailable } from '@nexar/contracts';
import type { Measured, NexarErrorCode, UsageReport } from '@nexar/contracts';

export const RESULT_SCHEMA = 'delegate-relay.result.v1';
export const MAX_RESULT_BYTES = 1024 * 1024;
export const MAX_EVENTS_BYTES = 32 * 1024 * 1024;

export type RelayStatus = 'completed' | 'failed' | 'timeout' | 'aborted' | 'codex_unavailable';

/** The fields of `result.json` Nexar uses, after type validation. Everything else is ignored. */
export interface RelayResult {
  readonly status: RelayStatus;
  readonly finalMessage: string;
  readonly error?: string;
  readonly stderrTail?: string;
  readonly codexVersion?: string;
  readonly model?: string;
  /** Number of files the relay reported; names are never kept. */
  readonly touchedCount?: number;
}

type Json = Readonly<Record<string, unknown>>;

function isRecord(v: unknown): v is Json {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

function str(v: unknown): string | undefined {
  return typeof v === 'string' && v !== '' ? v : undefined;
}

const STATUSES: readonly string[] = [
  'completed',
  'failed',
  'timeout',
  'aborted',
  'codex_unavailable',
];

/**
 * Reads a file the sandboxed process wrote, bounded and without following symlinks, so a hostile
 * out dir cannot make Nexar read an arbitrary host file. Undefined when missing, not a regular
 * file, or larger than `maxBytes`.
 */
export async function readBoundedFile(path: string, maxBytes: number): Promise<string | undefined> {
  let handle;
  try {
    handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
    const info = await handle.stat();
    if (!info.isFile() || info.size > maxBytes) return undefined;
    return await handle.readFile({ encoding: 'utf8' });
  } catch {
    return undefined;
  } finally {
    await handle?.close();
  }
}

/** Parses untrusted `result.json` text; undefined when it is not a valid v1 result. */
export function parseRelayResult(text: string): RelayResult | undefined {
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch {
    return undefined;
  }
  if (!isRecord(raw) || raw['schema'] !== RESULT_SCHEMA) return undefined;
  const status = raw['status'];
  if (typeof status !== 'string' || !STATUSES.includes(status)) return undefined;
  const finalMessage = raw['finalMessage'];
  if (finalMessage !== undefined && finalMessage !== null && typeof finalMessage !== 'string') {
    return undefined;
  }
  const error = str(raw['error']);
  const stderrTail = str(raw['stderrTail']);
  const codexVersion = str(raw['codexVersion']);
  const model = str(raw['model']);
  const touched = raw['touchedFiles'];
  return {
    status: status as RelayStatus,
    finalMessage: finalMessage ?? '',
    ...(error !== undefined ? { error } : {}),
    ...(stderrTail !== undefined ? { stderrTail } : {}),
    ...(codexVersion !== undefined ? { codexVersion } : {}),
    ...(model !== undefined ? { model } : {}),
    ...(Array.isArray(touched) ? { touchedCount: touched.length } : {}),
  };
}

/** Raw counters from the last `turn.completed.usage`; absent fields are undefined. */
interface Counters {
  readonly input?: number;
  readonly cached?: number;
  readonly cacheWrite?: number;
  readonly output?: number;
  readonly reasoning?: number;
}

function count(v: unknown): number | undefined {
  return typeof v === 'number' && Number.isFinite(v) && v >= 0 ? v : undefined;
}

function counters(v: unknown): Counters | undefined {
  if (!isRecord(v)) return undefined;
  const out: { -readonly [K in keyof Counters]: Counters[K] } = {};
  const input = count(v['input_tokens']);
  if (input !== undefined) out.input = input;
  const cached = count(v['cached_input_tokens']);
  if (cached !== undefined) out.cached = cached;
  const write = count(v['cache_write_input_tokens']);
  if (write !== undefined) out.cacheWrite = write;
  const output = count(v['output_tokens']);
  if (output !== undefined) out.output = output;
  const reasoning = count(v['reasoning_output_tokens']);
  if (reasoning !== undefined) out.reasoning = reasoning;
  return out;
}

const NOT_REPORTED = 'not reported by codex';
const SUBSCRIPTION = 'subscription; not reported by codex';

function reported(n: number | undefined): Measured<number> {
  return n === undefined ? unavailable(NOT_REPORTED) : measured(n);
}

/**
 * Usage from the relay's `events.jsonl` (Codex `--json` lines): the last `turn.completed.usage`.
 * Codex emits all-zero usage when it does not know the real figures, so missing events or a
 * all-zero/absent usage is `unavailable`, never a measured 0. Cost is always unavailable.
 */
export function usageFromEvents(text: string | undefined): UsageReport {
  let last: Counters | undefined;
  let turns = 0;
  for (const line of (text ?? '').split('\n')) {
    const trimmed = line.trim();
    if (!trimmed.startsWith('{')) continue;
    let event: unknown;
    try {
      event = JSON.parse(trimmed);
    } catch {
      continue;
    }
    if (!isRecord(event) || event['type'] !== 'turn.completed') continue;
    turns += 1;
    last = counters(event['usage']);
  }
  const turnsReport = turns > 0 ? measured(turns) : unavailable<number>(NOT_REPORTED);
  const total =
    (last?.input ?? 0) +
    (last?.cached ?? 0) +
    (last?.cacheWrite ?? 0) +
    (last?.output ?? 0) +
    (last?.reasoning ?? 0);
  if (last === undefined || total === 0) {
    return {
      inputTokens: unavailable(NOT_REPORTED),
      outputTokens: unavailable(NOT_REPORTED),
      costUsd: unavailable(SUBSCRIPTION),
      turns: turnsReport,
    };
  }
  const output =
    last.output === undefined && last.reasoning === undefined
      ? undefined
      : (last.output ?? 0) + (last.reasoning ?? 0);
  return {
    inputTokens: reported(last.input),
    outputTokens: reported(output),
    cacheReadTokens: reported(last.cached),
    cacheWriteTokens: reported(last.cacheWrite),
    costUsd: unavailable(SUBSCRIPTION),
    turns: turnsReport,
  };
}

const AUTH_FAILURE = /401|unauthori[sz]ed|not logged in|login|auth/i;
const QUOTA_FAILURE = /429|rate limit|usage limit|quota/i;

/** Classifies a failed relay run's evidence into a Nexar error code. Auth is checked first. */
export function classifyFailure(message: string): NexarErrorCode {
  if (AUTH_FAILURE.test(message)) return 'AUTH_REQUIRED';
  if (QUOTA_FAILURE.test(message)) return 'QUOTA_EXHAUSTED';
  return 'PROVIDER_ERROR';
}
