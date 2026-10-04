import {
  adapterId,
  estimated,
  isNexarError,
  resourceId,
  taskId,
  type CandidateAssessment,
  type ControlEngine,
  type LaneRole,
  type QualityClass,
  type ResourceDescriptor,
  type ResourceSnapshot,
  type ResourceState,
  type RoutingInput,
  type RoutingPolicy,
  type StrategyLedger,
  type UnitStrategy,
  type WorkGraph,
  type WorkUnit,
} from '@nexar/contracts';
import { describe, expect, it } from 'vitest';
import {
  DEFAULT_RESOURCE_INTELLIGENCE_SETTINGS,
  DEFAULT_TASK_KIND_RULES,
  ResourceIntelligencePolicy,
  STRATEGY_POLICY,
  allocateNext,
  planStrategy,
  revalidate,
} from './index.js';

const NOW = new Date('2026-03-01T12:00:00.000Z');
const CAPS = [
  'text-generation',
  'knowledge-work',
  'reasoning',
  'coding',
  'repo-editing',
  'code-review',
];

function snap(
  id: string,
  d: Partial<ResourceDescriptor> = {},
  s: Partial<ResourceState> = {},
): ResourceSnapshot {
  return {
    descriptor: {
      id: resourceId(id),
      displayName: id,
      kind: { type: 'model', provider: 'acme', model: id, access: 'api' },
      capabilities: [...CAPS, 'model-turn'],
      runtime: { adapter: adapterId('test'), locality: 'remote' },
      auth: { mode: 'none' },
      cost: { model: 'free' },
      dataLocality: 'third-party',
      ...d,
    },
    state: {
      availability: 'available',
      auth: 'authenticated',
      observedAt: '2026-01-01T00:00:00.000Z',
      ...s,
    },
  };
}

const agent = (id: string, name: string, d: Partial<ResourceDescriptor> = {}): ResourceSnapshot =>
  snap(id, {
    kind: { type: 'agent', agent: name, interface: 'cli' },
    cost: { model: 'subscription' },
    capabilities: CAPS,
    ...d,
  });
const api = (id: string): ResourceSnapshot =>
  snap(id, {
    cost: {
      model: 'per-token',
      currency: 'USD',
      inputPerMillionTokens: 3,
      outputPerMillionTokens: 15,
    },
  });
const local = (id: string): ResourceSnapshot =>
  snap(id, {
    kind: { type: 'model', provider: 'ollama', model: id, access: 'local' },
    cost: { model: 'local-compute' },
    dataLocality: 'local',
  });

function policy(): ResourceIntelligencePolicy {
  return new ResourceIntelligencePolicy({
    taskKinds: DEFAULT_TASK_KIND_RULES,
    settings: DEFAULT_RESOURCE_INTELLIGENCE_SETTINGS,
  });
}

/** Wraps a policy so chosen resources carry a known cash estimate (the planner has no size facts). */
function withCash(inner: RoutingPolicy, cash: Record<string, number>): RoutingPolicy {
  return {
    name: inner.name,
    version: inner.version,
    evaluate: (input) =>
      inner.evaluate(input).map((a) => {
        const usd = cash[a.resourceId];
        if (usd === undefined || a.cost === undefined) return a;
        return { ...a, cost: { ...a.cost, class: 'cash', cashUsd: estimated(usd, 'test') } };
      }),
  };
}

function unit(
  unitId: string,
  extra: Partial<Omit<WorkUnit, 'unitId' | 'task'>> & { requirements?: object } = {},
): WorkUnit {
  const { requirements, ...rest } = extra;
  return {
    unitId,
    task: {
      id: taskId(`task-${unitId}`),
      kind: 'general',
      requirements: { capabilities: [], ...requirements },
    },
    ...rest,
  };
}

const graph = (units: WorkUnit[], extra: Partial<WorkGraph> = {}): WorkGraph => ({
  graphId: 'g1',
  units,
  ...extra,
});
const common = { now: NOW };
const selectedId = (u: UnitStrategy | undefined): string | undefined =>
  u?.decision.outcome === 'selected' ? u.decision.selected.resourceId : undefined;
