import type {
  Capability,
  CostEstimate,
  QuotaAssessment,
  ResourceId,
  ResourceSnapshot,
  RouteReason,
  RoutingInput,
} from '@nexar/contracts';
import { assessQuota, evaluateQuota } from './quota.js';
import { estimateCost, evaluateCost } from './cost.js';
import type { TaskKindRule } from './deterministic-policy.js';
import type { ReservationRule, ResourceIntelligenceSettings } from './intelligence-settings.js';

export interface HardFilterConfig {
  readonly taskKinds: Readonly<Record<string, TaskKindRule>>;
  readonly settings: ResourceIntelligenceSettings;
}

/** A candidate after the hard-filter stage (ADR-020 §1); scoring only ever sees eligible ones. */
export interface FilteredCandidate {
  readonly snapshot: ResourceSnapshot;
  readonly resourceId: ResourceId;
  readonly eligible: boolean;
  /** Every reason collected by the filters (rejections included), in filter order. */
  readonly reasons: readonly RouteReason[];
  readonly quota: QuotaAssessment;
  readonly cost: CostEstimate;
  readonly quotaFactor: { readonly value: number; readonly neutral: boolean };
  readonly costFactor: { readonly value: number; readonly neutral: boolean };
}

const reason = (code: string, effect: RouteReason['effect'], message: string): RouteReason => ({
  code,
  effect,
  message,
});

/** The task-kind rule for `kind`, guarding against prototype keys. */
export function ruleFor(
  taskKinds: HardFilterConfig['taskKinds'],
  kind: string,
): TaskKindRule | undefined {
  return Object.hasOwn(taskKinds, kind) ? taskKinds[kind] : undefined;
}

/** Capabilities the task kind and the task itself require (deduplicated, kind first). */
export function requiredCapabilities(
  rule: TaskKindRule | undefined,
  input: RoutingInput,
): readonly Capability[] {
  return [
    ...new Set([...(rule?.requiredCapabilities ?? []), ...input.task.requirements.capabilities]),
  ];
}

/**
 * The predicates shared with `deterministic@1` (excluded, capability, availability,
 * authentication, privacy, context window), with the same codes and messages. Pure.
 */
export function basicHardFilters(
  { descriptor, state }: ResourceSnapshot,
  input: RoutingInput,
  rule: TaskKindRule | undefined,
  required: readonly Capability[],
): { readonly rejected: boolean; readonly reasons: RouteReason[] } {
  const { task } = input;
  const reqs = task.requirements;
  const id = descriptor.id;
  const reasons: RouteReason[] = [];
  let rejected = false;
  const reject = (code: string, message: string): void => {
    rejected = true;
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

  switch (state.availability) {
    case 'available':
      reasons.push(reason('state.available', 'supports', 'resource is available'));
      break;
    case 'degraded':
      reasons.push(reason('state.degraded', 'neutral', 'resource is degraded'));
      break;
    case 'unknown':
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
  return { rejected, reasons };
}

function reservationFor(
  reservations: readonly ReservationRule[],
  id: ResourceId,
): ReservationRule | undefined {
  return reservations.find((r) => r.resourceId === id);
}

/**
 * The hard-filter stage of `resource-intelligence@1` (ADR-020 §1): the shared predicates, then
 * quota, then cost, with every rejection collected. One entry per candidate, in input order.
 * Pure: the clock is `input.facts.now`; without it quota is treated as unknown.
 */
export function applyHardFilters(
  input: RoutingInput,
  config: HardFilterConfig,
): readonly FilteredCandidate[] {
  const { settings } = config;
  const { task, facts } = input;
  const rule = ruleFor(config.taskKinds, task.kind);
  const required = requiredCapabilities(rule, input);
  const nowMs = facts === undefined ? Number.NaN : Date.parse(facts.now);
  const now = new Date(Number.isNaN(nowMs) ? 0 : nowMs);

  return input.candidates.map((snapshot) => {
    const id = snapshot.descriptor.id;
    const basic = basicHardFilters(snapshot, input, rule, required);

    // Without a usable clock quota cannot be judged: it is unknown, never "fine".
    const observations = Number.isNaN(nowMs) ? undefined : snapshot.state.quotas;
    const assessment = assessQuota(observations, now, settings.quota);
    const quota = evaluateQuota(
      assessment,
      {
        taskKind: task.kind,
        ...(facts?.laneRole === undefined ? {} : { laneRole: facts.laneRole }),
        ...(task.requirements.requireKnownQuota === undefined
          ? {}
          : { requireKnownQuota: task.requirements.requireKnownQuota }),
      },
      reservationFor(settings.reservations, id),
      settings.quota,
    );

    const estimate = estimateCost(snapshot.descriptor, facts?.size, settings.cost);
    const cost = evaluateCost(estimate, task.requirements.maxCostUsd, settings.cost);

    return {
      snapshot,
      resourceId: id,
      eligible: !basic.rejected && !quota.rejected && !cost.rejected,
      reasons: [...basic.reasons, ...quota.reasons, ...cost.reasons],
      quota: quota.assessment,
      cost: estimate,
      quotaFactor: quota.factor,
      costFactor: cost.factor,
    };
  });
}
