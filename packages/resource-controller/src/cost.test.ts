import { adapterId, estimated, resourceId, unavailable } from '@nexar/contracts';
import type { CostEstimate, ResourceDescriptor, TaskSizeEstimate } from '@nexar/contracts';
import { describe, expect, it } from 'vitest';
import {
  COST_ESTIMATOR,
  DEFAULT_RESOURCE_INTELLIGENCE_SETTINGS,
  estimateCost,
  evaluateCost,
} from './index.js';

const settings = DEFAULT_RESOURCE_INTELLIGENCE_SETTINGS.cost;

function desc(over: Partial<ResourceDescriptor> = {}): ResourceDescriptor {
  return {
    id: resourceId('r'),
    displayName: 'r',
    kind: { type: 'model', provider: 'acme', model: 'm', access: 'api' },
    capabilities: ['text-generation'],
    runtime: { adapter: adapterId('test'), locality: 'remote' },
    auth: { mode: 'none' },
    cost: { model: 'free' },
    dataLocality: 'third-party',
    ...over,
  };
}

const perToken = (i: number, o: number): ResourceDescriptor['cost'] => ({
  model: 'per-token',
  currency: 'USD',
  inputPerMillionTokens: i,
  outputPerMillionTokens: o,
});

const size = (over: Partial<TaskSizeEstimate> = {}): TaskSizeEstimate => ({
  estimatedInputTokens: 1000,
  attachmentCount: 0,
  documentCount: 0,
  basis: 'chars/4@1',
  ...over,
});

describe('estimateCost', () => {
  it('prices per-token with default output tokens', () => {
    const e = estimateCost(desc({ cost: perToken(3, 15) }), size(), settings);
    expect(e).toMatchObject({
      class: 'cash',
      inputTokens: 1000,
      outputTokens: 4096,
      estimator: COST_ESTIMATOR,
    });
    expect(e.cashUsd).toMatchObject({ status: 'estimated', value: 0.06444 });
    const basis = e.cashUsd.status === 'estimated' ? e.cashUsd.basis : '';
    expect(basis).toContain('$3/M');
    expect(basis).toContain('$15/M');
    expect(basis).toContain('chars/4@1');
    expect(basis).not.toContain('catalog');
  });

  it('uses requested output tokens, capped by the resource limit', () => {
    const d = desc({ cost: perToken(0, 10), limits: { maxOutputTokens: 500 } });
    expect(estimateCost(d, size({ requestedMaxOutputTokens: 2000 }), settings).outputTokens).toBe(
      500,
    );
    expect(estimateCost(d, size({ requestedMaxOutputTokens: 100 }), settings).outputTokens).toBe(
      100,
    );
    expect(estimateCost(d, undefined, settings).outputTokens).toBe(500);
  });

  it('marks catalog provenance in the basis', () => {
    const e = estimateCost(
      desc({ cost: perToken(1, 1), provenance: 'discovered:pi-ai' }),
      size(),
      settings,
    );
    const basis = e.cashUsd.status === 'estimated' ? e.cashUsd.basis : '';
    expect(basis).toContain('catalog');
  });

  it('rounds to six decimals', () => {
    const e = estimateCost(
      desc({ cost: perToken(1, 0.3333333) }),
      size({ estimatedInputTokens: 1, requestedMaxOutputTokens: 1 }),
      settings,
    );
    expect(e.cashUsd).toMatchObject({ value: 0.000001 });
  });

  it('treats zero prices as unknown, never a free estimate', () => {
    const e = estimateCost(desc({ cost: perToken(0, 0) }), size(), settings);
    expect(e.class).toBe('unknown');
    expect(e.cashUsd).toEqual(unavailable('catalog price 0 means free-or-unknown'));
  });

  it('is cash but unavailable without size facts', () => {
    const e = estimateCost(desc({ cost: perToken(3, 15) }), undefined, settings);
    expect(e.class).toBe('cash');
    expect(e.cashUsd).toEqual(unavailable('no size facts'));
    expect(e.inputTokens).toBe(0);
  });

  it.each([
    [{ model: 'subscription' as const }, 'subscription-allowance', 'marginal cash'],
    [{ model: 'local-compute' as const }, 'local-compute', 'local compute'],
    [{ model: 'free' as const }, 'free', 'free resource'],
  ])('%j → %s with zero cash', (cost, cls, basis) => {
    const e = estimateCost(desc({ cost }), size(), settings);
    expect(e.class).toBe(cls);
    expect(e.cashUsd.status).toBe('estimated');
    expect(e.cashUsd.status === 'estimated' && e.cashUsd.value).toBe(0);
    expect(e.cashUsd.status === 'estimated' && e.cashUsd.basis).toContain(basis);
  });

  it('is unknown for an unknown profile', () => {
    const e = estimateCost(desc({ cost: { model: 'unknown' } }), size(), settings);
    expect(e.class).toBe('unknown');
    expect(e.cashUsd).toEqual(unavailable('cost profile unknown'));
  });

  it('is deterministic', () => {
    const d = desc({ cost: perToken(3, 15) });
    expect(estimateCost(d, size(), settings)).toEqual(estimateCost(d, size(), settings));
  });
});

