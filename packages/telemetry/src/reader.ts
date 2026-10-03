import { open } from 'node:fs/promises';
import type { TelemetryEvent } from '@nexar/contracts';

export interface ReadTelemetryOptions {
  /** Only the last `maxBytes` of the file are read. Default 8 MiB. */
  readonly maxBytes?: number;
  /** At most this many (newest) lines are considered. Default 50 000. */
  readonly maxLines?: number;
}

export interface TelemetryReadResult {
  readonly events: TelemetryEvent[];
  /** Lines that were malformed or failed the shape guards. */
  readonly skipped: number;
  /** Set when the file exists but could not be read (a missing file is simply empty). */
  readonly unreadable?: true;
}

const DEFAULT_MAX_BYTES = 8 * 1024 * 1024;
const DEFAULT_MAX_LINES = 50_000;

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

function isIso(v: unknown): v is string {
  return typeof v === 'string' && !Number.isNaN(Date.parse(v));
}

/** Light runtime shape guard for `execution.finished`; the file is untrusted input. */
export function isExecutionFinished(
  e: unknown,
): e is Extract<TelemetryEvent, { type: 'execution.finished' }> {
  if (!isRecord(e) || e['type'] !== 'execution.finished' || !isIso(e['at'])) return false;
  const r = e['record'];
  return (
    isRecord(r) &&
    typeof r['resourceId'] === 'string' &&
    typeof r['taskKind'] === 'string' &&
    typeof r['outcome'] === 'string' &&
    isIso(r['startedAt']) &&
    isIso(r['endedAt']) &&
    typeof r['latencyMs'] === 'number' &&
    isRecord(r['usage'])
  );
}

const UNITS: ReadonlySet<unknown> = new Set(['requests', 'tokens', 'usd', 'percent']);

function optionalNumber(v: unknown): boolean {
  return v === undefined || (typeof v === 'number' && Number.isFinite(v));
}

/** Light runtime shape guard for `quota.observed`. */
export function isQuotaObserved(
  e: unknown,
): e is Extract<TelemetryEvent, { type: 'quota.observed' }> {
  if (!isRecord(e) || e['type'] !== 'quota.observed' || !isIso(e['at'])) return false;
  if (typeof e['resourceId'] !== 'string') return false;
  const o = e['observation'];
  return (
    isRecord(o) &&
    UNITS.has(o['unit']) &&
    optionalNumber(o['limit']) &&
    optionalNumber(o['used']) &&
    optionalNumber(o['remaining']) &&
    isIso(o['observedAt']) &&
    (o['resetsAt'] === undefined || isIso(o['resetsAt'])) &&
    (o['label'] === undefined || typeof o['label'] === 'string') &&
    isRecord(o['provenance'])
  );
}

function isKnownEvent(e: unknown): e is TelemetryEvent {
  if (!isRecord(e) || typeof e['type'] !== 'string' || !isIso(e['at'])) return false;
  switch (e['type']) {
    case 'execution.finished':
      return isExecutionFinished(e);
    case 'quota.observed':
      return isQuotaObserved(e);
    default:
      // Other event types pass with only a type and a timestamp; consumers guard the fields they use.
      return true;
  }
}

/**
 * Reads the newest part of a JSONL telemetry file. Bounded (bytes and lines), tolerant (a missing
 * or unreadable file yields an empty result) and inert: lines are parsed as data, never evaluated.
 */
export async function readTelemetryEvents(
  path: string,
  options: ReadTelemetryOptions = {},
): Promise<TelemetryReadResult> {
  const maxBytes = Math.max(1, Math.floor(options.maxBytes ?? DEFAULT_MAX_BYTES));
  const maxLines = Math.max(1, Math.floor(options.maxLines ?? DEFAULT_MAX_LINES));
  let text: string;
  let truncatedHead: boolean;
  try {
    const handle = await open(path, 'r');
    try {
      const info = await handle.stat();
      // Windows can open a directory and report size 0; it is unreadable, never an empty log.
      if (!info.isFile()) return { events: [], skipped: 0, unreadable: true };
      const { size } = info;
      const length = Math.min(size, maxBytes);
      const buffer = Buffer.alloc(length);
      let read = 0;
      while (read < length) {
        const { bytesRead } = await handle.read(buffer, read, length - read, size - length + read);
        if (bytesRead === 0) break;
        read += bytesRead;
      }
      truncatedHead = size > maxBytes;
      text = buffer.subarray(0, read).toString('utf8');
    } finally {
      await handle.close();
    }
  } catch (error) {
    const missing = (error as { code?: unknown } | null)?.code === 'ENOENT';
    return missing ? { events: [], skipped: 0 } : { events: [], skipped: 0, unreadable: true };
  }

  let lines = text.split('\n');
  // The first line of a tail read may be cut in the middle; drop it.
  if (truncatedHead) lines = lines.slice(1);
  lines = lines.filter((l) => l.trim() !== '');
  if (lines.length > maxLines) lines = lines.slice(lines.length - maxLines);

  const events: TelemetryEvent[] = [];
  let skipped = 0;
  for (const line of lines) {
    let parsed: unknown;
    try {
      parsed = JSON.parse(line);
    } catch {
      skipped += 1;
      continue;
    }
    if (isKnownEvent(parsed)) events.push(parsed);
    else skipped += 1;
  }
  return { events, skipped };
}
