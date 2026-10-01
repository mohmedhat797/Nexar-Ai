import {
  NexarError,
  type CandidateAssessment,
  type Logger,
  type NexarTask,
  type PolicyStamp,
  type QuotaObservation,
  type ResourceId,
  type ResourceSnapshot,
  type RouteDecision,
  type RouteReason,
  type ResourceRouter,
  type RoutingFacts,
  type RoutingHistory,
  type RoutingInput,
  type RoutingPolicy,
} from '@nexar/contracts';
import type { ResourceRegistry } from '@nexar/resource-registry';
import { isFallbackRoutingPolicy } from './fallback.js';
import { estimateTaskSize, laneRoleOf } from './size.js';

/** Supplies quota observations per resource (ADR-020 §4); read outside the policy. */
export interface QuotaSource {
  observe(
    ids: readonly ResourceId[],
    now: Date,
  ): Promise<ReadonlyMap<ResourceId, readonly QuotaObservation[]>>;
}

/** Supplies routing history aggregates (ADR-020 §7); read outside the policy. */
export interface HistorySource {
  read(now: Date): Promise<RoutingHistory | undefined>;
}

export interface ResourceControllerOptions {
  readonly registry: ResourceRegistry;
  readonly policy: RoutingPolicy;
  readonly clock?: () => Date;
  /** Probe resources before every routing decision; default false. */
  readonly refreshBeforeRouting?: boolean;
  /** Quota observations merged into each candidate's state before evaluation. */
  readonly quotaSource?: QuotaSource;
  /** History handed to the policy as data. */
  readonly historySource?: HistorySource;
  /** Receives the warning when the controller falls back (codes only, never prompts). */
  readonly logger?: Logger;
}

type SelectedDecision = Extract<RouteDecision, { outcome: 'selected' }>;

/** Composes registry + policy into explainable routing decisions. */
export class ResourceController implements ResourceRouter {
  private readonly registry: ResourceRegistry;
  private readonly policy: RoutingPolicy;
  private readonly clock: () => Date;
  private readonly refreshBeforeRouting: boolean;
  private readonly quotaSource: QuotaSource | undefined;
  private readonly historySource: HistorySource | undefined;
  private readonly logger: Logger | undefined;

  constructor(options: ResourceControllerOptions) {
    this.registry = options.registry;
    this.policy = options.policy;
    this.clock = options.clock ?? (() => new Date());
    this.refreshBeforeRouting = options.refreshBeforeRouting ?? false;
    this.quotaSource = options.quotaSource;
    this.historySource = options.historySource;
    this.logger = options.logger;
  }

  async route(task: NexarTask): Promise<RouteDecision> {
    const now = this.clock();
    const probed = this.refreshBeforeRouting
      ? await this.registry.refresh()
      : this.registry.snapshot();
    const candidates = await this.withQuotas(probed, now);
    const laneRole = laneRoleOf(task);
    const facts: RoutingFacts = {
      now: now.toISOString(),
      size: estimateTaskSize(task),
      ...(laneRole === undefined ? {} : { laneRole }),
    };
    // A failing history source means "no history" (neutral factors), never a failed route.
    const history = await this.historySource?.read(now).catch(() => undefined);
    const input: RoutingInput = {
      task: { id: task.id, kind: task.kind, requirements: task.requirements },
      candidates,
      facts,
      ...(history === undefined ? {} : { history }),
    };
    let assessments: readonly CandidateAssessment[];
    let fallback: PolicyStamp['fallback'];
    try {
      assessments = this.policy.evaluate(input);
    } catch (error) {
      // Fail closed unless the policy can rank the same hard-filter stage deterministically.
      if (!isFallbackRoutingPolicy(this.policy)) throw error;
      fallback = {
        from: `${this.policy.name}@${this.policy.version}`,
        reason: error instanceof NexarError ? error.code : 'INTERNAL_ERROR',
      };
      this.logger?.warn('routing policy failed; using deterministic fallback', { ...fallback });
      assessments = this.policy.evaluateFallback(input);
    }
    this.validate(
      candidates.map((c) => c.descriptor.id),
      assessments,
    );

    const eligible = assessments.filter((a) => a.eligible);
    const rejected = assessments.filter((a) => !a.eligible);
    const configId = this.policy.configId;
    const policy: PolicyStamp =
      fallback === undefined
        ? {
            name: this.policy.name,
            version: this.policy.version,
            ...(configId === undefined ? {} : { configId }),
          }
        : {
            name: 'deterministic',
            version: '1',
            ...(configId === undefined ? {} : { configId }),
            fallback,
          };
    const decidedAt = now.toISOString();
    const [selected, ...alternatives] = eligible;
    if (selected === undefined) {
      return { outcome: 'no-eligible-resource', taskId: task.id, rejected, policy, decidedAt };
    }
    return {
      outcome: 'selected',
      taskId: task.id,
      selected,
      alternatives,
      rejected,
      policy,
      decidedAt,
    };
  }

