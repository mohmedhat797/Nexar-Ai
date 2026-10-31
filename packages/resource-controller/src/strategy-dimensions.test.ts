import {
  adapterId,
  resourceId,
  taskId,
  resolveReviewDimensions,
  type ReviewDimensions,
  type ResourceSnapshot,
  type StrategyLedger,
  type WorkUnit,
} from '@nexar/contracts';
import { catalogResourceId } from '@nexar/resource-registry';
import { describe, expect, it } from 'vitest';
import {
  allocateNext,
  planStrategy,
  revalidate,
  reviewIdentityOf,
  ResourceIntelligencePolicy,
  DEFAULT_RESOURCE_INTELLIGENCE_SETTINGS,
  DEFAULT_TASK_KIND_RULES,
  requireSelected,
  explainRouteDecision,
} from './index.js';

const now = new Date('2026-10-21T00:00:00.000Z');
const policy = new ResourceIntelligencePolicy({
  taskKinds: DEFAULT_TASK_KIND_RULES,
  settings: DEFAULT_RESOURCE_INTELLIGENCE_SETTINGS,
});
const settings = { balancePenalty: 0, basicCheapBonus: 0 };
const connectionA = 'openai.api.caaaaaaaaaa',
  connectionB = 'openai.api.cbbbbbbbbbb';
const connectionC = 'anthropic.api.cccccccccc';
function snapshot(
  connectionId: string,
  provider: string,
  model = 'fixture',
  host: 'desktop' | 'plane' = 'desktop',
): ResourceSnapshot {
  return {
    descriptor: {
      id: catalogResourceId({ id: connectionId, machine: host, builtIn: false }, provider, model),
      displayName: 'Untrusted display label',
      kind: { type: 'model', provider, model, access: 'api' },
      capabilities: ['text-generation', 'reasoning', 'code-review', 'model-turn'],
      runtime: { adapter: adapterId('fixture'), locality: 'remote' },
      auth: { mode: 'none' },
      cost: { model: 'free' },
      dataLocality: 'third-party',
      metadata: {
        connection: {
          id: connectionId,
          provider,
          method: 'api',
          authClass: 'official-api',
          support: 'official',
        },
        connectionHost: host,
      },
    },
    state: { availability: 'available', auth: 'not-required', observedAt: now.toISOString() },
  };
}
const a = snapshot(connectionA, 'openai'),
  a2 = snapshot(connectionA, 'openai', 'second');
const b = snapshot(connectionB, 'openai'),
  c = snapshot(connectionC, 'anthropic');
const unknown: ResourceSnapshot = {
  ...a,
  descriptor: {
    ...a.descriptor,
    id: resourceId('unknown'),
    kind: { type: 'agent', agent: 'unknown', interface: 'cli' },
    metadata: {},
  },
};
const unit = (id: string, reviewOf?: string, preferred?: ResourceSnapshot): WorkUnit => ({
  unitId: id,
  ...(reviewOf === undefined ? {} : { reviewOf }),
  task: {
    id: taskId(id),
    kind: 'general',
    requirements: {
      capabilities: ['text-generation'],
      ...(preferred === undefined ? {} : { preferredResourceIds: [preferred.descriptor.id] }),
    },
  },
});
const write = unit('write', undefined, a),
  review = unit('review', 'write');
const ctx = { policy, settings, now };
function ledger(dimensions: ReviewDimensions, record = true): StrategyLedger {
  const resolved = resolveReviewDimensions(dimensions)!;
  const initial: StrategyLedger = {
    graphId: 'g',
    reviewDiversity: resolved.resource ?? 'preferred',
    reviewDimensions: resolved,
    spentUsd: 0,
    allocations: [],
  };
  return record
    ? allocateNext({ ...ctx, ledger: initial, unit: write, candidates: [a] }).ledger
    : initial;
}
const pick = (d: ReturnType<typeof allocateNext>['decision']) =>
  d.outcome === 'selected' ? d.selected.resourceId : undefined;

