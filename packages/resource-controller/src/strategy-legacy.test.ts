import {
  adapterId,
  resourceId,
  taskId,
  type ResourceSnapshot,
  type StrategyLedger,
  type WorkGraph,
  type WorkUnit,
} from '@nexar/contracts';
import { readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import {
  DeterministicRoutingPolicy,
  ResourceIntelligencePolicy,
  DEFAULT_RESOURCE_INTELLIGENCE_SETTINGS,
  DEFAULT_TASK_KIND_RULES,
  planStrategy,
  allocateNext,
  revalidate,
} from './index.js';

const now = new Date('2026-03-01T12:00:00.000Z');
const snapshots: ResourceSnapshot[] = ['a', 'b', 'down'].map((id) => ({
  descriptor: {
    id: resourceId(id),
    displayName: id,
    kind: { type: 'model', provider: 'openai', model: id, access: 'api' },
    capabilities: [
      'text-generation',
      'knowledge-work',
      'reasoning',
      'coding',
      'repo-editing',
      'code-review',
      'model-turn',
    ],
    runtime: { adapter: adapterId('test'), locality: 'remote' },
    auth: { mode: 'none' },
    cost: { model: 'free' },
    dataLocality: 'third-party',
  },
  state: {
    availability: id === 'down' ? 'unavailable' : 'available',
    auth: 'not-required',
    observedAt: now.toISOString(),
  },
}));
const units: WorkUnit[] = [
  {
    unitId: 'write',
    task: { id: taskId('write'), kind: 'general', requirements: { capabilities: [] } },
  },
  {
    unitId: 'review',
    reviewOf: 'write',
    task: { id: taskId('review'), kind: 'general', requirements: { capabilities: [] } },
  },
];

function legacyCorpus() {
  return [
    new DeterministicRoutingPolicy({ taskKinds: DEFAULT_TASK_KIND_RULES }),
    new ResourceIntelligencePolicy({
      taskKinds: DEFAULT_TASK_KIND_RULES,
      settings: DEFAULT_RESOURCE_INTELLIGENCE_SETTINGS,
    }),
  ].flatMap((policy) =>
    [undefined, 'preferred', 'required'].flatMap((reviewDiversity) =>
      [false, true].map((pinned) => {
        const graph: WorkGraph = {
          graphId: 'legacy',
          units: units.map((u) =>
            pinned
              ? {
                  ...u,
                  task: {
                    ...u.task,
                    requirements: {
                      ...u.task.requirements,
                      preferredResourceIds: [resourceId('a')],
                    },
                  },
                }
              : u,
          ),
          ...(reviewDiversity === undefined
            ? {}
            : { reviewDiversity: reviewDiversity as 'preferred' | 'required' }),
        };
        const plan = planStrategy({ graph, candidates: snapshots, policy, now });
        let ledger: StrategyLedger = {
          graphId: 'legacy',
          allocations: [],
          spentUsd: 0,
          reviewDiversity: graph.reviewDiversity ?? 'preferred',
        };
        const dynamic = graph.units.map((unit) => {
          const next = allocateNext({ unit, ledger, candidates: snapshots, policy, now });
          ledger = next.ledger;
          return next;
        });
        const validations = plan.units.map((planned, i) =>
          revalidate({
            planned,
            unit: graph.units[i]!,
            candidates: snapshots.map((s) =>
              s.descriptor.id === 'a'
                ? { ...s, state: { ...s.state, availability: 'unavailable' as const } }
                : s,
            ),
            policy,
            now,
          }),
        );
        return {
          policy: policy.name,
          reviewDiversity: graph.reviewDiversity ?? 'default',
          pinned,
          graph,
          plan,
          dynamic,
          validations,
        };
      }),
    ),
  );
}

describe('pre-C strategy@1 compatibility corpus', () => {
  it('retains the captured plans, ledgers, stamps, assessments and revalidation outcomes', () => {
    const actual = legacyCorpus();
    // Captured before any production edit on B′ HEAD 18c7cd0. Every serialized field participates,
    // including ranked/rejected assessments, scores, reasons, ledgers, stamps and fallback results.
    // The original complete capture is retained in .nexar/ci/legacy-capture.log; never regenerate
    // these expected hashes from a changed strategy implementation.
    const expected = JSON.parse(
      readFileSync(new URL('./fixtures/strategy-v1-pre-c.json', import.meta.url), 'utf8'),
    ) as { wholeCorpusSha256: string; cases: { sha256: string }[] };
    const hash = (value: unknown) =>
      createHash('sha256').update(JSON.stringify(value)).digest('hex');
    expect(actual).toHaveLength(expected.cases.length);
    expect(actual.map(hash)).toEqual(expected.cases.map((c) => c.sha256));
    expect(hash(actual)).toBe(expected.wholeCorpusSha256);
  });
});
