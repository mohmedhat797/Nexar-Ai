import type { ArtifactRef } from './artifacts.js';
import type { NexarErrorCode } from './errors.js';
import type { UsageReport } from './execution.js';
import type { AdapterId, ProjectId, ResourceId, TaskId } from './ids.js';
import type { CostEstimateRecord, QuotaObservation } from './intelligence.js';
import type { Measured } from './measured.js';
import type { QuotaState, ResourceKindType } from './resource.js';
import type { RouteDecision } from './routing.js';
import type { TaskKind, TaskOrigin } from './task.js';

/** Terminal result of an execution attempt. */
export type ExecutionOutcome = 'succeeded' | 'failed' | 'cancelled' | 'timed-out';

/** Durable, versioned summary of one execution, suitable for storage and later learning. */
export interface ExecutionRecord {
  readonly schemaVersion: 1;
  readonly taskId: TaskId;
  readonly taskKind: TaskKind;
  readonly origin: TaskOrigin['source'];
  readonly projectId?: ProjectId;
  readonly resourceId: ResourceId;
  readonly resourceKind: ResourceKindType;
  readonly adapter: AdapterId;
  readonly provider?: string;
  readonly model?: string;
  readonly runtimeVersion?: string;
  readonly routing: {
    readonly policy: string;
    readonly policyVersion: string;
    readonly reasonCodes: readonly string[];
  };
  readonly startedAt: string;
  readonly endedAt: string;
  readonly latencyMs: number;
  readonly usage: UsageReport;
  readonly quotaImpact: Measured<QuotaState>;
  readonly retries: number;
  readonly outcome: ExecutionOutcome;
  readonly error?: {
    readonly code: NexarErrorCode;
    readonly message: string;
    readonly retryable: boolean;
  };
  readonly artifacts: readonly ArtifactRef[];
  /** Pre-execution estimate vs measured actual (ADR-020 §5); observability only. */
  readonly costEstimate?: CostEstimateRecord;
}

/** Steps of an engineering task (ADR-019); each lane's own execution is a normal execution record. */
export type EngineeringStep =
  | 'task.started'
  | 'lane.completed'
  | 'patch.harvested'
  | 'gate.completed'
  | 'review.completed'
  | 'acceptance.decided'
  | 'commit.created'
  | 'task.finished';

/** Lifecycle events emitted for observability of routing and execution. */
export type TelemetryEvent =
  | { readonly type: 'route.decided'; readonly at: string; readonly decision: RouteDecision }
  | {
      readonly type: 'execution.started';
      readonly at: string;
      readonly taskId: TaskId;
      readonly resourceId: ResourceId;
    }
  | { readonly type: 'execution.finished'; readonly at: string; readonly record: ExecutionRecord }
  | {
      readonly type: 'artifacts.stored';
      readonly at: string;
      readonly taskId: TaskId;
      readonly projectId?: ProjectId;
      readonly artifacts: readonly ArtifactRef[];
    }
  | {
      /** An allowance signal reported by a runtime during a call (ADR-020 §4). */
      readonly type: 'quota.observed';
      readonly at: string;
      readonly resourceId: ResourceId;
      readonly observation: QuotaObservation;
    }
  | {
      readonly type: 'engineering.step';
      readonly at: string;
      readonly engineeringTaskId: string;
      readonly projectId: ProjectId;
      readonly step: EngineeringStep;
      /** Allowlisted scalars only (ids, counts, codes, hashes, durations): never prompts, diffs or paths. */
      readonly detail: Readonly<Record<string, string | number | boolean>>;
    };

/** Destination for telemetry events; implementations decide storage and delivery. */
export interface TelemetrySink {
  emit(event: TelemetryEvent): void | Promise<void>;
}