describe('TST-20 complete dimension/mode/availability matrix', () => {
  for (const dimension of ['resource', 'connection', 'provider'] as const) {
    for (const mode of ['preferred', 'required'] as const) {
      for (const availability of ['satisfiable', 'unsatisfiable', 'unknown'] as const) {
        it(`${dimension}/${mode}/${availability}`, () => {
          const dimensions = { [dimension]: mode } as ReviewDimensions;
          const diverse = dimension === 'resource' ? a2 : dimension === 'connection' ? b : c;
          const same = dimension === 'resource' ? a : dimension === 'connection' ? a2 : b;
          const candidates =
            availability === 'satisfiable'
              ? [a, diverse]
              : availability === 'unsatisfiable'
                ? same === a
                  ? [a]
                  : [a, same]
                : [dimension === 'resource' ? a : unknown];
          const before = ledger(
            dimensions,
            !(dimension === 'resource' && availability === 'unknown'),
          );
          const next = allocateNext({ ...ctx, ledger: before, unit: review, candidates });
          if (mode === 'required' && availability !== 'satisfiable') {
            expect(next.decision.outcome).toBe('no-eligible-resource');
            if (next.decision.outcome !== 'no-eligible-resource')
              throw Error('unexpected selection');
            expect(next.decision.reasons?.map((r) => r.code)).toContain(
              `strategy.diversity.${dimension}.unavailable`,
            );
            expect(next.ledger.allocations).toEqual(before.allocations);
            expect(next.decision.rejected).toHaveLength(candidates.length);
            for (const rejected of next.decision.rejected)
              expect(rejected.reasons).toContainEqual(
                expect.objectContaining({
                  code: `strategy.diversity.${dimension}`,
                  effect: 'rejects',
                }),
              );
            let failure: unknown;
            try {
              requireSelected(next.decision);
            } catch (error) {
              failure = error;
            }
            expect(failure).toMatchObject({
              code: 'NO_ELIGIBLE_RESOURCE',
              details: { reasonCodes: [`strategy.diversity.${dimension}.unavailable`] },
            });
            expect(explainRouteDecision(next.decision)).toContain(
              `strategy.diversity.${dimension}.unavailable`,
            );
          } else {
            expect(pick(next.decision)).toBe(
              (availability === 'satisfiable'
                ? diverse
                : availability === 'unsatisfiable'
                  ? same
                  : dimension === 'resource'
                    ? a
                    : unknown
              ).descriptor.id,
            );
            if (next.decision.outcome !== 'selected') throw Error('expected selection');
            const reason = next.decision.selected.reasons.find(
              (r) => r.code === `strategy.diversity.${dimension}`,
            );
            expect(reason?.message).toContain(
              availability === 'satisfiable'
                ? 'distinct'
                : availability === 'unknown'
                  ? 'unknown'
                  : 'same',
            );
            expect(reason?.effect).toBe(availability === 'satisfiable' ? 'supports' : 'neutral');
          }
          expect(next.strategy?.reviewContext?.dimensions[dimension]).toBe(mode);
          expect(next.strategy?.reviewContext?.reviewed?.resourceId).toBe(
            before.allocations[0]?.resourceId,
          );
        });
      }
    }
  }
});

