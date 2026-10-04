import type { ExecutionGateway, ResourceId } from '@nexar/contracts';

/**
 * The port through which a write lane may get an engine gateway session (ADR-027 section 9b).
 * Implemented by the host, which owns the sockets; this package imports no network or IO code.
 */
export interface LaneEngineLane {
  readonly engineeringTaskId: string;
  readonly laneId: string;
  readonly role: string;
  readonly round: number;
  readonly projectId: string;
  readonly access: 'read-write';
}

/** One lane's session. `close` is idempotent and always called when the lane ends. */
export interface LaneEngineSession {
  /** The resource whose adapter consumes the gateway; the lane prefers it. */
  readonly engineResourceId: ResourceId;
  readonly gateway: ExecutionGateway;
  /** True when the pinned control resource failed during the lane. */
  controlFailed?(): boolean;
  close(): Promise<void>;
}

export type LaneEngineUnavailable = 'engine-unavailable' | 'control-unavailable';

export interface LaneEngine {
  /** Never throws for "not available"; resolves to the reason instead. */
  open(
    lane: LaneEngineLane,
    signal: AbortSignal,
  ): Promise<LaneEngineSession | { readonly unavailable: LaneEngineUnavailable }>;
}
