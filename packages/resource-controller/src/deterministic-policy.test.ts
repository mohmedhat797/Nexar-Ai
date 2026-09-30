import {
  adapterId,
  resourceId,
  taskId,
  type CandidateAssessment,
  type ResourceDescriptor,
  type ResourceSnapshot,
  type ResourceState,
  type RoutingInput,
  type TaskRequirements,
} from '@nexar/contracts';
import { describe, expect, it } from 'vitest';
import { DEFAULT_TASK_KIND_RULES, DeterministicRoutingPolicy } from './index.js';

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
  kind = 'coding',
): RoutingInput {
  return {
    task: { id: taskId('t1'), kind, requirements: { capabilities: [], ...requirements } },
    candidates,
  };
}

const policy = new DeterministicRoutingPolicy({ taskKinds: DEFAULT_TASK_KIND_RULES });

function one(i: RoutingInput, p = policy): CandidateAssessment {
  const [a] = p.evaluate(i);
  return a!;
}
const codes = (a: CandidateAssessment) => a.reasons.map((r) => r.code);

describe('identity', () => {
  it('has name and version', () => {
    expect(policy.name).toBe('deterministic');
    expect(policy.version).toBe('1');
  });
});

describe('rejection reasons', () => {
  const apiKey = { mode: 'api-key', credential: { source: 'env', name: 'K' } } as const;
  const table: {
    name: string;
    code: string;
    i: RoutingInput;
    messageIncludes?: string;
  }[] = [
    {
      name: 'excluded',
      code: 'resource.excluded',
      i: input([snap('a')], { excludedResourceIds: [rid('a')] }),
    },
    {
      name: 'missing capabilities (kind + task)',
      code: 'capability.missing',
      i: input([snap('a', { capabilities: ['coding'] })], { capabilities: ['vision'] }),
      messageIncludes: 'repo-editing, vision',
    },
    {
      name: 'unavailable',
      code: 'state.unavailable',
      i: input([snap('a', {}, { availability: 'unavailable' })]),
    },
    {
      name: 'unauthenticated with auth required',
      code: 'auth.unauthenticated',
      i: input([snap('a', { auth: apiKey }, { auth: 'unauthenticated' })]),
    },
    {
      name: 'third-party for local-only',
      code: 'privacy.third-party',
      i: input([snap('a')], { privacy: 'local-only' }),
    },
    {
      name: 'insufficient context',
      code: 'context.insufficient',
      i: input([snap('a', { limits: { contextWindowTokens: 1000 } })], { minContextTokens: 2000 }),
    },
  ];

  it.each(table)('$name → $code', ({ code, i, messageIncludes }) => {
    const a = one(i);
    expect(a.eligible).toBe(false);
    expect(a.score).toBe(0);
    const r = a.reasons.find((x) => x.code === code);
    expect(r?.effect).toBe('rejects');
    if (messageIncludes !== undefined) expect(r?.message).toContain(messageIncludes);
  });

  it('does not reject unauthenticated state when auth mode is none', () => {
    const a = one(input([snap('a', {}, { auth: 'unauthenticated' })]));
    expect(a.eligible).toBe(true);
    expect(codes(a)).toContain('auth.ok');
  });

  it('keeps all rejection reasons, not just the first', () => {
    const a = one(
      input([snap('a', { capabilities: [] }, { availability: 'unavailable' })], {
        excludedResourceIds: [rid('a')],
      }),
    );
    expect(codes(a)).toEqual(
      expect.arrayContaining(['resource.excluded', 'capability.missing', 'state.unavailable']),
    );
  });
});

describe('supporting and neutral reasons', () => {
  it('reports matches and availability', () => {
    const a = one(input([snap('a')]));
    expect(a.eligible).toBe(true);
    const match = a.reasons.find((r) => r.code === 'capability.match');
    expect(match?.message).toBe('has coding, repo-editing');
    expect(codes(a)).toEqual(expect.arrayContaining(['state.available', 'auth.ok']));
  });

  it.each([
    ['degraded', 'state.degraded'],
    ['unknown', 'state.unknown'],
  ] as const)('%s is neutral and eligible', (availability, code) => {
    const a = one(input([snap('a', {}, { availability })]));
    expect(a.eligible).toBe(true);
    expect(a.reasons.find((r) => r.code === code)?.effect).toBe('neutral');
  });

  it('unknown auth state is neutral when auth is required', () => {
    const d = {
      auth: { mode: 'oauth', credential: { source: 'runtime-managed', description: 'x' } },
    } as const;
    const a = one(input([snap('a', d, { auth: 'unknown' })]));
    expect(a.eligible).toBe(true);
    expect(a.reasons.find((r) => r.code === 'auth.unknown')?.effect).toBe('neutral');
  });

  it('unknown context window is neutral', () => {
    const a = one(input([snap('a')], { minContextTokens: 5000 }));
    expect(a.eligible).toBe(true);
    expect(a.reasons.find((r) => r.code === 'context.unknown')?.effect).toBe('neutral');
  });

  it('sufficient context is eligible', () => {
    const a = one(
      input([snap('a', { limits: { contextWindowTokens: 5000 } })], { minContextTokens: 5000 }),
    );
    expect(a.eligible).toBe(true);
  });

  it('local-only passes for local resources', () => {
    const a = one(input([snap('a', { dataLocality: 'local' })], { privacy: 'local-only' }));
    expect(a.eligible).toBe(true);
  });

  it('cost is never evaluated, only noted', () => {
    const a = one(input([snap('a', { cost: { model: 'unknown' } })], { maxCostUsd: 0.0001 }));
    expect(a.eligible).toBe(true);
    expect(a.reasons.find((r) => r.code === 'cost.not-evaluated')?.effect).toBe('neutral');
  });

  it('unknown task kind adds only task capabilities and a neutral reason', () => {
    const i = input(
      [snap('a', { capabilities: ['vision'] })],
      { capabilities: ['vision'] },
      'mystery',
    );
    const a = one(i);
    expect(a.eligible).toBe(true);
    expect(a.reasons.find((r) => r.code === 'task-kind.unknown')?.effect).toBe('neutral');
    expect(a.reasons.find((r) => r.code === 'capability.match')?.message).toBe('has vision');
  });

  it('kind names that shadow Object.prototype are treated as unknown', () => {
    const a = one(input([snap('a')], {}, 'constructor'));
    expect(codes(a)).toContain('task-kind.unknown');
  });
});

