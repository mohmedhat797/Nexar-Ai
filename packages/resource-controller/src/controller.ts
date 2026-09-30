import {
  NexarError,
  type CandidateAssessment,
  type NexarTask,
  type RouteDecision,
  type RouteReason,
  type ResourceRouter,
  type RoutingPolicy,
} from '@nexar/contracts';
import type { ResourceRegistry } from '@nexar/resource-registry';

export interface ResourceControllerOptions {
  readonly registry: ResourceRegistry;
  readonly policy: RoutingPolicy;
  readonly clock?: () => Date;
  /** Probe resources before every routing decision; default false. */
  readonly refreshBeforeRouting?: boolean;
}

type SelectedDecision = Extract<RouteDecision, { outcome: 'selected' }>;

/** Composes registry + policy into explainable routing decisions. */
export class ResourceController implements ResourceRouter {
  private readonly registry: ResourceRegistry;
  private readonly policy: RoutingPolicy;
  private readonly clock: () => Date;
  private readonly refreshBeforeRouting: boolean;

  constructor(options: ResourceControllerOptions) {
    this.registry = options.registry;
    this.policy = options.policy;
    this.clock = options.clock ?? (() => new Date());
    this.refreshBeforeRouting = options.refreshBeforeRouting ?? false;
  }

  async route(task: NexarTask): Promise<RouteDecision> {
    const candidates = this.refreshBeforeRouting
      ? await this.registry.refresh()
      : this.registry.snapshot();
    const assessments = this.policy.evaluate({
      task: { id: task.id, kind: task.kind, requirements: task.requirements },
      candidates,
    });
    this.validate(
      candidates.map((c) => c.descriptor.id),
      assessments,
    );

    const eligible = assessments.filter((a) => a.eligible);
    const rejected = assessments.filter((a) => !a.eligible);
    const policy = { name: this.policy.name, version: this.policy.version };
    const decidedAt = this.clock().toISOString();
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
    rejectedLines();
    return lines.join('\n');
  }

  const { selected, alternatives, policy } = decision;
  lines.push(
    `Selected resource: ${selected.resourceId} (score ${String(selected.score)}, policy ${policy.name}@${policy.version})`,
    'Reasons:',
  );
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