const eligibleIds = (u: UnitStrategy): string[] =>
  u.decision.outcome === 'selected'
    ? [u.decision.selected, ...u.decision.alternatives].map((a) => a.resourceId)
    : [];
const find = (units: readonly UnitStrategy[], id: string): UnitStrategy | undefined =>
  units.find((u) => u.unitId === id);

describe('planStrategy examples', () => {
  const candidates = [agent('sub', 'claude-code'), api('api-a'), api('api-b'), local('loc')];

  it('spreads an SOW-like graph with explainable reasons', () => {
    const g = graph([
      unit('review', { reviewOf: 'draft', qualityClass: 'standard' }),
      unit('draft', { dependsOn: ['synthesize'], qualityClass: 'high' }),
      unit('synthesize', { dependsOn: ['extract'], qualityClass: 'high' }),
      unit('extract', { qualityClass: 'basic' }),
    ]);
    const s = planStrategy({ graph: g, candidates, policy: policy(), ...common });

    expect(s.units.map((u) => u.unitId)).toEqual(['extract', 'synthesize', 'draft', 'review']);
    expect(s.policy).toMatchObject({ ...STRATEGY_POLICY, base: { name: 'resource-intelligence' } });
    expect(s.policy.configId).toMatch(/^[0-9a-f]{12}$/);
    expect(s.decidedAt).toBe(NOW.toISOString());

    const picks = s.units.map((u) => selectedId(u));
    expect(picks).toEqual(['loc', 'sub', 'loc', 'sub']);

    const extract = find(s.units, 'extract')?.decision;
    if (extract?.outcome !== 'selected') throw new Error('expected selection');
    expect(extract.selected.reasons.map((r) => r.code)).toContain('strategy.quality-fit');
    const review = find(s.units, 'review')?.decision;
    if (review?.outcome !== 'selected') throw new Error('expected selection');
    const draftLoc = review.alternatives.find((a) => a.resourceId === 'loc');
    expect(draftLoc?.reasons.map((r) => r.code)).toContain('strategy.diversity');
    expect(draftLoc?.reasons.map((r) => r.code)).toContain('strategy.balance');
    expect(draftLoc?.factors?.map((f) => f.name)).toContain('strategy.diversity');
  });

  it('plans a code lane graph; required diversity keeps the reviewer off the implementer', () => {
    const g = graph(
      [
        unit('feature', { laneRole: 'feature' as LaneRole, qualityClass: 'high' }),
        unit('tests', { laneRole: 'tests' as LaneRole, dependsOn: ['feature'] }),
        unit('review', {
          laneRole: 'review' as LaneRole,
          reviewOf: 'feature',
          dependsOn: ['tests'],
        }),
      ],
      { reviewDiversity: 'required' },
    );
    const s = planStrategy({ graph: g, candidates, policy: policy(), ...common });
    expect(s.units.map((u) => u.unitId)).toEqual(['feature', 'tests', 'review']);
    expect(selectedId(find(s.units, 'review'))).not.toBe(selectedId(find(s.units, 'feature')));
    const review = find(s.units, 'review')?.decision;
    const rejected = review?.rejected.find(
      (r) => r.resourceId === selectedId(find(s.units, 'feature')),
    );
    expect(
      rejected?.reasons.some((r) => r.code === 'strategy.diversity' && r.effect === 'rejects'),
    ).toBe(true);
  });

  it('yields no-eligible-resource when required diversity leaves nothing', () => {
    const g = graph([unit('a'), unit('r', { reviewOf: 'a' })], { reviewDiversity: 'required' });
    const s = planStrategy({ graph: g, candidates: [local('only')], policy: policy(), ...common });
    expect(selectedId(find(s.units, 'a'))).toBe('only');
    expect(find(s.units, 'r')?.decision.outcome).toBe('no-eligible-resource');
  });

  it('ranks an experimental connection after its official twin, and only when allowed', () => {
    const official = agent('official', 'claude-code');
    const experimental = agent('exp', 'antigravity');
    const g = graph([unit('u')]);
    const off = planStrategy({
      graph: g,
      candidates: [experimental, official],
      policy: policy(),
      ...common,
    });
    expect(eligibleIds(off.units[0] as UnitStrategy)).toEqual(['official']);
    const rejected = off.units[0]?.decision.rejected.find((r) => r.resourceId === 'exp');
    expect(rejected?.reasons.some((r) => r.code === 'strategy.experimental')).toBe(true);

    const on = planStrategy({
      graph: g,
      candidates: [experimental, official],
      policy: policy(),
      settings: { allowExperimental: true },
      ...common,
    });
    expect(eligibleIds(on.units[0] as UnitStrategy)).toEqual(['official', 'exp']);
  });

  it('restricts control units to control-compatible resources', () => {
    const noTurn = snap('no-turn', { capabilities: CAPS });
    const g = graph([unit('c', { control: 'openworker' }), unit('plain')]);
    const s = planStrategy({
      graph: g,
      candidates: [noTurn, api('turn')],
      policy: policy(),
      ...common,
    });
    expect(eligibleIds(find(s.units, 'c') as UnitStrategy)).toEqual(['turn']);
    expect(eligibleIds(find(s.units, 'plain') as UnitStrategy).sort()).toEqual(['no-turn', 'turn']);
  });

  it('rejects candidates whose known cash estimate exceeds the remaining budget', () => {
    const p = withCash(policy(), { 'api-a': 0.6, 'api-b': 0.3 });
    const g = graph([unit('one'), unit('two', { dependsOn: ['one'] })], { budgetUsd: 0.5 });
    const s = planStrategy({
      graph: g,
      candidates: [api('api-a'), api('api-b')],
      policy: p,
      ...common,
    });
    expect(eligibleIds(find(s.units, 'one') as UnitStrategy)).toEqual(['api-b']);
    expect(selectedId(find(s.units, 'one'))).toBe('api-b');
    // 0.3 spent: 0.2 remains, so api-b (0.3) no longer fits.
    expect(find(s.units, 'two')?.decision.outcome).toBe('no-eligible-resource');
    const codes = find(s.units, 'two')?.decision.rejected.flatMap((r) =>
      r.reasons.map((x) => x.code),
    );
    expect(codes).toContain('strategy.budget');
  });

  it('leaves unknown cost under a budget to the base policy', () => {
    const g = graph([unit('one')], { budgetUsd: 0.5 });
    const s = planStrategy({ graph: g, candidates: [api('api-a')], policy: policy(), ...common });
    expect(selectedId(s.units[0])).toBe('api-a');
  });
});