describe('C′ configuration, ranking and identity safety', () => {
  it.each([
    {},
    { host: 'required' },
    { provider: 'maybe' },
    { provider: undefined },
    ['provider'],
    null,
    { secret: 'not-a-dimension' },
  ])('rejects invalid dimensions %j', (value) =>
    expect(() => resolveReviewDimensions(value)).toThrow(
      expect.objectContaining({ code: 'VALIDATION_ERROR' }),
    ),
  );
  it('rejects contradictory explicit resource modes', () =>
    expect(() => resolveReviewDimensions({ resource: 'required' }, 'preferred')).toThrow());
  it('keeps owner preference ahead of preferred dimensions, but never ahead of required filters', () => {
    const preferred = allocateNext({
      ...ctx,
      ledger: ledger({ provider: 'preferred' }),
      unit: unit('review', 'write', a),
      candidates: [a, c],
    });
    expect(pick(preferred.decision)).toBe(a.descriptor.id);
    const required = allocateNext({
      ...ctx,
      ledger: ledger({ provider: 'required' }),
      unit: unit('review', 'write', a),
      candidates: [a, c],
    });
    expect(pick(required.decision)).toBe(c.descriptor.id);
  });
  it('applies required connection and preferred provider together', () => {
    const next = allocateNext({
      ...ctx,
      ledger: ledger({ connection: 'required', provider: 'preferred' }),
      unit: review,
      candidates: [a, b, c],
    });
    expect(pick(next.decision)).toBe(c.descriptor.id);
    expect(next.decision.rejected.map((r) => r.resourceId)).toContain(a.descriptor.id);
  });
  it('does not discard one of two required dimensions', () => {
    const next = allocateNext({
      ...ctx,
      ledger: ledger({ connection: 'required', provider: 'required' }),
      unit: review,
      candidates: [a, b],
    });
    expect(next.decision.outcome).toBe('no-eligible-resource');
    if (next.decision.outcome !== 'no-eligible-resource') throw Error('selected');
    expect(next.decision.reasons?.map((r) => r.code)).toEqual([
      'strategy.diversity.provider.unavailable',
    ]);
  });
  it('does not misclassify base-filter failure as a diversity failure', () => {
    const next = allocateNext({
      ...ctx,
      ledger: ledger({ connection: 'required' }),
      unit: review,
      candidates: [{ ...b, state: { ...b.state, availability: 'unavailable' } }],
    });
    expect(next.decision.outcome).toBe('no-eligible-resource');
    if (next.decision.outcome !== 'no-eligible-resource') throw Error('selected');
    expect(next.decision.reasons).toBeUndefined();
    expect(next.decision.rejected[0]?.reasons.map((r) => r.code)).toContain('state.unavailable');
  });
  it('uses canonical provider fields, never labels or credential metadata', () => {
    const spoofed = {
      ...b,
      descriptor: {
        ...b.descriptor,
        displayName: 'Anthropic different account',
        metadata: {
          ...b.descriptor.metadata,
          secret: 'synthetic-private-sentinel',
          apiKey: 'synthetic-key-sentinel',
        },
      },
    };
    const next = allocateNext({
      ...ctx,
      ledger: ledger({ provider: 'required' }),
      unit: review,
      candidates: [spoofed],
    });
    expect(next.decision.outcome).toBe('no-eligible-resource');
    expect(JSON.stringify(next)).not.toContain('synthetic-private-sentinel');
    expect(JSON.stringify(next)).not.toContain('synthetic-key-sentinel');
  });
  it('rejects forged connection metadata against the accepted catalog identity', () => {
    const forged = {
      ...a,
      descriptor: {
        ...a.descriptor,
        metadata: {
          ...a.descriptor.metadata,
          connection: { ...(a.descriptor.metadata?.connection as object), id: connectionB },
        },
      },
    };
    expect(reviewIdentityOf(forged.descriptor)).toEqual({ resourceId: a.descriptor.id });
    const next = allocateNext({
      ...ctx,
      ledger: ledger({ connection: 'required' }),
      unit: review,
      candidates: [forged],
    });
    expect(next.decision.outcome).toBe('no-eligible-resource');
  });
  it('never treats malformed explicit identity as inferred independence', () => {
    const malformed = {
      ...c.descriptor,
      metadata: {
        connection: { id: 'anthropic.api', provider: 'anthropic' },
        connectionHost: 'desktop',
      },
    };
    expect(reviewIdentityOf(malformed)).toEqual({ resourceId: c.descriptor.id });
  });
  it('host qualifies attribution but cannot authorize cross-host reviewing', () => {
    const plane = snapshot(connectionA, 'openai', 'fixture', 'plane');
    const next = allocateNext({
      ...ctx,
      ledger: ledger({ connection: 'required' }),
      unit: review,
      candidates: [plane],
    });
    expect(next.decision.outcome).toBe('no-eligible-resource');
    expect(next.decision.rejected[0]?.reasons.map((r) => r.code)).toContain('strategy.review.host');
  });
  it('canonicalizes configuration order and ignores unrelated labels', () => {
    const graph = { graphId: 'g', units: [write, review] };
    const x = planStrategy({
      ...ctx,
      graph: { ...graph, reviewDimensions: { provider: 'required', connection: 'preferred' } },
      candidates: [a, c],
    });
    const y = planStrategy({
      ...ctx,
      graph: { ...graph, reviewDimensions: { connection: 'preferred', provider: 'required' } },
      candidates: [a, c].map((s) => ({
        ...s,
        descriptor: { ...s.descriptor, displayName: 'renamed' },
      })),
    });
    expect(x).toEqual(y);
    expect(x.policy.configId).not.toBe(
      planStrategy({ ...ctx, graph, candidates: [a, c] }).policy.configId,
    );
  });
});

