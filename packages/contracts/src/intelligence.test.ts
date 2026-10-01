import { describe, expect, expectTypeOf, it } from 'vitest';
import { unavailable } from './index.js';
import type {
  CandidateAssessment,
  CostEstimate,
  ExecutionResult,
  QuotaObservation,
  QuotaUsageSource,
  RoutingInput,
  TaskRequirements,
  TelemetryEvent,
} from './index.js';

describe('resource intelligence contracts', () => {
  it('quota provenance is limited to legitimate sources', () => {
    expectTypeOf<QuotaUsageSource>().toEqualTypeOf<
      'vendor-probe' | 'vendor-reported' | 'nexar-accounting'
    >();
    expectTypeOf<{ provenance: { usage: 'scraped' } }>().not.toExtend<
      Pick<QuotaObservation, 'provenance'>
    >();
  });

  it('an unknown cost is unavailable, never a fabricated zero', () => {
    const estimate: CostEstimate = {
      class: 'unknown',
      cashUsd: unavailable('no rates'),
      inputTokens: 10,
      outputTokens: 20,
      estimator: 'estimator@1',
    };
    expect(estimate.cashUsd.status).toBe('unavailable');
  });

  it('routing inputs, requirements and results gain only optional fields', () => {
    expectTypeOf<RoutingInput['facts']>().toBeNullable();
    expectTypeOf<RoutingInput['history']>().toBeNullable();
    expectTypeOf<TaskRequirements['requireKnownQuota']>().toBeNullable();
    expectTypeOf<CandidateAssessment['factors']>().toBeNullable();
    expectTypeOf<ExecutionResult['quotaObservations']>().toBeNullable();
  });

  it('telemetry has a quota.observed event', () => {
    expectTypeOf<Extract<TelemetryEvent, { type: 'quota.observed' }>>().not.toBeNever();
  });
});