describe('graph validation', () => {
  const run = (g: WorkGraph): unknown => {
    try {
      planStrategy({ graph: g, candidates: [local('l')], policy: policy(), ...common });
    } catch (e) {
      return e;
    }
    return undefined;
  };
  const code = (e: unknown): string | undefined => (isNexarError(e) ? e.code : undefined);

  it('rejects duplicate ids, unknown references, self-dependencies and cycles', () => {
    expect(code(run(graph([unit('a'), unit('a')])))).toBe('VALIDATION_ERROR');
    expect(code(run(graph([unit('a', { dependsOn: ['x'] })])))).toBe('VALIDATION_ERROR');
    expect(code(run(graph([unit('a', { reviewOf: 'x' })])))).toBe('VALIDATION_ERROR');
    expect(code(run(graph([unit('a', { dependsOn: ['a'] })])))).toBe('VALIDATION_ERROR');
    expect(code(run(graph([unit('a', { dependsOn: ['b'] }), unit('b', { reviewOf: 'a' })])))).toBe(
      'VALIDATION_ERROR',
    );
  });

  it('rejects invalid budgets, settings and clocks', () => {
    expect(code(run(graph([unit('a')], { budgetUsd: -1 })))).toBe('VALIDATION_ERROR');
    expect(code(run(graph([unit('a')], { budgetUsd: Number.NaN })))).toBe('VALIDATION_ERROR');
    const bad = (): unknown =>
      planStrategy({
        graph: graph([unit('a')]),
        candidates: [local('l')],
        policy: policy(),
        settings: { balancePenalty: -1 },
        ...common,
      });
    expect(() => bad()).toThrow(/balancePenalty/);
    expect(() =>
      planStrategy({
        graph: graph([unit('a')]),
        candidates: [local('l')],
        policy: policy(),
        now: new Date(Number.NaN),
      }),
    ).toThrow(/clock/);
  });

  it('orders by dependency, then quality class, then input order', () => {
    const g = graph([
      unit('n'),
      unit('b', { qualityClass: 'basic' }),
      unit('s', { qualityClass: 'standard' }),
      unit('h', { qualityClass: 'high' }),
      unit('h2', { qualityClass: 'high' }),
      unit('late', { qualityClass: 'high', dependsOn: ['n'] }),
    ]);
    const s = planStrategy({ graph: g, candidates: [local('l')], policy: policy(), ...common });
    expect(s.units.map((u) => u.unitId)).toEqual(['h', 'h2', 's', 'b', 'n', 'late']);
  });
});

