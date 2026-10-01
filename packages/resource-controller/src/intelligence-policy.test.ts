import {
  adapterId,
  resourceId,
  taskId,
  type CandidateAssessment,
  type CostProfile,
  type ExecutionAggregate,
  type LaneAggregate,
  type LaneRole,
  type QuotaObservation,
  type ResourceDescriptor,
  type ResourceSnapshot,
  type ResourceState,
  type RoutingFacts,
  type RoutingHistory,
  type RoutingInput,
  type TaskRequirements,
} from '@nexar/contracts';
import { describe, expect, it } from 'vitest';
import {
  DEFAULT_RESOURCE_INTELLIGENCE_SETTINGS,
  DEFAULT_TASK_KIND_RULES,
  DeterministicRoutingPolicy,
  ResourceIntelligencePolicy,
  applyHardFilters,
  type ResourceIntelligenceSettings,
} from './index.js';

const NOW = '2026-03-01T12:00:00.000Z';
const rid = resourceId;

function snap(
  id: string,
  d: Partial<ResourceDescriptor> = {},
  s: Partial<ResourceState> = {},
): ResourceSnapshot {
  return {
    descriptor: {
      id: rid(id),
      displayName: id,
      kind: { type: 'model', provider: 'acme', model: id, access: 'api' },
      capabilities: ['coding', 'repo-editing', 'text-generation'],
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

function input(
  candidates: ResourceSnapshot[],
  requirements: Partial<TaskRequirements> = {},
  extra: { kind?: string; facts?: Partial<RoutingFacts>; history?: RoutingHistory } = {},
): RoutingInput {
  return {
    task: {
      id: taskId('t1'),
      kind: extra.kind ?? 'coding',
      requirements: { capabilities: [], ...requirements },
    },
    candidates,
    facts: { now: NOW, ...extra.facts },
    ...(extra.history === undefined ? {} : { history: extra.history }),
  };
}

function settings(over: Partial<ResourceIntelligenceSettings> = {}): ResourceIntelligenceSettings {
  return { ...DEFAULT_RESOURCE_INTELLIGENCE_SETTINGS, ...over };
}

function policy(
  over: Partial<ResourceIntelligenceSettings> = {},
  config: { defaultResourceId?: string } = {},
): ResourceIntelligencePolicy {
  return new ResourceIntelligencePolicy({
    taskKinds: DEFAULT_TASK_KIND_RULES,
    ...(config.defaultResourceId === undefined
      ? {}
      : { defaultResourceId: rid(config.defaultResourceId) }),
    settings: settings(over),
  });
}

function history(
  executions: Record<string, Record<string, Partial<ExecutionAggregate>>> = {},
  lanes: Record<string, Partial<Record<LaneRole, LaneAggregate>>> = {},
): RoutingHistory {
  const full = Object.fromEntries(
    Object.entries(executions).map(([id, kinds]) => [
      id,
      Object.fromEntries(
        Object.entries(kinds).map(([kind, a]) => [
          kind,
          {
            samples: 0,
            successes: 0,
            resourceFaults: 0,
            timeouts: 0,
            costSamples: 0,
            ...a,
          } satisfies ExecutionAggregate,
        ]),
      ),
    ]),
  );
  return {
    windowStart: '2026-02-01T12:00:00.000Z',
    windowEnd: NOW,
    executions: full,
    lanes,
    skipped: 0,
  };
}

const ids = (as: readonly CandidateAssessment[]) => as.map((a) => a.resourceId as string);
const eligibleIds = (as: readonly CandidateAssessment[]) =>
  ids(as.filter((a) => a.eligible)).sort();
const factor = (a: CandidateAssessment, name: string) => a.factors?.find((f) => f.name === name);
const codes = (a: CandidateAssessment) => a.reasons.map((r) => r.code);

describe('identity and configId', () => {
  it('is resource-intelligence@1 with a 12-hex config id', () => {
    const p = policy();
    expect(p.name).toBe('resource-intelligence');
    expect(p.version).toBe('1');
    expect(p.configId).toMatch(/^[0-9a-f]{12}$/);
  });

  it('is stable across key insertion order and sensitive to settings', () => {
    const base = settings();
    const reordered: ResourceIntelligenceSettings = {
      ...base,
      weights: Object.fromEntries(
        Object.entries(base.weights).reverse(),
      ) as unknown as ResourceIntelligenceSettings['weights'],
    };
    const make = (s: ResourceIntelligenceSettings) =>
      new ResourceIntelligencePolicy({ taskKinds: DEFAULT_TASK_KIND_RULES, settings: s });
    expect(make(reordered).configId).toBe(make(base).configId);
    const changed = { ...base, weights: { ...base.weights, quota: base.weights.quota + 0.01 } };
    expect(make(changed).configId).not.toBe(make(base).configId);
    expect(
      new ResourceIntelligencePolicy({
        taskKinds: DEFAULT_TASK_KIND_RULES,
        defaultResourceId: rid('a'),
        settings: base,
      }).configId,
    ).not.toBe(make(base).configId);
  });
});

describe('factors', () => {
  it('reports every factor with value × weight = contribution and sums to the score', () => {
    const [a] = policy({}, { defaultResourceId: 'a' }).evaluate(input([snap('a')]));
    const names = a!.factors!.map((f) => f.name);
    expect(names).toEqual([
      'default',
      'availability',
      'auth',
      'quota',
      'cost',
      'latency',
      'success',
    ]);
    for (const f of a!.factors!) {
      expect(f.value).toBeGreaterThanOrEqual(0);
      expect(f.value).toBeLessThanOrEqual(1);
      expect(f.contribution).toBeCloseTo(f.value * f.weight, 12);
    }
    const sum = a!.factors!.reduce((s, f) => s + f.contribution, 0);
    expect(a!.score).toBe(Math.round(sum * 1e6) / 1e6);
    expect(factor(a!, 'default')!.value).toBe(1);
    expect(factor(a!, 'availability')!.value).toBe(1);
    expect(factor(a!, 'auth')!.value).toBe(1);
    expect(factor(a!, 'cost')!.value).toBe(1);
  });

  it('scores degraded/unknown availability and unknown auth as 0.5', () => {
    const [a] = policy().evaluate(
      input([
        snap(
          'a',
          { auth: { mode: 'api-key', credential: { source: 'env', name: 'K' } } },
          { availability: 'degraded', auth: 'unknown' },
        ),
      ]),
    );
    expect(factor(a!, 'availability')!.value).toBe(0.5);
    expect(factor(a!, 'auth')!.value).toBe(0.5);
  });

  it('uses neutral cold-start history below minSamples and says why', () => {
    const h = history({ a: { coding: { samples: 4, successes: 4, p50LatencyMs: 1 } } });
    const [a] = policy().evaluate(input([snap('a')], {}, { history: h }));
    for (const name of ['latency', 'success']) {
      const f = factor(a!, name)!;
      expect(f.value).toBe(0.5);
      expect(f.neutral).toBe(true);
      expect(f.detail).toBe('cold-start 4<5');
    }
  });

  it('computes latency and Laplace success from history at minSamples', () => {
    const h = history({
      a: { coding: { successes: 8, resourceFaults: 2, p50LatencyMs: 60_000 } },
    });
    const [a] = policy().evaluate(input([snap('a')], {}, { history: h }));
    expect(factor(a!, 'latency')!.value).toBeCloseTo(0.5, 12);
    expect(factor(a!, 'latency')!.neutral).toBeUndefined();
    expect(factor(a!, 'success')!.value).toBeCloseTo(9 / 12, 12);
  });

  it('reads history for the task kind only', () => {
    const h = history({ a: { review: { successes: 10, p50LatencyMs: 1 } } });
    const [a] = policy().evaluate(input([snap('a')], {}, { history: h }));
    expect(factor(a!, 'success')!.neutral).toBe(true);
  });

  it('omits the lane factor without a lane role and includes it with one', () => {
    const [none] = policy().evaluate(input([snap('a')]));
    expect(factor(none!, 'lane')).toBeUndefined();
    const [withRole] = policy().evaluate(
      input([snap('a')], {}, { facts: { laneRole: 'feature' } }),
    );
    expect(factor(withRole!, 'lane')!.neutral).toBe(true);
  });

  it('computes the implementer lane factor as the mean of available signals', () => {
    const lane: LaneAggregate = {
      samples: 6,
      firstRoundGatePasses: 3,
      gateSamples: 4, // 0.75
      reworkRounds: 3,
      tasks: 6, // 1 - 0.5/3
      reviewApprovals: 1,
      reviewVerdicts: 2, // 0.5
      ownerApprovals: 0,
      ownerDecisions: 0, // unavailable
    };
    const h = history({}, { a: { feature: lane } });
    const [a] = policy().evaluate(
      input([snap('a')], {}, { history: h, facts: { laneRole: 'feature' } }),
    );
    const expected = (0.75 + (1 - 0.5 / 3) + 0.5) / 3;
    expect(factor(a!, 'lane')!.value).toBeCloseTo(expected, 12);
    expect(factor(a!, 'lane')!.neutral).toBeUndefined();
  });

  it('caps rework at 3 rounds per task', () => {
    const h = history({}, { a: { tests: { samples: 5, reworkRounds: 100, tasks: 5 } } });
    const [a] = policy().evaluate(
      input([snap('a')], {}, { history: h, facts: { laneRole: 'tests' } }),
    );
    expect(factor(a!, 'lane')!.value).toBe(0);
  });

  it('computes the reviewer lane factor as validVerdicts/producedVerdicts', () => {
    const h = history(
      {},
      {
        a: {
          review: {
            samples: 5,
            validVerdicts: 3,
            producedVerdicts: 4,
            firstRoundGatePasses: 0,
            gateSamples: 9,
          },
        },
      },
    );
    const [a] = policy().evaluate(
      input([snap('a')], {}, { history: h, facts: { laneRole: 'review' } }),
    );
    expect(factor(a!, 'lane')!.value).toBe(0.75);
  });

  it('keeps architecture neutral and lane cold start neutral', () => {
    const h = history({}, { a: { architecture: { samples: 50 }, feature: { samples: 2 } } });
    const arch = policy().evaluate(
      input([snap('a')], {}, { history: h, facts: { laneRole: 'architecture' } }),
    );
    expect(factor(arch[0]!, 'lane')!.neutral).toBe(true);
    const cold = policy().evaluate(
      input([snap('a')], {}, { history: h, facts: { laneRole: 'feature' } }),
    );
    expect(factor(cold[0]!, 'lane')!.detail).toBe('cold-start 2<5');
  });

  it('clamps and ignores poisoned history without throwing', () => {
    const poison = {
      samples: Number.NaN,
      successes: Infinity,
      resourceFaults: -5,
      timeouts: 1e308,
      p50LatencyMs: Number.NaN,
      costSamples: 0,
    } as ExecutionAggregate;
    const huge = {
      samples: 1e308,
      successes: 1e308,
      resourceFaults: 1e308,
      timeouts: 0,
      p50LatencyMs: -10,
      costSamples: 0,
    } as ExecutionAggregate;
    const lane = {
      samples: 1e9,
      firstRoundGatePasses: 50,
      gateSamples: 5, // ratio > 1
      reworkRounds: Number.NaN,
      tasks: -1,
      reviewApprovals: Infinity,
      reviewVerdicts: 2,
      ownerApprovals: -3,
      ownerDecisions: 4,
    } as LaneAggregate;
    const h: RoutingHistory = {
      ...history(),
      executions: { a: { coding: poison }, b: { coding: huge } },
      lanes: { a: { feature: lane } },
    };
    const out = policy().evaluate(
      input([snap('a'), snap('b')], {}, { history: h, facts: { laneRole: 'feature' } }),
    );
    for (const a of out) {
      expect(Number.isFinite(a.score)).toBe(true);
      for (const f of a.factors!) {
        expect(f.value).toBeGreaterThanOrEqual(0);
        expect(f.value).toBeLessThanOrEqual(1);
      }
    }
    expect(
      factor(
        out.find((a) => a.resourceId === 'a')!,
        'success',
      )!.neutral,
    ).toBe(true);
    // Poisoned counts that are not usable numbers are ignored; nothing leaks outside [0, 1].
    expect(
      factor(
        out.find((a) => a.resourceId === 'a')!,
        'lane',
      )!.value,
    ).toBe(1);
    // A negative latency is unusable: the factor stays neutral rather than scoring "instant".
    expect(
      factor(
        out.find((a) => a.resourceId === 'b')!,
        'latency',
      ),
    ).toMatchObject({
      neutral: true,
      detail: 'no-latency',
    });
  });

  it('ignores prototype-key history lookups', () => {
    // `__proto__` is not a valid resource id, but a task kind and history keys are free text.
    const h = history();
    const p = policy();
    for (const kind of ['toString', '__proto__', 'constructor']) {
      const out = p.evaluate(
        input([snap('constructor'), snap('hasownproperty')], {}, { history: h, kind }),
      );
      for (const a of out) {
        expect(factor(a, 'success')!.neutral).toBe(true);
        expect(factor(a, 'latency')!.neutral).toBe(true);
      }
    }
  });
});

describe('ranking', () => {
  it('ranks task preference over kind preference over default over the rest, then by id', () => {
    const rules = {
      ...DEFAULT_TASK_KIND_RULES,
      coding: { ...DEFAULT_TASK_KIND_RULES['coding']!, preferredResourceIds: [rid('k')] },
    };
    const p = new ResourceIntelligencePolicy({
      taskKinds: rules,
      defaultResourceId: rid('d'),
      settings: settings(),
    });
    const out = p.evaluate(
      input([snap('z'), snap('d'), snap('k'), snap('t'), snap('a')], {
        preferredResourceIds: [rid('t')],
      }),
    );
    expect(ids(out)).toEqual(['t', 'k', 'd', 'a', 'z']);
    expect(out.map((a) => a.tier)).toEqual([3, 2, 1, 1, 1]);
    expect(codes(out[0]!)).toContain('preference.task');
    expect(codes(out[1]!)).toContain('preference.task-kind');
    expect(codes(out[2]!)).toContain('preference.default');
  });

  it('keeps owner order inside a tier regardless of score', () => {
    const h = history({ second: { coding: { successes: 50, p50LatencyMs: 1 } } });
    const out = policy().evaluate(
      input(
        [snap('first'), snap('second')],
        { preferredResourceIds: [rid('first'), rid('second')] },
        { history: h },
      ),
    );
    expect(ids(out)).toEqual(['first', 'second']);
  });

  it('lets a tier beat any history', () => {
    const h = history({
      good: { coding: { successes: 1000, p50LatencyMs: 1 } },
      pref: { coding: { resourceFaults: 1000, p50LatencyMs: 600_000 } },
    });
    const out = policy().evaluate(
      input([snap('good'), snap('pref')], { preferredResourceIds: [rid('pref')] }, { history: h }),
    );
    expect(ids(out)).toEqual(['pref', 'good']);
  });

  it('breaks ties by resource id', () => {
    expect(ids(policy().evaluate(input([snap('b'), snap('c'), snap('a')])))).toEqual([
      'a',
      'b',
      'c',
    ]);
  });

  it('lets history change the selection once samples reach minSamples', () => {
    const candidates = [snap('a'), snap('b')];
    const det = new DeterministicRoutingPolicy({ taskKinds: DEFAULT_TASK_KIND_RULES });
    expect(ids(det.evaluate(input(candidates)))).toEqual(['a', 'b']);
    const cold = history({
      a: { coding: { successes: 1, resourceFaults: 3 } },
      b: { coding: { successes: 4 } },
    });
    expect(ids(policy().evaluate(input(candidates, {}, { history: cold })))).toEqual(['a', 'b']);
    const warm = history({
      a: { coding: { successes: 1, resourceFaults: 9, p50LatencyMs: 90_000 } },
      b: { coding: { successes: 10, p50LatencyMs: 1000 } },
    });
    expect(ids(policy().evaluate(input(candidates, {}, { history: warm })))).toEqual(['b', 'a']);
  });

  it('is deterministic: the same input twice is deep-equal', () => {
    const h = history({ a: { coding: { successes: 9, p50LatencyMs: 10 } } });
    const i = input([snap('a'), snap('b')], {}, { history: h });
    expect(policy().evaluate(i)).toEqual(policy().evaluate(i));
  });

  it('puts rejected candidates last, ordered by id, with score 0 and no factors', () => {
    const out = policy().evaluate(
      input([
        snap('z', {}, { availability: 'unavailable' }),
        snap('a'),
        snap('m', { capabilities: [] }),
      ]),
    );
    expect(ids(out)).toEqual(['a', 'm', 'z']);
    expect(out[1]).toMatchObject({ eligible: false, score: 0 });
    expect(out[1]!.factors).toBeUndefined();
  });
});

describe('weighted preferences', () => {
  it('flattens tiers and turns the preference into the default factor', () => {
    const rules = {
      ...DEFAULT_TASK_KIND_RULES,
      coding: { ...DEFAULT_TASK_KIND_RULES['coding']!, preferredResourceIds: [rid('k')] },
    };
    const p = new ResourceIntelligencePolicy({
      taskKinds: rules,
      defaultResourceId: rid('d'),
      settings: settings({ preferences: 'weighted' }),
    });
    const out = p.evaluate(
      input([snap('t'), snap('k'), snap('d'), snap('n')], { preferredResourceIds: [rid('t')] }),
    );
    expect(out.every((a) => a.tier === 1)).toBe(true);
    const values = Object.fromEntries(out.map((a) => [a.resourceId, factor(a, 'default')!.value]));
    expect(values).toEqual({ t: 1, k: 0.75, d: 0.5, n: 0 });
    expect(factor(out[0]!, 'default')!.detail).toBe('weighted-preference');
    expect(ids(out)).toEqual(['t', 'k', 'd', 'n']);
  });

  it('lets strong history outrank a weak preference', () => {
    const p = policy({ preferences: 'weighted' });
    const h = history({
      a: { coding: { resourceFaults: 20, p50LatencyMs: 600_000 } },
      b: { coding: { successes: 20, p50LatencyMs: 100 } },
    });
    const out = p.evaluate(
      input([snap('a'), snap('b')], { preferredResourceIds: [rid('a')] }, { history: h }),
    );
    expect(ids(out)).toEqual(['b', 'a']);
  });
});

describe('cold start equals deterministic@1 ordering', () => {
  const mk = (id: string, availability: ResourceState['availability'] = 'available') =>
    snap(id, {}, { availability });
  const rules = {
    ...DEFAULT_TASK_KIND_RULES,
    coding: { ...DEFAULT_TASK_KIND_RULES['coding']!, preferredResourceIds: [rid('k1'), rid('k2')] },
  };
  const table: { name: string; cands: ResourceSnapshot[]; req: Partial<TaskRequirements> }[] = [
    { name: 'ids only', cands: [mk('c'), mk('a'), mk('b')], req: {} },
    { name: 'default resource', cands: [mk('a'), mk('d'), mk('b')], req: {} },
    {
      name: 'availability mix',
      cands: [mk('a', 'degraded'), mk('b'), mk('c', 'unknown')],
      req: {},
    },
    {
      name: 'task preferences',
      cands: [mk('a'), mk('x'), mk('y')],
      req: { preferredResourceIds: [rid('y'), rid('x')] },
    },
    { name: 'kind preferences', cands: [mk('k2'), mk('a'), mk('k1')], req: {} },
    {
      name: 'all tiers',
      cands: [mk('d'), mk('k1'), mk('t'), mk('a')],
      req: { preferredResourceIds: [rid('t')] },
    },
    { name: 'default vs degraded', cands: [mk('a'), mk('d', 'degraded')], req: {} },
    { name: 'rejected mixed in', cands: [mk('a', 'unavailable'), mk('b'), mk('d')], req: {} },
  ];
  for (const row of table) {
    it(row.name, () => {
      const config = { taskKinds: rules, defaultResourceId: rid('d') };
      const det = new DeterministicRoutingPolicy(config);
      const ri = new ResourceIntelligencePolicy({ ...config, settings: settings() });
      const i = input(row.cands, row.req);
      expect(ids(ri.evaluate(i))).toEqual(ids(det.evaluate(i)));
      expect(ids(ri.evaluateFallback(i))).toEqual(ids(det.evaluate(i)));
    });
  }
});

describe('quota reservation (demonstration)', () => {
  const lowQuota: QuotaObservation = {
    unit: 'requests',
    limit: 100,
    used: 80,
    remaining: 20,
    window: 'daily',
    observedAt: NOW,
    resetsAt: '2026-03-02T00:00:00.000Z',
    provenance: { limit: 'owner-declared', usage: 'nexar-accounting' },
  };
  const reserved = settings({
    reservations: [
      {
        resourceId: rid('a'),
        reserveFraction: 0.3,
        reservedFor: { taskKinds: ['review'], laneRoles: ['architecture'] },
      },
    ],
  });
  const p = new ResourceIntelligencePolicy({
    taskKinds: DEFAULT_TASK_KIND_RULES,
    settings: reserved,
  });
  const cands = (): ResourceSnapshot[] => [snap('a', {}, { quotas: [lowQuota] }), snap('b')];

  it('prefers A normally, but picks B for a routine task once A is at its reserve', () => {
    const out = p.evaluate(input(cands(), { preferredResourceIds: [rid('a')] }));
    expect(ids(out)).toEqual(['b', 'a']);
    const a = out.find((x) => x.resourceId === 'a')!;
    expect(a.eligible).toBe(false);
    expect(codes(a)).toContain('quota.reserved');
    // Same preference with healthy quota selects A.
    const healthy = p.evaluate(
      input([snap('a', {}, { quotas: [{ ...lowQuota, used: 10, remaining: 90 }] }), snap('b')], {
        preferredResourceIds: [rid('a')],
      }),
    );
    expect(ids(healthy)[0]).toBe('a');
  });

  it('keeps A eligible and chosen for a reserved task kind or lane role', () => {
    const kind = p.evaluate(
      input(cands(), { preferredResourceIds: [rid('a')] }, { kind: 'review' }),
    );
    expect(ids(kind)[0]).toBe('a');
    expect(codes(kind[0]!)).toContain('quota.reserved-for-task');
    const lane = p.evaluate(
      input(cands(), { preferredResourceIds: [rid('a')] }, { facts: { laneRole: 'architecture' } }),
    );
    expect(ids(lane)[0]).toBe('a');
    expect(lane[0]!.quota?.reservation).toMatchObject({ protected: false, verifiable: true });
  });
});

describe('cost limit (demonstration)', () => {
  const size = {
    estimatedInputTokens: 1000,
    attachmentCount: 0,
    documentCount: 0,
    requestedMaxOutputTokens: 1000,
    basis: 'chars/4@1',
  };
  const cash = (inRate: number, outRate: number): Partial<ResourceDescriptor> => ({
    cost: {
      model: 'per-token',
      inputPerMillionTokens: inRate,
      outputPerMillionTokens: outRate,
    } as CostProfile,
  });
  const cands = [
    snap('cheap', cash(1, 1)), // $0.002
    snap('dear', cash(100, 100)), // $0.2
    snap('mystery', { cost: { model: 'unknown' } }),
  ];

  it('rejects over-limit, accepts under-limit, and rejects unknown under a strict budget', () => {
    const out = policy().evaluate(input(cands, { maxCostUsd: 0.01 }, { facts: { size } }));
    const by = Object.fromEntries(out.map((a) => [a.resourceId, a]));
    expect(by['cheap']!.eligible).toBe(true);
    expect(codes(by['cheap']!)).toContain('cost.within-limit');
    expect(by['dear']!.eligible).toBe(false);
    expect(codes(by['dear']!)).toContain('cost.exceeds-limit');
    expect(by['mystery']!.eligible).toBe(false);
    expect(codes(by['mystery']!)).toContain('cost.not-estimable');
    expect(by['cheap']!.cost?.class).toBe('cash');
  });

  it('allows unknown cost when configured', () => {
    const p = policy({
      cost: { ...DEFAULT_RESOURCE_INTELLIGENCE_SETTINGS.cost, unknownUnderLimit: 'allow' },
    });
    const out = p.evaluate(input(cands, { maxCostUsd: 0.01 }, { facts: { size } }));
    const mystery = out.find((a) => a.resourceId === 'mystery')!;
    expect(mystery.eligible).toBe(true);
    expect(codes(mystery)).toContain('cost.not-estimable-allowed');
    expect(factor(mystery, 'cost')!.neutral).toBe(true);
  });
});

describe('engineering lanes (demonstration)', () => {
  // `codex` implements well but reviews poorly; `claude` the other way round. One history, two
  // lane roles, two different rankings: implementer and reviewer quality never mix.
  const lanes = history(
    {},
    {
      codex: {
        feature: {
          samples: 10,
          firstRoundGatePasses: 9,
          gateSamples: 10,
          reworkRounds: 1,
          tasks: 10,
          reviewApprovals: 9,
          reviewVerdicts: 10,
        },
        review: { samples: 10, validVerdicts: 4, producedVerdicts: 10 },
      },
      claude: {
        feature: {
          samples: 10,
          firstRoundGatePasses: 4,
          gateSamples: 10,
          reworkRounds: 12,
          tasks: 10,
          reviewApprovals: 3,
          reviewVerdicts: 10,
        },
        review: { samples: 10, validVerdicts: 10, producedVerdicts: 10 },
      },
    },
  );
  const candidates = [snap('claude'), snap('codex')];

  it('ranks feature and review lanes separately from the same history', () => {
    const p = policy();
    const feature = p.evaluate(
      input(candidates, {}, { history: lanes, facts: { laneRole: 'feature' } }),
    );
    const review = p.evaluate(
      input(candidates, {}, { kind: 'coding', history: lanes, facts: { laneRole: 'review' } }),
    );
    expect(ids(feature)).toEqual(['codex', 'claude']);
    expect(ids(review)).toEqual(['claude', 'codex']);
    expect(factor(review[0]!, 'lane')!.value).toBe(1);
  });

  it('without a lane role the lane signals do not apply (ties broken by id)', () => {
    const out = policy().evaluate(input(candidates, {}, { history: lanes }));
    expect(ids(out)).toEqual(['claude', 'codex']);
    expect(out.every((a) => factor(a, 'lane') === undefined)).toBe(true);
  });

  it('an owner lane preference (passed as a task preference) still wins', () => {
    const out = policy().evaluate(
      input(
        candidates,
        { preferredResourceIds: [rid('claude')] },
        {
          history: lanes,
          facts: { laneRole: 'feature' },
        },
      ),
    );
    expect(ids(out)).toEqual(['claude', 'codex']);
  });
});

describe('fallback ranking', () => {
  it('uses no factors and never admits a hard-filtered candidate', () => {
    const out = policy({}, { defaultResourceId: 'a' }).evaluateFallback(
      input([
        snap('a', {}, { availability: 'unavailable' }),
        snap('b'),
        snap('c', { capabilities: [] }),
      ]),
    );
    expect(ids(out)).toEqual(['b', 'a', 'c']);
    expect(out.every((a) => a.factors === undefined)).toBe(true);
    expect(out.filter((a) => a.eligible).map((a) => a.resourceId)).toEqual(['b']);
  });
});

// ------------------------------------------------------------------------------------------------
// Invariants
// ------------------------------------------------------------------------------------------------

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

describe('invariants', () => {
  const size = {
    estimatedInputTokens: 1000,
    attachmentCount: 0,
    documentCount: 0,
    requestedMaxOutputTokens: 1000,
    basis: 'chars/4@1',
  };

  it('eligible ids from the policy equal those from applyHardFilters (random cases)', () => {
    const rand = rng(20261001);
    const pick = <T>(xs: readonly T[]): T => xs[Math.floor(rand() * xs.length)]!;
    const config = {
      taskKinds: DEFAULT_TASK_KIND_RULES,
      defaultResourceId: rid('r0'),
      settings: settings({
        reservations: [
          { resourceId: rid('r1'), reserveFraction: 0.3, reservedFor: { taskKinds: ['review'] } },
        ],
      }),
    };
    const p = new ResourceIntelligencePolicy(config);
    for (let n = 0; n < 250; n++) {
      const cands: ResourceSnapshot[] = [];
      const count = 1 + Math.floor(rand() * 5);
      const executions: Record<string, Record<string, Partial<ExecutionAggregate>>> = {};
      for (let i = 0; i < count; i++) {
        const id = `r${i}`;
        const quotas: QuotaObservation[] =
          rand() < 0.5
            ? []
            : [
                {
                  unit: 'requests',
                  limit: 100,
                  used: Math.floor(rand() * 101),
                  window: 'daily',
                  observedAt: pick([NOW, '2026-03-01T00:00:00.000Z']),
                  provenance: {
                    limit: pick(['vendor-reported', 'owner-declared'] as const),
                    usage: 'vendor-reported',
                  },
                },
              ];
        cands.push(
          snap(
            id,
            {
              capabilities: rand() < 0.8 ? ['coding', 'repo-editing'] : [],
              dataLocality: pick(['local', 'third-party'] as const),
              cost: pick<CostProfile>([
                { model: 'free' },
                { model: 'unknown' },
                { model: 'subscription' },
                {
                  model: 'per-token',
                  inputPerMillionTokens: 50,
                  outputPerMillionTokens: 50,
                } as CostProfile,
              ]),
              limits: { contextWindowTokens: pick([1000, 100_000]) },
            },
            {
              availability: pick(['available', 'degraded', 'unknown', 'unavailable'] as const),
              quotas,
            },
          ),
        );
        executions[id] = {
          coding: {
            successes: Math.floor(rand() * 30),
            resourceFaults: Math.floor(rand() * 30),
            p50LatencyMs: rand() * 1e5,
          },
        };
      }
      const req: Partial<TaskRequirements> = {
        ...(rand() < 0.4 ? { privacy: 'local-only' as const } : {}),
        ...(rand() < 0.4 ? { minContextTokens: 5000 } : {}),
        ...(rand() < 0.4 ? { maxCostUsd: 0.05 } : {}),
        ...(rand() < 0.4 ? { requireKnownQuota: true } : {}),
        ...(rand() < 0.3 ? { excludedResourceIds: [rid('r0')] } : {}),
        ...(rand() < 0.3 ? { preferredResourceIds: [rid(`r${Math.floor(rand() * count)}`)] } : {}),
      };
      const i = input(cands, req, {
        kind: pick(['coding', 'review']),
        facts: {
          size,
          ...(rand() < 0.5 ? { laneRole: pick(['feature', 'review'] as const) } : {}),
        },
        history: history(executions),
      });
      const filtered = applyHardFilters(i, config);
      const expected = filtered
        .filter((f) => f.eligible)
        .map((f) => f.resourceId as string)
        .sort();
      const out = p.evaluate(i);
      expect(eligibleIds(out)).toEqual(expected);
      expect(eligibleIds(p.evaluateFallback(i))).toEqual(expected);
      expect(out).toHaveLength(cands.length);
      // Eligible entries come first.
      const firstRejected = out.findIndex((a) => !a.eligible);
      if (firstRejected >= 0) expect(out.slice(firstRejected).every((a) => !a.eligible)).toBe(true);
    }
  });

  const perfect = { successes: 500, resourceFaults: 0, p50LatencyMs: 1 };
  const perfectLane: LaneAggregate = {
    samples: 500,
    firstRoundGatePasses: 500,
    gateSamples: 500,
    reworkRounds: 0,
    tasks: 500,
    reviewApprovals: 500,
    reviewVerdicts: 500,
    ownerApprovals: 500,
    ownerDecisions: 500,
  };
  const exhausted: QuotaObservation = {
    unit: 'requests',
    limit: 10,
    used: 10,
    remaining: 0,
    window: 'daily',
    observedAt: NOW,
    resetsAt: '2026-03-02T00:00:00.000Z',
    provenance: { limit: 'owner-declared', usage: 'nexar-accounting' },
  };
  const cases: {
    name: string;
    code: string;
    candidate: ResourceSnapshot;
    req?: Partial<TaskRequirements>;
    set?: Partial<ResourceIntelligenceSettings>;
  }[] = [
    {
      name: 'excluded',
      code: 'resource.excluded',
      candidate: snap('x'),
      req: { excludedResourceIds: [rid('x')] },
    },
    { name: 'capability', code: 'capability.missing', candidate: snap('x', { capabilities: [] }) },
    {
      name: 'unavailable',
      code: 'state.unavailable',
      candidate: snap('x', {}, { availability: 'unavailable' }),
    },
    {
      name: 'unauthenticated',
      code: 'auth.unauthenticated',
      candidate: snap(
        'x',
        { auth: { mode: 'api-key', credential: { source: 'env', name: 'K' } } },
        { auth: 'unauthenticated' },
      ),
    },
    {
      name: 'privacy',
      code: 'privacy.third-party',
      candidate: snap('x'),
      req: { privacy: 'local-only' },
    },
    {
      name: 'context',
      code: 'context.insufficient',
      candidate: snap('x', { limits: { contextWindowTokens: 10 } }),
      req: { minContextTokens: 100 },
    },
    {
      name: 'quota exhausted',
      code: 'quota.exhausted',
      candidate: snap('x', {}, { quotas: [exhausted] }),
    },
    {
      name: 'reserved',
      code: 'quota.reserved',
      candidate: snap('x', {}, { quotas: [{ ...exhausted, used: 9, remaining: 1 }] }),
      set: {
        reservations: [
          { resourceId: rid('x'), reserveFraction: 0.3, reservedFor: { taskKinds: ['review'] } },
        ],
      },
    },
    {
      name: 'unknown-strict',
      code: 'quota.unknown-strict',
      candidate: snap('x'),
      req: { requireKnownQuota: true },
    },
    {
      name: 'cost exceeds',
      code: 'cost.exceeds-limit',
      candidate: snap('x', {
        cost: {
          model: 'per-token',
          inputPerMillionTokens: 1000,
          outputPerMillionTokens: 1000,
        } as CostProfile,
      }),
      req: { maxCostUsd: 0.01 },
    },
    {
      name: 'cost not estimable',
      code: 'cost.not-estimable',
      candidate: snap('x', { cost: { model: 'unknown' } }),
      req: { maxCostUsd: 0.01 },
    },
  ];
  for (const c of cases) {
    it(`a perfect history never re-admits a candidate rejected by: ${c.name}`, () => {
      const p = policy(c.set ?? {}, { defaultResourceId: 'x' });
      // `y` passes every hard filter, so it must rank first whatever x's history says.
      const healthy: QuotaObservation = { ...exhausted, used: 1, remaining: 9 };
      const y = snap('y', { dataLocality: 'local' }, { quotas: [healthy] });
      const i = input(
        [c.candidate, y],
        { preferredResourceIds: [rid('x')], ...c.req },
        {
          facts: { size, laneRole: 'feature' },
          history: history({ x: { coding: perfect } }, { x: { feature: perfectLane } }),
        },
      );
      for (const out of [p.evaluate(i), p.evaluateFallback(i)]) {
        const x = out.find((a) => a.resourceId === 'x')!;
        expect(x.eligible).toBe(false);
        expect(codes(x)).toContain(c.code);
        expect(ids(out)[0]).toBe('y');
      }
    });
  }

  it('treats quota as unknown, never reading a clock, when facts are absent', () => {
    const base = input([snap('a', {}, { quotas: [exhausted] })]);
    const noFacts: RoutingInput = { task: base.task, candidates: base.candidates };
    const [a] = policy().evaluate(noFacts);
    expect(a!.eligible).toBe(true);
    expect(a!.quota?.freshness).toBe('unknown');
    const [strict] = policy().evaluate({
      ...noFacts,
      task: { ...noFacts.task, requirements: { capabilities: [], requireKnownQuota: true } },
    });
    expect(strict!.eligible).toBe(false);
  });
});