  /** Merges observed quotas into each snapshot; a failing source leaves quota unknown. */
  private async withQuotas(
    snapshots: readonly ResourceSnapshot[],
    now: Date,
  ): Promise<readonly ResourceSnapshot[]> {
    if (this.quotaSource === undefined) return snapshots;
    const observed = await this.quotaSource
      .observe(
        snapshots.map((s) => s.descriptor.id),
        now,
      )
      .catch(() => undefined);
    if (observed === undefined) return snapshots;
    return snapshots.map((s) => {
      const quotas = observed.get(s.descriptor.id);
      return quotas === undefined || quotas.length === 0
        ? s
        : { descriptor: s.descriptor, state: { ...s.state, quotas } };
    });
  }

  private validate(
    candidateIds: readonly string[],
    assessments: readonly CandidateAssessment[],
  ): void {
    const expected = [...candidateIds].sort();
    const actual = assessments.map((a) => a.resourceId as string).sort();
    const valid = expected.length === actual.length && expected.every((id, i) => id === actual[i]);
    if (!valid) {
      throw new NexarError(
        'INTERNAL_ERROR',
        `Routing policy ${this.policy.name}@${this.policy.version} must return exactly one assessment per candidate`,
        { details: { expected, actual } },
      );
    }
  }
}

/** Returns the decision narrowed to `selected`, or throws NO_ELIGIBLE_RESOURCE. */
export function requireSelected(decision: RouteDecision): SelectedDecision {
  if (decision.outcome === 'selected') return decision;
  throw new NexarError('NO_ELIGIBLE_RESOURCE', `No eligible resource for task ${decision.taskId}`, {
    details: {
      taskId: decision.taskId,
      rejected: decision.rejected.map((r) => ({
        resourceId: r.resourceId,
        reasonCodes: r.reasons.filter((x) => x.effect === 'rejects').map((x) => x.code),
      })),
    },
  });
}

const MARKERS: Record<RouteReason['effect'], string> = {
  supports: '+',
  rejects: '-',
  neutral: '·',
};

function fallbackLine(policy: PolicyStamp): string {
  const fallback = policy.fallback;
  return fallback === undefined
    ? ''
    : `Fallback: ${fallback.from} → ${policy.name}@${policy.version} (${fallback.reason})`;
}

/** Renders a decision as human-readable text. */
export function explainRouteDecision(
  decision: RouteDecision,
  options: { includeRejected?: boolean } = {},
): string {
  const includeRejected = options.includeRejected ?? true;
  const lines: string[] = [];
  const rejectedLines = (): void => {
    if (!includeRejected || decision.rejected.length === 0) return;
    lines.push('Rejected:');
    for (const r of decision.rejected) {
      for (const x of r.reasons.filter((y) => y.effect === 'rejects')) {
        lines.push(`  - ${r.resourceId}: ${x.code}: ${x.message}`);
      }
    }
  };

  if (decision.outcome === 'no-eligible-resource') {
    lines.push(`No eligible resource for task ${decision.taskId}`);
    if (decision.policy.fallback !== undefined) lines.push(fallbackLine(decision.policy));
    rejectedLines();
    return lines.join('\n');
  }

  const { selected, alternatives, policy } = decision;
  lines.push(
    `Selected resource: ${selected.resourceId} (score ${String(selected.score)}, policy ${policy.name}@${policy.version})`,
  );
  if (policy.fallback !== undefined) lines.push(fallbackLine(policy));
  lines.push('Reasons:');
  for (const x of selected.reasons) {
    lines.push(`  ${MARKERS[x.effect]} ${x.code}: ${x.message}`);
  }
  if (alternatives.length > 0) {
    lines.push(
      `Alternatives: ${alternatives.map((a) => `${a.resourceId} (${String(a.score)})`).join(', ')}`,
    );
  }
  rejectedLines();
  return lines.join('\n');
}