describe('allocateNext', () => {
  it('reproduces planStrategy step by step', () => {
    const candidates = [agent('sub', 'claude-code'), api('api-a'), local('loc')];
    const p = withCash(policy(), { 'api-a': 0.2 });
    const units = [
      unit('a', { qualityClass: 'basic' }),
      unit('b', { dependsOn: ['a'], qualityClass: 'high' }),
      unit('c', { reviewOf: 'b', dependsOn: ['b'] }),
    ];
    const g = graph(units, { budgetUsd: 1, reviewDiversity: 'required' });
    const plan = planStrategy({ graph: g, candidates, policy: p, ...common });

    let ledger: StrategyLedger = {
      graphId: 'g1',
      allocations: [],
      spentUsd: 0,
      budgetUsd: 1,
      reviewDiversity: 'required',
    };
    for (const planned of plan.units) {
      const u = units.find((x) => x.unitId === planned.unitId) as WorkUnit;
      const next = allocateNext({ ledger, unit: u, candidates, policy: p, ...common });
      expect(next.decision).toEqual(planned.decision);
      expect(next.ledger).not.toBe(ledger);
      ledger = next.ledger;
    }
    expect(ledger.allocations.map((a) => a.unitId)).toEqual(['a', 'b', 'c']);
  });

  it('does not mutate the ledger and rejects a repeated unit', () => {
    const candidates = [local('loc')];
    const ledger: StrategyLedger = {
      graphId: 'g',
      allocations: [],
      spentUsd: 0,
      reviewDiversity: 'preferred',
    };
    const first = allocateNext({
      ledger,
      unit: unit('a'),
      candidates,
      policy: policy(),
      ...common,
    });
    expect(ledger.allocations).toHaveLength(0);
    expect(first.ledger.allocations).toEqual([
      { unitId: 'a', resourceId: 'loc', estimatedCostUsd: 0 },
    ]);
    expect(() =>
      allocateNext({
        ledger: first.ledger,
        unit: unit('a'),
        candidates,
        policy: policy(),
        ...common,
      }),
    ).toThrow(/already allocated/);
  });

  it('leaves the ledger unchanged when nothing is eligible', () => {
    const ledger: StrategyLedger = {
      graphId: 'g',
      allocations: [],
      spentUsd: 0,
      reviewDiversity: 'preferred',
    };
    const r = allocateNext({
      ledger,
      unit: unit('a'),
      candidates: [snap('down', {}, { availability: 'unavailable' })],
      policy: policy(),
      ...common,
    });
    expect(r.decision.outcome).toBe('no-eligible-resource');
    expect(r.ledger).toBe(ledger);
  });
});

