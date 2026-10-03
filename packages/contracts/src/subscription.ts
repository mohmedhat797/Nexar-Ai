/** Native account metadata only; vendor credentials and output never cross this port. */
export type SubscriptionRuntimeId = 'claude-code' | 'codex' | 'antigravity';
export interface NativeSubscriptionProbe {
  readonly status: 'connected' | 'not-connected' | 'unknown' | 'unavailable';
  readonly authMode: 'vendor-account' | 'api-key' | 'none' | 'unknown';
  readonly version?: string;
  readonly loginSupported: boolean;
}
export type NativeSubscriptionLoginOutcome =
  'succeeded' | 'failed' | 'cancelled' | 'timed-out' | 'unavailable';
export interface NativeSubscriptionRuntime {
  probe(this: void, signal: AbortSignal): Promise<NativeSubscriptionProbe>;
  login(this: void, signal: AbortSignal): Promise<NativeSubscriptionLoginOutcome>;
}
