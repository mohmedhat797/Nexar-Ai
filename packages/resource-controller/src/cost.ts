import { estimated, unavailable, valueOf } from '@nexar/contracts';
import type {
  CostEstimate,
  ResourceDescriptor,
  RouteReason,
  TaskSizeEstimate,
} from '@nexar/contracts';
import type { ResourceIntelligenceSettings } from './intelligence-settings.js';

/** Identifies the estimator that produced a `CostEstimate` (recorded for estimate-vs-actual). */
export const COST_ESTIMATOR = 'estimator@1';

type CostSettings = ResourceIntelligenceSettings['cost'];

const NEUTRAL_FACTOR = 0.5;

function round6(n: number): number {
  return Math.round(n * 1e6) / 1e6;
}

/** Up to six decimals, trailing zeros trimmed (at least two kept): 0.05, 0.0123, 0.050001. */
function usd(n: number): string {
  return n.toFixed(6).replace(/(\.\d\d\d*?)0+$/, '$1');
}

/**
 * Pre-execution cost estimate for one candidate. Pure: sees only the descriptor and size facts,
 * never the prompt. A price of zero is "free or unknown", never a fabricated zero cost.
 */
export function estimateCost(
  descriptor: ResourceDescriptor,
  size: TaskSizeEstimate | undefined,
  settings: CostSettings,
): CostEstimate {
  const requested = size?.requestedMaxOutputTokens ?? settings.defaultOutputTokens;
  const cap = descriptor.limits?.maxOutputTokens;
  const outputTokens = cap === undefined ? requested : Math.min(requested, cap);
  const inputTokens = size?.estimatedInputTokens ?? 0;
  const make = (cls: CostEstimate['class'], cashUsd: CostEstimate['cashUsd']): CostEstimate => ({
    class: cls,
    cashUsd,
    inputTokens,
    outputTokens,
    estimator: COST_ESTIMATOR,
  });

  const profile = descriptor.cost;
  switch (profile.model) {
    case 'per-token': {
      const inRate = profile.inputPerMillionTokens;
      const outRate = profile.outputPerMillionTokens;
      if (inRate === 0 && outRate === 0) {
        return make('unknown', unavailable('catalog price 0 means free-or-unknown'));
      }
      if (size === undefined) return make('cash', unavailable('no size facts'));
      const catalog = descriptor.provenance?.startsWith('discovered:') === true;
      const basis =
        `${inputTokens} in x $${inRate}/M + ${outputTokens} out x $${outRate}/M; ` +
        `size ${size.basis}${catalog ? '; catalog price' : ''}`;
      return make(
        'cash',
        estimated(round6((inputTokens * inRate + outputTokens * outRate) / 1e6), basis),
      );
    }
    case 'subscription':
      return make(
        'subscription-allowance',
        estimated(0, 'marginal cash; consumes subscription allowance'),
      );
    case 'local-compute':
      return make('local-compute', estimated(0, 'local compute'));
    case 'free':
      return make('free', estimated(0, 'free resource'));
    case 'unknown':
      return make('unknown', unavailable('cost profile unknown'));
  }
}

export interface CostEvaluation {
  readonly reasons: RouteReason[];
  readonly rejected: boolean;
  readonly factor: { readonly value: number; readonly neutral: boolean };
}

function basisOf(estimate: CostEstimate): string {
  const c = estimate.cashUsd;
  if (c.status === 'estimated') return c.basis;
  if (c.status === 'unavailable') return c.reason ?? 'unavailable';
  return 'measured';
}

/** Applies `maxCostUsd` to an estimate and derives the cost factor. Pure. */
export function evaluateCost(
  estimate: CostEstimate,
  maxCostUsd: number | undefined,
  settings: CostSettings,
): CostEvaluation {
  const value = valueOf(estimate.cashUsd);
  const basis = basisOf(estimate);

  let factor: CostEvaluation['factor'];
  if (estimate.class === 'cash' && value !== undefined) {
    factor = { value: 1 / (1 + value / settings.costScaleUsd), neutral: false };
  } else if (estimate.class === 'subscription-allowance') {
    factor = { value: settings.subscriptionScore, neutral: false };
  } else if (estimate.class === 'local-compute' || estimate.class === 'free') {
    factor = { value: 1, neutral: false };
  } else {
    factor = { value: NEUTRAL_FACTOR, neutral: true };
  }

  if (maxCostUsd === undefined) {
    const shown = value === undefined ? 'n/a' : `$${usd(value)}`;
    return {
      reasons: [
        {
          code: 'cost.estimate',
          message: `cost class ${estimate.class}, est ${shown} (${basis})`,
          effect: 'neutral',
        },
      ],
      rejected: false,
      factor,
    };
  }

  const limit = `$${usd(maxCostUsd)}`;
  if (value !== undefined) {
    const exceeds = value > maxCostUsd;
    const message = `est $${usd(value)} ${exceeds ? '>' : '≤'} limit ${limit} (${basis})`;
    return {
      reasons: [
        exceeds
          ? { code: 'cost.exceeds-limit', message, effect: 'rejects' }
          : { code: 'cost.within-limit', message, effect: 'supports' },
      ],
      rejected: exceeds,
      factor,
    };
  }
  if (settings.unknownUnderLimit === 'allow') {
    return {
      reasons: [
        {
          code: 'cost.not-estimable-allowed',
          message: `cost class ${estimate.class} not estimable (${basis}); allowed under limit ${limit}`,
          effect: 'neutral',
        },
      ],
      rejected: false,
      factor,
    };
  }
  return {
    reasons: [
      {
        code: 'cost.not-estimable',
        message: `cost class ${estimate.class} not estimable (${basis}); limit ${limit} requires an estimate`,
        effect: 'rejects',
      },
    ],
    rejected: true,
    factor,
  };
}
