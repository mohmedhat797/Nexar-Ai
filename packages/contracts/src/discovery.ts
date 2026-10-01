import type { ResourceDescriptor } from './resource.js';

/** Context handed to a discovery source: the (injected) current time and a deadline. */
export interface DiscoveryContext {
  readonly now: Date;
  readonly signal: AbortSignal;
}

/**
 * Finds candidate resources (ADR-020 §9). Discovery finds candidates; adapter probes decide
 * usability: a discovered descriptor is never authenticated until its probe says so.
 */
export interface DiscoverySource {
  readonly id: string;
  discover(ctx: DiscoveryContext): Promise<readonly ResourceDescriptor[]>;
}

/** What one discovery run observed about one source. Carries no ids, paths or messages. */
export interface DiscoverySourceReport {
  readonly source: string;
  readonly status: 'ok' | 'failed' | 'disabled';
  readonly count: number;
  readonly errorCode?: string;
  readonly at: string;
}
