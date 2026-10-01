import type {
  ExecutionRecord,
  Measured,
  QuotaObservation,
  QuotaWindow,
  ResourceId,
} from '@nexar/contracts';
import { isExecutionFinished, isQuotaObserved, readTelemetryEvents } from './reader.js';

/**
 * Structurally identical to `AllowanceRule` and `QuotaSource` in `@nexar/resource-controller`
 * (which this package must not depend on); the CLI hands the instance to the controller.
 */
export interface QuotaAllowance {
  readonly resourceId: ResourceId;
  readonly unit: 'requests' | 'tokens' | 'usd';
  readonly limit: number;
  readonly window: QuotaWindow;
  readonly label?: string;
}

export interface TelemetryQuotaSourceOptions {
  readonly path: string;
  readonly allowances: readonly QuotaAllowance[];
}

const DAY_MS = 24 * 60 * 60 * 1000;
const HOUR_MS = 60 * 60 * 1000;
/** Vendor-reported observations older than this are not read back at all. */
const VENDOR_LOOKBACK_MS = 7 * DAY_MS;

interface WindowBounds {
  readonly start: number;
  /** Absent for rolling windows. */
  readonly end?: number;
}

/** UTC window containing `now`: daily midnight, weekly Monday 00:00, monthly the 1st, or rolling. */
export function windowBounds(window: QuotaWindow, now: Date): WindowBounds {
  const t = now.getTime();
  if (typeof window === 'object') return { start: t - window.hours * HOUR_MS };
  const y = now.getUTCFullYear();
  const m = now.getUTCMonth();
  const d = now.getUTCDate();
  switch (window) {
    case 'daily': {
      const start = Date.UTC(y, m, d);
      return { start, end: start + DAY_MS };
    }
    case 'weekly': {
      const sinceMonday = (now.getUTCDay() + 6) % 7;
      const start = Date.UTC(y, m, d - sinceMonday);
      return { start, end: Date.UTC(y, m, d - sinceMonday + 7) };
    }
    case 'monthly':
      return { start: Date.UTC(y, m, 1), end: Date.UTC(y, m + 1, 1) };
  }
}

function usable(m: Measured<number>): number | undefined {
  return m.status === 'unavailable' || !Number.isFinite(m.value) || m.value < 0
    ? undefined
    : m.value;
}

interface Consumption {
  readonly used: number;
  readonly unaccounted: number;
}

function consume(unit: QuotaAllowance['unit'], records: readonly ExecutionRecord[]): Consumption {
  let used = 0;
  let unaccounted = 0;
  for (const r of records) {
    if (unit === 'requests') {
      used += 1;
    } else if (unit === 'tokens') {
      const input = usable(r.usage.inputTokens);
      const output = usable(r.usage.outputTokens);
      if (input === undefined || output === undefined) unaccounted += 1;
      else used += input + output;
    } else {
      const cost = usable(r.usage.costUsd);
      if (cost === undefined) unaccounted += 1;
      else used += cost;
    }
  }
  return { used, unaccounted };
}

function isVendorOnly(o: QuotaObservation): boolean {
  const vendor = (s: string | undefined): boolean => s === undefined || s.startsWith('vendor-');
  return vendor(o.provenance.limit) && vendor(o.provenance.usage);
}

/**
 * Quota observations from Nexar's own telemetry (ADR-020 §4): owner-declared allowances consumed
 * by measured `execution.finished` usage, plus the latest vendor-reported `quota.observed` signals.
 * The file is read bounded and treated as untrusted; a broken file means "no observations".
 */
export class TelemetryQuotaSource {
  private readonly path: string;
  private readonly allowances: readonly QuotaAllowance[];

  constructor(options: TelemetryQuotaSourceOptions) {
    this.path = options.path;
    this.allowances = options.allowances;
  }

  async observe(
    ids: readonly ResourceId[],
    now: Date,
  ): Promise<ReadonlyMap<ResourceId, readonly QuotaObservation[]>> {
    const result = new Map<ResourceId, QuotaObservation[]>();
    try {
      const { events, unreadable } = await readTelemetryEvents(this.path);
      // Unreadable accounting must not look like zero consumption.
      if (unreadable === true) return new Map();
      const records = events.filter(isExecutionFinished).map((e) => e.record);
      const nowMs = now.getTime();
      const observedAt = now.toISOString();

      for (const id of ids) {
        const observations: QuotaObservation[] = [];

        for (const allowance of this.allowances) {
          if (allowance.resourceId !== id) continue;
          if (!Number.isFinite(allowance.limit) || allowance.limit <= 0) continue;
          const bounds = windowBounds(allowance.window, now);
          const inWindow = records.filter((r) => {
            if (r.resourceId !== id) return false;
            const started = Date.parse(r.startedAt);
            return (
              started >= bounds.start &&
              (bounds.end === undefined ? started <= nowMs : started < bounds.end)
            );
          });
          const { used, unaccounted } = consume(allowance.unit, inWindow);
          observations.push({
            unit: allowance.unit,
            limit: allowance.limit,
            used,
            remaining: Math.max(0, allowance.limit - used),
            window: allowance.window,
            ...(bounds.end === undefined ? {} : { resetsAt: new Date(bounds.end).toISOString() }),
            observedAt,
            provenance: { limit: 'owner-declared', usage: 'nexar-accounting' },
            ...(unaccounted > 0 ? { unaccountedRuns: unaccounted } : {}),
            ...(allowance.label === undefined ? {} : { label: allowance.label }),
          });
        }

        // Latest vendor signal per label inside the lookback; the policy judges freshness.
        const latest = new Map<string, { at: number; observation: QuotaObservation }>();
        for (const e of events) {
          if (!isQuotaObserved(e) || e.resourceId !== id) continue;
          const at = Date.parse(e.at);
          // Only vendor-reported figures: telemetry cannot vouch for owner or accounting data.
          if (at < nowMs - VENDOR_LOOKBACK_MS || at > nowMs || !isVendorOnly(e.observation)) {
            continue;
          }
          const key = e.observation.label ?? '';
          const prior = latest.get(key);
          if (prior === undefined || at >= prior.at) {
            latest.set(key, { at, observation: e.observation });
          }
        }
        for (const { observation } of latest.values()) observations.push(observation);

        if (observations.length > 0) result.set(id, observations);
      }
    } catch {
      return new Map();
    }
    return result;
  }
}
