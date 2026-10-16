import type { ArtifactRef } from './artifacts.js';
import type { ControlEngine } from './connection.js';
import type { AdapterId } from './ids.js';
import type { QuotaObservation } from './intelligence.js';
import type { EngineeringWorkspace, LaunchServices } from './launcher.js';
import type { Logger } from './logging.js';
import { unavailable } from './measured.js';
import type { Measured } from './measured.js';
import type { ResourceDescriptor, ResourceState } from './resource.js';
import type { NexarTask } from './task.js';

/** Token/cost usage where every figure states whether it was measured, estimated or unknown. */
export interface UsageReport {
  readonly inputTokens: Measured<number>;
  readonly outputTokens: Measured<number>;
  readonly cacheReadTokens?: Measured<number>;
  readonly cacheWriteTokens?: Measured<number>;
  readonly costUsd: Measured<number>;
  readonly turns?: Measured<number>;
}

/** Usage for runtimes that report nothing, making "unknown" explicit rather than zero. */
export function emptyUsage(reason?: string): UsageReport {
  return {
    inputTokens: unavailable(reason),
    outputTokens: unavailable(reason),
    costUsd: unavailable(reason),
  };
}

/** Progress notifications an adapter may stream while executing. */
export type ExecutionEvent =
  | { readonly type: 'status'; readonly message: string }
  | { readonly type: 'text-delta'; readonly text: string }
  | { readonly type: 'tool-call'; readonly name: string; readonly detail?: string };

/** The task together with the resource chosen to run it. */
export interface ExecutionRequest {
  readonly task: NexarTask;
  readonly resource: ResourceDescriptor;
}

/**
 * A lane's engine gateway session (ADR-027 section 9b): the Nexar services an orchestrating engine
 * may use, pinned to one control decision. `token` is a secret: never logged, recorded or echoed.
 */
export interface ExecutionGateway {
  readonly engine: ControlEngine;
  /** Host paths for `LaunchSpec.services`. */
  readonly services: LaunchServices;
  readonly token: string;
  readonly model: 'nexar-control';
  readonly controlResourceId: string;
  readonly controlDecisionId: string;
}

/** Ambient facilities (cancellation, logging, streaming) supplied by the caller. */
export interface ExecutionContext {
  readonly signal: AbortSignal;
  readonly logger: Logger;
  readonly onEvent?: (event: ExecutionEvent) => void;
  /**
   * Present only for engineering lanes (ADR-019). An adapter given a `read-write`
   * workspace MUST refuse (`POLICY_REJECTED`) unless `launcher.isolation === 'sandbox'`,
   * and MUST spawn its runtime only through `launcher.prepare`.
   */
  readonly workspace?: EngineeringWorkspace;
  /** Present only for a lane with an engine gateway session; adapters that do not know it ignore it. */
  readonly gateway?: ExecutionGateway;
  /**
   * Owner-confirmed project memory for an engineering lane (workspace only). A runtime that renders a
   * system prompt may include it verbatim; it is never logged, recorded or put on telemetry.
   */
  readonly requiredContext?: string;
}

/** What an adapter returns, including what was actually resolved at runtime. */
export interface ExecutionResult {
  readonly text: string;
  readonly artifacts: readonly ArtifactRef[];
  readonly usage: UsageReport;
  readonly resolved: {
    readonly provider?: string;
    readonly model?: string;
    readonly runtimeVersion?: string;
  };
  readonly retries: number;
  /**
   * Allowance signals the runtime reported during this call through a documented interface
   * (provenance `vendor-reported`, ADR-020 §4). Never derived from credentials.
   */
  readonly quotaObservations?: readonly QuotaObservation[];
}

/**
 * The boundary every integration implements; Nexar core speaks only this.
 *
 * Adapters MUST throw `NexarError` (never leak upstream error types), MUST honor
 * `signal`, and MUST NOT log secrets. `probe` MUST be side-effect free and MUST
 * never make paid calls.
 */
export interface ExecutionAdapter {
  readonly id: AdapterId;
  readonly displayName: string;
  supports(resource: ResourceDescriptor): boolean;
  probe(resource: ResourceDescriptor, signal: AbortSignal): Promise<ResourceState>;
  execute(request: ExecutionRequest, context: ExecutionContext): Promise<ExecutionResult>;
}