describe('scoring tiers', () => {
  const p = new DeterministicRoutingPolicy({
    taskKinds: {
      coding: {
        requiredCapabilities: ['coding'],
        preferredResourceIds: [rid('k0'), rid('k1')],
      },
    },
    defaultResourceId: rid('dflt'),
  });
  const score = (id: string, req: Partial<TaskRequirements> = {}, s: Partial<ResourceState> = {}) =>
    p.evaluate(input([snap(id, {}, s)], req)).find((a) => a.resourceId === id)!;

  it('task preference: 1000 - 10*index (+20 available)', () => {
    const req = { preferredResourceIds: [rid('t0'), rid('t1')] };
    expect(score('t0', req).score).toBe(1020);
    expect(score('t1', req).score).toBe(1010);
    expect(codes(score('t0', req))).toContain('preference.task');
  });

  it('kind preference: 500 - 10*index', () => {
    expect(score('k0').score).toBe(520);
    expect(score('k1').score).toBe(510);
    expect(codes(score('k1'))).toContain('preference.task-kind');
  });

  it('task preference outranks kind preference', () => {
    expect(score('k1', { preferredResourceIds: [rid('k1')] }).score).toBe(1020);
  });

  it('default resource: 100', () => {
    expect(score('dflt').score).toBe(120);
    expect(codes(score('dflt'))).toContain('preference.default');
  });

  it('no preference: 0 base', () => {
    expect(score('other').score).toBe(20);
  });

  it('degraded and unknown get +10', () => {
    expect(score('other', {}, { availability: 'degraded' }).score).toBe(10);
    expect(score('other', {}, { availability: 'unknown' }).score).toBe(10);
  });
});

describe('ordering', () => {
  it('sorts eligible by score desc, tie-break by id asc, then ineligible by id', () => {
    const p = new DeterministicRoutingPolicy({ taskKinds: DEFAULT_TASK_KIND_RULES });
    const out = p.evaluate(
      input(
        [
          snap('zz-bad', {}, { availability: 'unavailable' }),
          snap('c'),
          snap('a-bad', {}, { availability: 'unavailable' }),
          snap('b'),
          snap('a', {}, { availability: 'degraded' }),
          snap('pref'),
        ],
        { preferredResourceIds: [rid('pref')] },
      ),
    );
    expect(out.map((a) => a.resourceId)).toEqual(['pref', 'b', 'c', 'a', 'a-bad', 'zz-bad']);
  });

  it('is independent of candidate input order', () => {
    const cands = ['d', 'b', 'a', 'c'].map((id) => snap(id));
    const forward = policy.evaluate(input(cands)).map((a) => a.resourceId);
    const reversed = policy.evaluate(input([...cands].reverse())).map((a) => a.resourceId);
    expect(forward).toEqual(['a', 'b', 'c', 'd']);
    expect(reversed).toEqual(forward);
  });

  it('returns one assessment per candidate, including for empty input', () => {
    expect(policy.evaluate(input([]))).toEqual([]);
    expect(
      policy.evaluate(input([snap('a'), snap('b', {}, { availability: 'unavailable' })])),
    ).toHaveLength(2);
  });
});

describe('purity', () => {
  it('returns deep-equal output twice and does not mutate input', () => {
    const i = input(
      [snap('a'), snap('b', { capabilities: [] }), snap('c', {}, { availability: 'unavailable' })],
      { capabilities: ['vision'], preferredResourceIds: [rid('a')], maxCostUsd: 1 },
    );
    const before = structuredClone(i);
    const first = policy.evaluate(i);
    const second = policy.evaluate(i);
    expect(second).toEqual(first);
    expect(i).toEqual(before);
  });
});