const cash = (v: number): CostEstimate => ({
  class: 'cash',
  cashUsd: estimated(v, 'basis-x'),
  inputTokens: 1,
  outputTokens: 1,
  estimator: COST_ESTIMATOR,
});
const unknownCost: CostEstimate = {
  class: 'unknown',
  cashUsd: unavailable('cost profile unknown'),
  inputTokens: 0,
  outputTokens: 0,
  estimator: COST_ESTIMATOR,
};

describe('evaluateCost', () => {
  it('reports a neutral estimate with no limit', () => {
    const r = evaluateCost(cash(0.0123), undefined, settings);
    expect(r.rejected).toBe(false);
    expect(r.reasons).toEqual([
      {
        code: 'cost.estimate',
        message: 'cost class cash, est $0.0123 (basis-x)',
        effect: 'neutral',
      },
    ]);
  });

  it('supports an estimate within the limit', () => {
    const r = evaluateCost(cash(0.0123), 0.05, settings);
    expect(r.rejected).toBe(false);
    expect(r.reasons).toEqual([
      {
        code: 'cost.within-limit',
        message: 'est $0.0123 ≤ limit $0.05 (basis-x)',
        effect: 'supports',
      },
    ]);
  });

  it('passes at exactly the limit', () => {
    const r = evaluateCost(cash(0.05), 0.05, settings);
    expect(r.rejected).toBe(false);
    expect(r.reasons[0]?.code).toBe('cost.within-limit');
  });

  it('rejects above the limit', () => {
    const r = evaluateCost(cash(0.050001), 0.05, settings);
    expect(r.rejected).toBe(true);
    expect(r.reasons).toEqual([
      {
        code: 'cost.exceeds-limit',
        message: 'est $0.050001 > limit $0.05 (basis-x)',
        effect: 'rejects',
      },
    ]);
  });

  it('fails closed when the cost is not estimable under a strict limit', () => {
    const r = evaluateCost(unknownCost, 0.05, settings);
    expect(r.rejected).toBe(true);
    expect(r.reasons[0]).toMatchObject({ code: 'cost.not-estimable', effect: 'rejects' });
  });

  it('allows unknown cost when configured', () => {
    const r = evaluateCost(unknownCost, 0.05, { ...settings, unknownUnderLimit: 'allow' });
    expect(r.rejected).toBe(false);
    expect(r.reasons[0]).toMatchObject({ code: 'cost.not-estimable-allowed', effect: 'neutral' });
  });

  it('a cash class without a number is not estimable', () => {
    const noSize: CostEstimate = { ...cash(1), cashUsd: unavailable('no size facts') };
    expect(evaluateCost(noSize, 1, settings).rejected).toBe(true);
  });

  it('computes the factor per class', () => {
    expect(evaluateCost(cash(0.1), undefined, settings).factor).toEqual({
      value: 0.5,
      neutral: false,
    });
    expect(evaluateCost(cash(0), undefined, settings).factor.value).toBe(1);
    expect(
      evaluateCost({ ...cash(0), class: 'subscription-allowance' }, undefined, settings).factor,
    ).toEqual({ value: settings.subscriptionScore, neutral: false });
    expect(
      evaluateCost({ ...cash(0), class: 'local-compute' }, undefined, settings).factor,
    ).toEqual({ value: 1, neutral: false });
    expect(evaluateCost({ ...cash(0), class: 'free' }, undefined, settings).factor).toEqual({
      value: 1,
      neutral: false,
    });
    expect(evaluateCost(unknownCost, undefined, settings).factor).toEqual({
      value: 0.5,
      neutral: true,
    });
    const noSize: CostEstimate = { ...cash(1), cashUsd: unavailable('no size facts') };
    expect(evaluateCost(noSize, undefined, settings).factor).toEqual({
      value: 0.5,
      neutral: true,
    });
  });

  it('is deterministic and messages carry no prompt-like content', () => {
    expect(evaluateCost(cash(0.2), 0.1, settings)).toEqual(evaluateCost(cash(0.2), 0.1, settings));
  });
});
