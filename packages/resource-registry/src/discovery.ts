import {
  NexarError,
  type DiscoverySource,
  type DiscoverySourceReport,
  type ResourceDescriptor,
} from '@nexar/contracts';

export interface DiscoveredBatch {
  readonly source: string;
  readonly descriptors: readonly ResourceDescriptor[];
}

export interface MergeOptions {
  /** Discovered ids the owner does not want. Configured resources are never excluded. */
  readonly excludeIds?: readonly string[];
}

export interface MergeResult {
  readonly resources: readonly ResourceDescriptor[];
  /** Discovered descriptors dropped because config or another source already holds the id. */
  readonly collisions: number;
}

const CONFIGURED = 'configured';

function byText(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

/**
 * Pure, deterministic merge (ADR-020 §9): configured first in config order, then discovered by
 * id. Config wins on an id collision; across sources the lexicographically first source id wins.
 */
export function mergeDiscovered(
  configured: readonly ResourceDescriptor[],
  discovered: readonly DiscoveredBatch[],
  options: MergeOptions = {},
): MergeResult {
  const excluded = new Set<string>(options.excludeIds ?? []);
  const taken = new Set<string>(configured.map((d) => d.id));
  const resources = configured.map((d) =>
    d.provenance === undefined ? { ...d, provenance: CONFIGURED } : d,
  );
  const found: ResourceDescriptor[] = [];
  let collisions = 0;
  for (const batch of [...discovered].sort((a, b) => byText(a.source, b.source))) {
    for (const d of batch.descriptors) {
      if (excluded.has(d.id)) continue;
      if (taken.has(d.id)) {
        collisions += 1;
        continue;
      }
      taken.add(d.id);
      found.push({ ...d, provenance: `discovered:${batch.source}` });
    }
  }
  found.sort((a, b) => byText(a.id, b.id));
  return { resources: [...resources, ...found], collisions };
}

export interface DiscoveryServiceOptions {
  readonly sources: readonly DiscoverySource[];
  /** Cached results are reused until `now - at >= refreshIntervalMs`. */
  readonly refreshIntervalMs: number;
  readonly clock?: () => Date;
  /** Per source; default 3000. */
  readonly timeoutMs?: number;
  /** Source ids that are switched off: reported `disabled`, never run. */
  readonly disabled?: readonly string[];
}

export interface DiscoveryResult {
  readonly batches: readonly DiscoveredBatch[];
  readonly reports: readonly DiscoverySourceReport[];
}

const DEFAULT_TIMEOUT_MS = 3000;

/** Runs discovery sources in isolation and caches the outcome with an injected clock. */
export class DiscoveryService {
  private readonly sources: readonly DiscoverySource[];
  private readonly clock: () => Date;
  private readonly refreshIntervalMs: number;
  private readonly timeoutMs: number;
  private readonly disabled: ReadonlySet<string>;
  private cached: { readonly at: number; readonly result: DiscoveryResult } | undefined;
  private inflight: Promise<DiscoveryResult> | undefined;

  constructor(options: DiscoveryServiceOptions) {
    this.sources = [...options.sources].sort((a, b) => byText(a.id, b.id));
    this.clock = options.clock ?? (() => new Date());
    this.refreshIntervalMs = options.refreshIntervalMs;
    this.timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
    this.disabled = new Set(options.disabled ?? []);
  }

  /** Cached until the refresh interval has elapsed. Never throws. */
  discover(): Promise<DiscoveryResult> {
    const cached = this.cached;
    if (cached !== undefined && this.clock().getTime() - cached.at < this.refreshIntervalMs) {
      return Promise.resolve(cached.result);
    }
    return this.refresh();
  }

  /** Forces a run. Never throws; concurrent callers share one run. */
  refresh(): Promise<DiscoveryResult> {
    this.inflight ??= this.run().finally(() => {
      this.inflight = undefined;
    });
    return this.inflight;
  }

  /** Reports of the last run (empty before the first). */
  get reports(): readonly DiscoverySourceReport[] {
    return this.cached?.result.reports ?? [];
  }

  private async run(): Promise<DiscoveryResult> {
    const now = this.clock();
    const outcomes = await Promise.all(this.sources.map((s) => this.runSource(s, now)));
    const result: DiscoveryResult = {
      batches: outcomes.flatMap((o) => (o.batch === undefined ? [] : [o.batch])),
      reports: outcomes.map((o) => o.report),
    };
    this.cached = { at: now.getTime(), result };
    return result;
  }

  private async runSource(
    source: DiscoverySource,
    now: Date,
  ): Promise<{ readonly batch?: DiscoveredBatch; readonly report: DiscoverySourceReport }> {
    const at = now.toISOString();
    if (this.disabled.has(source.id)) {
      return { report: { source: source.id, status: 'disabled', count: 0, at } };
    }
    const signal = AbortSignal.timeout(this.timeoutMs);
    // A source that ignores its signal still cannot hold up the others.
    const timedOut = new Promise<never>((_, reject) => {
      signal.addEventListener(
        'abort',
        () => {
          reject(new NexarError('INTEGRATION_UNAVAILABLE', 'discovery source timed out'));
        },
        { once: true },
      );
    });
    timedOut.catch(() => undefined);
    try {
      const descriptors = await Promise.race([source.discover({ now, signal }), timedOut]);
      return {
        batch: { source: source.id, descriptors },
        report: { source: source.id, status: 'ok', count: descriptors.length, at },
      };
    } catch (e) {
      const errorCode = e instanceof NexarError ? e.code : 'INTEGRATION_UNAVAILABLE';
      return { report: { source: source.id, status: 'failed', count: 0, errorCode, at } };
    }
  }
}
