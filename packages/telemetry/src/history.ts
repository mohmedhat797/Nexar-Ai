import type {
  ExecutionAggregate,
  ExecutionRecord,
  NexarErrorCode,
  RoutingHistory,
} from '@nexar/contracts';
import { isExecutionFinished, readTelemetryEvents, type ReadTelemetryOptions } from './reader.js';

export interface ReadExecutionHistoryOptions {
  readonly now: Date;
  readonly windowDays: number;
  readonly read?: ReadTelemetryOptions;
}

const DAY_MS = 24 * 60 * 60 * 1000;
const MAX_LATENCY_MS = DAY_MS;

/** Failures that count against the resource (ADR-020 §7). */
const RESOURCE_FAULTS: ReadonlySet<string> = new Set<NexarErrorCode>([
  'PROVIDER_ERROR',
  'EXECUTION_TIMEOUT',
  'RESOURCE_UNAVAILABLE',
  'QUOTA_EXHAUSTED',
  'INTEGRATION_UNAVAILABLE',
  'AUTH_REQUIRED',
  'INTERNAL_ERROR',
]);

type Classification = 'success' | 'fault' | 'timeout' | 'excluded';

/**
 * Caller and policy outcomes (validation, policy, configuration, approval, sandbox, cancellation)
 * and any unknown code are excluded: they say nothing about the resource.
 */
function classify(record: ExecutionRecord): Classification {
  if (record.outcome === 'succeeded') return 'success';
  if (record.outcome === 'timed-out') return 'timeout';
  if (record.outcome !== 'failed') return 'excluded';
  const code: unknown = record.error?.code;
  if (typeof code !== 'string' || !RESOURCE_FAULTS.has(code)) return 'excluded';
  return code === 'EXECUTION_TIMEOUT' ? 'timeout' : 'fault';
}

interface Accumulator {
  successes: number;
  resourceFaults: number;
  timeouts: number;
  latencies: number[];
  costTotal: number;
  costSamples: number;
}

/** Nearest-rank percentile over an ascending list. */
function percentile(sorted: readonly number[], p: number): number {
  return sorted[Math.max(0, Math.ceil(p * sorted.length) - 1)] as number;
}

function finish(a: Accumulator): ExecutionAggregate {
  const sorted = [...a.latencies].sort((x, y) => x - y);
  return {
    samples: a.successes + a.resourceFaults,
    successes: a.successes,
    resourceFaults: a.resourceFaults,
    timeouts: a.timeouts,
    ...(sorted.length === 0
      ? {}
      : { p50LatencyMs: percentile(sorted, 0.5), p95LatencyMs: percentile(sorted, 0.95) }),
    ...(a.costSamples === 0 ? {} : { meanCostUsd: a.costTotal / a.costSamples }),
    costSamples: a.costSamples,
  };
}

function usableCost(record: ExecutionRecord): number | undefined {
  const cost: unknown = (record.usage as { costUsd?: unknown }).costUsd;
  if (typeof cost !== 'object' || cost === null) return undefined;
  const { status, value } = cost as { status?: unknown; value?: unknown };
  if (status !== 'measured' && status !== 'estimated') return undefined;
  return typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : undefined;
}

/**
 * Execution aggregates per (resource, task kind) from `execution.finished` records inside the
 * window (ADR-020 §7). The file is untrusted: reads are bounded, shapes guarded, numbers clamped,
 * nothing evaluated. Lane history is left empty (engineering readers provide it).
 */
export async function readExecutionHistory(
  path: string,
  options: ReadExecutionHistoryOptions,
): Promise<RoutingHistory> {
  const nowMs = options.now.getTime();
  const windowMs = Number.isFinite(options.windowDays)
    ? Math.max(0, options.windowDays) * DAY_MS
    : 0;
  const startMs = nowMs - windowMs;
  const { events, skipped } = await readTelemetryEvents(path, options.read);

  // Maps, not objects: ids and kinds come from an untrusted file (`__proto__` must stay data).
  const groups = new Map<string, Map<string, Accumulator>>();
  for (const event of events) {
    if (!isExecutionFinished(event)) continue;
    const record = event.record;
    const started = Date.parse(record.startedAt);
    if (!(started >= startMs && started <= nowMs)) continue;
    const kind = classify(record);
    if (kind === 'excluded') continue;

    let byKind = groups.get(record.resourceId);
    if (byKind === undefined)
      groups.set(record.resourceId, (byKind = new Map<string, Accumulator>()));
    let acc = byKind.get(record.taskKind);
    if (acc === undefined) {
      byKind.set(
        record.taskKind,
        (acc = {
          successes: 0,
          resourceFaults: 0,
          timeouts: 0,
          latencies: [],
          costTotal: 0,
          costSamples: 0,
        }),
      );
    }
    if (kind === 'success') {
      acc.successes += 1;
      if (Number.isFinite(record.latencyMs)) {
        acc.latencies.push(Math.min(MAX_LATENCY_MS, Math.max(0, record.latencyMs)));
      }
    } else {
      acc.resourceFaults += 1;
      if (kind === 'timeout') acc.timeouts += 1;
    }
    const cost = usableCost(record);
    if (cost !== undefined) {
      acc.costTotal += cost;
      acc.costSamples += 1;
    }
  }

  const executions = Object.fromEntries(
    [...groups].map(([id, byKind]) => [
      id,
      Object.fromEntries([...byKind].map(([kind, acc]) => [kind, finish(acc)])),
    ]),
  );
  return {
    windowStart: new Date(startMs).toISOString(),
    windowEnd: options.now.toISOString(),
    executions,
    lanes: {},
    skipped,
  };
}

export interface LanesResult {
  readonly lanes: RoutingHistory['lanes'];
  readonly skipped: number;
}

export interface TelemetryHistorySourceOptions {
  /** Telemetry file; without one there is no execution history (lanes may still be read). */
  readonly path?: string;
  readonly windowDays: number;
  readonly read?: ReadTelemetryOptions;
  /** Engineering lane aggregates, read elsewhere; a failing provider means no lane history. */
  readonly lanes?: (now: Date) => Promise<LanesResult>;
}

/**
 * Structurally implements `HistorySource` of `@nexar/resource-controller` (which this package must
 * not depend on). A broken file or provider yields empty history, never a throw.
 */
export class TelemetryHistorySource {
  constructor(private readonly options: TelemetryHistorySourceOptions) {}

  async read(now: Date): Promise<RoutingHistory> {
    const { path, windowDays, read, lanes } = this.options;
    let history: RoutingHistory;
    try {
      if (path === undefined) throw new Error('no telemetry file');
      history = await readExecutionHistory(path, {
        now,
        windowDays,
        ...(read === undefined ? {} : { read }),
      });
    } catch {
      const windowMs = (Number.isFinite(windowDays) ? Math.max(0, windowDays) : 0) * DAY_MS;
      history = {
        windowStart: new Date(now.getTime() - windowMs).toISOString(),
        windowEnd: now.toISOString(),
        executions: {},
        lanes: {},
        skipped: 0,
      };
    }
    if (lanes === undefined) return history;
    try {
      const result = await lanes(now);
      return { ...history, lanes: result.lanes, skipped: history.skipped + result.skipped };
    } catch {
      return history;
    }
  }
}
