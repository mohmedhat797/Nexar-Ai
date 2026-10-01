import type { ArtifactRef } from './artifacts.js';
import type { AdapterId } from './ids.js';
import type { EngineeringWorkspace } from './launcher.js';
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
