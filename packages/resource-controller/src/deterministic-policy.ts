import type {
  CandidateAssessment,
  Capability,
  ResourceId,
  ResourceSnapshot,
  RouteReason,
  RoutingInput,
  RoutingPolicy,
} from '@nexar/contracts';

/** Per-task-kind routing rule. */
export interface TaskKindRule {
  readonly requiredCapabilities: readonly Capability[];
  readonly preferredResourceIds?: readonly ResourceId[];
}

export interface DeterministicPolicyConfig {
  readonly taskKinds: Readonly<Record<string, TaskKindRule>>;
  readonly defaultResourceId?: ResourceId;
}

/** Capability requirements for the task kinds Nexar knows about. */
export const DEFAULT_TASK_KIND_RULES: DeterministicPolicyConfig['taskKinds'] = {
  documentation: { requiredCapabilities: ['knowledge-work'] },
  analysis: { requiredCapabilities: ['reasoning'] },
  coding: { requiredCapabilities: ['coding', 'repo-editing'] },
  review: { requiredCapabilities: ['code-review'] },
  research: { requiredCapabilities: ['reasoning', 'web-research'] },
  'meeting-preparation': { requiredCapabilities: ['knowledge-work'] },
  automation: { requiredCapabilities: ['tool-use'] },
  general: { requiredCapabilities: ['text-generation'] },
};

const TASK_PREFERENCE_BASE = 1000;
const KIND_PREFERENCE_BASE = 500;
const DEFAULT_PREFERENCE_SCORE = 100;
const PREFERENCE_STEP = 10;
const AVAILABLE_BONUS = 20;
const UNCERTAIN_BONUS = 10;

function unique<T>(items: readonly T[]): T[] {
  return [...new Set(items)];
}

const reason = (code: string, effect: RouteReason['effect'], message: string): RouteReason => ({
  code,
  effect,
  message,
});

/**
 * Pure, fully deterministic policy: hard filters first, then a fixed-weight
 * preference ranking with resource id as the final tie-break.
 */
export class DeterministicRoutingPolicy implements RoutingPolicy {
  readonly name = 'deterministic';
  readonly version = '1';

  constructor(private readonly config: DeterministicPolicyConfig) {}

  evaluate(input: RoutingInput): readonly CandidateAssessment[] {
    const { task, candidates } = input;
    const rule = Object.hasOwn(this.config.taskKinds, task.kind)
      ? this.config.taskKinds[task.kind]
      : undefined;
    const required = unique([
      ...(rule?.requiredCapabilities ?? []),
      ...task.requirements.capabilities,
    ]);
    const assessments = candidates.map((candidate) =>
      this.assess(candidate, input, rule, required),
    );
    const byId = (a: CandidateAssessment, b: CandidateAssessment) =>
      a.resourceId < b.resourceId ? -1 : a.resourceId > b.resourceId ? 1 : 0;
    const eligible = assessments
      .filter((a) => a.eligible)
      .sort((a, b) => b.score - a.score || byId(a, b));
    const ineligible = assessments.filter((a) => !a.eligible).sort(byId);
    return [...eligible, ...ineligible];
  }

  private assess(
    { descriptor, state }: ResourceSnapshot,
    { task }: RoutingInput,
    rule: TaskKindRule | undefined,
    required: readonly Capability[],
  ): CandidateAssessment {
    const reqs = task.requirements;
    const id = descriptor.id;
    const reasons: RouteReason[] = [];
    let eligible = true;
    const reject = (code: string, message: string) => {
      eligible = false;
      reasons.push(reason(code, 'rejects', message));
    };

    if (rule === undefined) {
      reasons.push(reason('task-kind.unknown', 'neutral', `no rule for task kind "${task.kind}"`));
    }

    if (reqs.excludedResourceIds?.includes(id) === true) {
      reject('resource.excluded', 'resource is excluded by the task');
    }

    const missing = required.filter((c) => !descriptor.capabilities.includes(c));
    if (missing.length > 0) {
      reject('capability.missing', `lacks ${missing.join(', ')}`);
    } else if (required.length > 0) {
      reasons.push(reason('capability.match', 'supports', `has ${required.join(', ')}`));
    }

    // Preference tier: the highest applicable tier decides the score.
    const taskIndex = reqs.preferredResourceIds?.indexOf(id) ?? -1;
    const kindIndex = rule?.preferredResourceIds?.indexOf(id) ?? -1;
    let score = 0;
    if (taskIndex >= 0) {
      score = TASK_PREFERENCE_BASE - PREFERENCE_STEP * taskIndex;
      reasons.push(reason('preference.task', 'supports', 'preferred by the task'));
    } else if (kindIndex >= 0) {
      score = KIND_PREFERENCE_BASE - PREFERENCE_STEP * kindIndex;
      reasons.push(
        reason('preference.task-kind', 'supports', `preferred for task kind "${task.kind}"`),
      );
    } else if (this.config.defaultResourceId === id) {
      score = DEFAULT_PREFERENCE_SCORE;
      reasons.push(reason('preference.default', 'supports', 'default resource'));
    }

    switch (state.availability) {
      case 'available':
        score += AVAILABLE_BONUS;
        reasons.push(reason('state.available', 'supports', 'resource is available'));
        break;
      case 'degraded':
        score += UNCERTAIN_BONUS;
        reasons.push(reason('state.degraded', 'neutral', 'resource is degraded'));
        break;
      case 'unknown':
        score += UNCERTAIN_BONUS;
        reasons.push(reason('state.unknown', 'neutral', 'resource availability is unknown'));
        break;
      case 'unavailable':
        reject('state.unavailable', 'resource is unavailable');
        break;
    }

    if (descriptor.auth.mode !== 'none' && state.auth === 'unauthenticated') {
      reject(
        'auth.unauthenticated',
        `resource requires ${descriptor.auth.mode} auth and is not authenticated`,
      );
    } else if (descriptor.auth.mode !== 'none' && state.auth === 'unknown') {
      reasons.push(reason('auth.unknown', 'neutral', 'authentication state is unknown'));
    } else {
      reasons.push(reason('auth.ok', 'supports', 'authentication is satisfied'));
    }

    if (reqs.privacy === 'local-only' && descriptor.dataLocality !== 'local') {
      reject('privacy.third-party', 'task is local-only but resource sends data to a third party');
    }

    if (reqs.minContextTokens !== undefined) {
      const window = descriptor.limits?.contextWindowTokens;
      if (window === undefined) {
        reasons.push(reason('context.unknown', 'neutral', 'context window is unknown'));
      } else if (reqs.minContextTokens > window) {
        reject(
          'context.insufficient',
          `needs ${String(reqs.minContextTokens)} tokens of context, resource has ${String(window)}`,
        );
      }
    }

    if (reqs.maxCostUsd !== undefined) {
      reasons.push(
        reason('cost.not-evaluated', 'neutral', 'cost limits are not evaluated by this policy'),
      );
    }

    return { resourceId: id, eligible, score: eligible ? score : 0, reasons };
  }
}