describe('revalidate', () => {
  const candidates = [api('a'), api('b'), api('c')];
  const u = unit('u');
  const planned = (): UnitStrategy =>
    planStrategy({ graph: graph([u]), candidates, policy: policy(), ...common })
      .units[0] as UnitStrategy;

  it('keeps the planned resource while it is eligible', () => {
    const p = planned();
    const r = revalidate({ planned: p, unit: u, candidates, policy: policy(), ...common });
    expect(selectedId({ unitId: 'u', decision: r.decision })).toBe(selectedId(p));
    expect(r.fallback).toBeUndefined();
    if (r.decision.outcome !== 'selected') throw new Error('expected selection');
    expect(r.decision.selected.reasons.map((x) => x.code)).toContain('strategy.revalidated');
  });

  it('falls back along the planned order and records why', () => {
    const p = planned();
    const first = selectedId(p) as string;
    const second = eligibleIds(p)[1] as string;
    const now = candidates.map((c) =>
      c.descriptor.id === first ? snap(first, c.descriptor, { availability: 'unavailable' }) : c,
    );
    const r = revalidate({ planned: p, unit: u, candidates: now, policy: policy(), ...common });
    expect(r.fallback).toEqual({ from: first, reason: 'state.unavailable' });
    expect(selectedId({ unitId: 'u', decision: r.decision })).toBe(second);
    if (r.decision.outcome !== 'selected') throw new Error('expected selection');
    expect(r.decision.selected.reasons.some((x) => x.code === 'strategy.fallback')).toBe(true);
    expect(r.decision.rejected.map((x) => x.resourceId)).toContain(first);
  });

  it('never selects a resource the plan rejected', () => {
    const wide = [api('a'), api('b'), snap('late', { capabilities: [] })];
    const p = planStrategy({ graph: graph([u]), candidates: wide, policy: policy(), ...common })
      .units[0] as UnitStrategy;
    expect(p.decision.rejected.map((x) => x.resourceId)).toEqual(['late']);
    // 'late' now has every capability, but the plan's hard filters rejected it.
    const now = [api('a'), api('b'), api('late')];
    const down = now.map((c) =>
      c.descriptor.id === 'a' || c.descriptor.id === 'b'
        ? snap(c.descriptor.id, c.descriptor, { availability: 'unavailable' })
        : c,
    );
    const r = revalidate({ planned: p, unit: u, candidates: down, policy: policy(), ...common });
    expect(r.decision.outcome).toBe('no-eligible-resource');
    expect(
      r.decision.rejected.find((x) => x.resourceId === 'late')?.reasons.map((x) => x.code),
    ).toContain('strategy.plan-rejected');
  });

  it('is no-eligible-resource when nothing remains', () => {
    const p = planned();
    const gone = candidates.map((c) =>
      snap(c.descriptor.id, c.descriptor, { availability: 'unavailable' }),
    );
    const r = revalidate({ planned: p, unit: u, candidates: gone, policy: policy(), ...common });
    expect(r.decision.outcome).toBe('no-eligible-resource');
    expect(r.fallback).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------------------------
// Seeded invariants
// ---------------------------------------------------------------------------------------------

/** Small seeded PRNG (mulberry32) so the cases are reproducible. */
function rng(seed: number): () => number {
  let a = seed;
  return () => {
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function pick<T>(r: () => number, items: readonly T[]): T {
  return items[Math.floor(r() * items.length)] as T;
}

function randomCandidates(r: () => number): ResourceSnapshot[] {
  const n = 2 + Math.floor(r() * 5);
  return Array.from({ length: n }, (_, i) => {
    const id = `r${String(i)}`;
    const base = pick(r, [
      () => api(id),
      () => local(id),
      () => agent(id, pick(r, ['claude-code', 'codex', 'antigravity'])),
      () => snap(id, { capabilities: CAPS }),
    ])();
    return snap(id, base.descriptor, {
      availability: pick(r, [
        'available',
        'available',
        'degraded',
        'unavailable',
        'unknown',
      ] as const),
    });
  });
}

function randomGraph(r: () => number): WorkGraph {
  const n = 1 + Math.floor(r() * 6);
  const units: WorkUnit[] = [];
  for (let i = 0; i < n; i++) {
    const earlier = units.map((u) => u.unitId);
    const dependsOn = earlier.filter(() => r() < 0.3);
    const reviewOf = earlier.length > 0 && r() < 0.4 ? pick(r, earlier) : undefined;
    const qualityClass = pick<QualityClass | undefined>(r, [
      'basic',
      'standard',
      'high',
      undefined,
    ]);
    const control = r() < 0.25 ? pick<ControlEngine>(r, ['openworker', 'dsh']) : undefined;
    units.push(
      unit(`u${String(i)}`, {
        dependsOn,
        ...(reviewOf === undefined ? {} : { reviewOf }),
        ...(qualityClass === undefined ? {} : { qualityClass }),
        ...(control === undefined ? {} : { control }),
      }),
    );
  }
  // Input order is shuffled; the planner must still order by dependency.
  for (let i = units.length - 1; i > 0; i--) {
    const j = Math.floor(r() * (i + 1));
    [units[i], units[j]] = [units[j] as WorkUnit, units[i] as WorkUnit];
  }
  return graph(units, {
    reviewDiversity: pick(r, ['preferred', 'required'] as const),
    ...(r() < 0.5 ? { budgetUsd: r() } : {}),
  });
}

function shuffled<T>(r: () => number, items: readonly T[]): T[] {
  const out = [...items];
  for (let i = out.length - 1; i > 0; i--) {
    const j = Math.floor(r() * (i + 1));
    [out[i], out[j]] = [out[j] as T, out[i] as T];
  }
  return out;
}

describe('seeded invariants', () => {
  const cash = { r0: 0.2, r1: 0.4, r2: 0.1 };

  for (let seed = 1; seed <= 60; seed++) {
    it(`holds for seed ${String(seed)}`, () => {
      const r = rng(seed);
      const candidates = randomCandidates(r);
      const g = randomGraph(r);
      const settings = { allowExperimental: r() < 0.5 };
      const p = withCash(policy(), cash);
      const s = planStrategy({ graph: g, candidates, policy: p, settings, ...common });

      // Deterministic, and independent of candidate input order.
      const again = planStrategy({
        graph: g,
        candidates: shuffled(r, candidates),
        policy: p,
        settings,
        ...common,
      });
      expect(again).toEqual(s);

      expect(s.units.map((u) => u.unitId).sort()).toEqual(g.units.map((u) => u.unitId).sort());
      const byUnit = new Map(g.units.map((u) => [u.unitId, u]));
      for (const planned of s.units) {
        const u = byUnit.get(planned.unitId) as WorkUnit;
        const input: RoutingInput = {
          task: u.task,
          candidates,
          facts: { now: NOW.toISOString() },
        };
        const base = p.evaluate(input);
        const policyEligible = new Set(base.filter((a) => a.eligible).map((a) => a.resourceId));
        const d = planned.decision;

        // Never re-admits a candidate the policy rejected; every candidate is accounted for.
        for (const id of eligibleIds(planned)) expect(policyEligible.has(id as never)).toBe(true);
        expect([...eligibleIds(planned), ...d.rejected.map((x) => x.resourceId)].sort()).toEqual(
          candidates.map((c) => c.descriptor.id as string).sort(),
        );
        for (const rej of d.rejected) expect(rej.eligible).toBe(false);

        const snapOf = (id: string): ResourceSnapshot =>
          candidates.find((c) => c.descriptor.id === id) as ResourceSnapshot;
        for (const id of eligibleIds(planned)) {
          const desc = snapOf(id).descriptor;
          if (u.control !== undefined) expect(desc.capabilities).toContain('model-turn');
          if (!settings.allowExperimental) {
            expect(desc.kind.type === 'agent' && desc.kind.agent === 'antigravity').toBe(false);
          }
        }

        // `required` diversity never selects the reviewed unit's resource.
        if (g.reviewDiversity === 'required' && u.reviewOf !== undefined) {
          const reviewed = selectedId(find(s.units, u.reviewOf));
          if (reviewed !== undefined) expect(eligibleIds(planned)).not.toContain(reviewed);
        }
      }
    });
  }

  it('a plan budget only narrows the eligible set at the same ledger', () => {
    for (let seed = 100; seed < 140; seed++) {
      const r = rng(seed);
      const candidates = randomCandidates(r);
      const p = withCash(policy(), cash);
      const u = unit('x');
      const open: StrategyLedger = {
        graphId: 'g',
        allocations: [],
        spentUsd: 0,
        reviewDiversity: 'preferred',
      };
      const capped: StrategyLedger = { ...open, budgetUsd: r() * 0.5, spentUsd: r() * 0.1 };
      const wide = allocateNext({ ledger: open, unit: u, candidates, policy: p, ...common });
      const narrow = allocateNext({ ledger: capped, unit: u, candidates, policy: p, ...common });
      const ids = (d: typeof wide.decision): string[] =>
        d.outcome === 'selected'
          ? [d.selected, ...d.alternatives].map((a: CandidateAssessment) => a.resourceId)
          : [];
      const wideIds = new Set(ids(wide.decision));
      for (const id of ids(narrow.decision)) expect(wideIds.has(id)).toBe(true);
    }
  });
});

describe('planStrategy ordering and size (Opus review)', () => {
  const experimental = (id: string): ResourceSnapshot =>
    snap(id, {
      metadata: {
        connection: {
          id: `${id}.conn`,
          provider: 'acme',
          method: 'subscription',
          authClass: 'experimental-client-compat',
          support: 'experimental',
        },
      },
    });

  it('ranks official before experimental strictly, even without the soft penalty', () => {
    // `a-exp` would win the id tie-break; support class must decide first.
    const strategy = planStrategy({
      graph: graph([unit('one')]),
      candidates: [experimental('a-exp'), snap('b-off')],
      policy: policy(),
      settings: { allowExperimental: true, experimentalPenalty: 0 },
      ...common,
    });
    expect(eligibleIds(strategy.units[0]!)).toEqual(['b-off', 'a-exp']);
  });

  it("keeps the unit's explicit preference order ahead of plan factors", () => {
    const prefer = {
      requirements: { preferredResourceIds: [resourceId('api-b'), resourceId('api-a')] },
    };
    const strategy = planStrategy({
      graph: graph([unit('one', prefer), unit('two', { ...prefer, dependsOn: ['one'] })]),
      candidates: [api('api-a'), api('api-b')],
      policy: policy(),
      ...common,
    });
    // The balance penalty on the second allocation of api-b must not outrank the owner's order.
    expect(selectedId(find(strategy.units, 'one'))).toBe('api-b');
    expect(selectedId(find(strategy.units, 'two'))).toBe('api-b');
  });

  it('lets the plan budget act on per-token resources once the unit has a size', () => {
    const size = {
      estimatedInputTokens: 1_000_000,
      attachmentCount: 0,
      documentCount: 0,
      requestedMaxOutputTokens: 1_000_000,
      basis: 'test',
    };
    const plan = (withSize: boolean) =>
      planStrategy({
        graph: graph([unit('one', withSize ? { size } : {})], { budgetUsd: 1 }),
        candidates: [api('api-a'), local('loc')],
        policy: policy(),
        ...common,
      });
    const sized = plan(true).units[0]!;
    expect(eligibleIds(sized)).toEqual(['loc']);
    expect(
      sized.decision.rejected.find((r) => r.resourceId === 'api-a')?.reasons.map((r) => r.code),
    ).toContain('strategy.budget');
    expect(eligibleIds(plan(false).units[0]!)).toContain('api-a');
  });
});