describe('plan, dynamic allocation and revalidation parity', () => {
  it.each(['connection', 'provider'] as const)(
    'does not credit a candidate when the reviewed %s identity is unknown',
    (dimension) => {
      const before = {
        ...ledger({ [dimension]: 'required' }),
        allocations: [{ unitId: 'write', resourceId: a.descriptor.id }],
      };
      const next = allocateNext({ ...ctx, ledger: before, unit: review, candidates: [c] });
      expect(next.decision).toMatchObject({
        outcome: 'no-eligible-resource',
        reasons: [{ code: `strategy.diversity.${dimension}.unavailable` }],
      });
    },
  );
  it('rejects malformed historical resource identity rather than counting it as distinct', () => {
    const malformed = {
      ...ledger({ resource: 'required' }),
      allocations: [{ unitId: 'write', resourceId: undefined }],
    } as unknown as StrategyLedger;
    expect(() =>
      allocateNext({ ...ctx, ledger: malformed, unit: review, candidates: [a] }),
    ).toThrow(expect.objectContaining({ code: 'VALIDATION_ERROR' }));
  });
  it('rejects inherited dimension configuration and mismatched revalidation context', () => {
    const inherited: unknown = Object.assign(Object.create({ resource: 'required' }) as object, {
      provider: 'preferred',
    });
    expect(() => resolveReviewDimensions(inherited)).toThrow(
      expect.objectContaining({ code: 'VALIDATION_ERROR' }),
    );
    const planned = allocateNext({
      ...ctx,
      ledger: ledger({ connection: 'required' }),
      unit: review,
      candidates: [b],
    }).strategy!;
    expect(() =>
      revalidate({
        ...ctx,
        planned,
        unit: { ...review, reviewOf: 'unrelated' },
        candidates: [a, b],
      }),
    ).toThrow(expect.objectContaining({ code: 'VALIDATION_ERROR' }));
  });
  it.each(['connection', 'provider'] as const)(
    'preserves required %s at execution and across disappearing historical resources',
    (dimension) => {
      const alternative = dimension === 'connection' ? b : c;
      const dimensions = { [dimension]: 'required' } as ReviewDimensions;
      const candidates = [a, a2, alternative];
      const planned = planStrategy({
        ...ctx,
        graph: { graphId: 'g', units: [review, write], reviewDimensions: dimensions },
        candidates,
      });
      const dynamic = allocateNext({
        ...ctx,
        ledger: ledger(dimensions),
        unit: review,
        candidates,
      });
      expect(planned.units[1]?.decision).toEqual(dynamic.decision);
      expect(pick(dynamic.decision)).toBe(alternative.descriptor.id);
      const before = planned.units[1]!;
      const unavailable = revalidate({
        ...ctx,
        planned: before,
        unit: review,
        candidates: [
          a2,
          { ...alternative, state: { ...alternative.state, availability: 'unavailable' } },
        ],
      });
      expect(unavailable.decision.outcome).toBe('no-eligible-resource');
      if (unavailable.decision.outcome !== 'no-eligible-resource')
        throw Error('forbidden fallback');
      expect(unavailable.decision.reasons?.map((r) => r.code)).toContain(
        `strategy.diversity.${dimension}.unavailable`,
      );
      expect(unavailable.fallback).toBeUndefined();
      const gone = revalidate({ ...ctx, planned: before, unit: review, candidates: [alternative] });
      expect(pick(gone.decision)).toBe(alternative.descriptor.id);
      expect(before.reviewContext?.reviewed?.connectionId).toBe(connectionA);
      expect(Object.isFrozen(before.reviewContext?.reviewed)).toBe(true);
    },
  );
  it('never reconstructs unknown historical account identity from the current registry', () => {
    const old = {
      ...ledger({ connection: 'required' }),
      allocations: [{ unitId: 'write', resourceId: a.descriptor.id }],
    };
    const next = allocateNext({ ...ctx, ledger: old, unit: review, candidates: [a, b] });
    expect(next.decision.outcome).toBe('no-eligible-resource');
  });
  it('does not apply review constraints to unrelated units', () => {
    const next = allocateNext({
      ...ctx,
      ledger: ledger({ provider: 'required' }),
      unit: unit('ordinary'),
      candidates: [a],
    });
    expect(pick(next.decision)).toBe(a.descriptor.id);
    if (next.decision.outcome !== 'selected') throw Error('not selected');
    expect(
      next.decision.selected.reasons.some((r) => r.code.startsWith('strategy.diversity.')),
    ).toBe(false);
  });
});
