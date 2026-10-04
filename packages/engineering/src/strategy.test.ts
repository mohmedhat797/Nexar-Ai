import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  NexarError,
  resourceId,
  type ResourceId,
  type ResourceStrategy,
  type WorkGraph,
} from '@nexar/contracts';
import { GOAL_MARKER, createHarness, silentLogger, type Harness } from './fixtures.testkit.js';
import { readEngineeringRecord, type EngineeringStrategist } from './index.js';

const TASK = 'eng-0123456789ab';

let h: Harness | undefined;
afterEach(() => {
  h?.dispose();
  h = undefined;
});

async function harness(): Promise<Harness> {
  h = await createHarness({ newId: () => TASK });
  return h;
}

const record = async (x: Harness) => {
  const r = await readEngineeringRecord(x.stateDir, TASK);
  if (r === undefined) throw new Error('no record');
  return r;
};

/** A strategist that returns a fixed pick per unit and remembers the graph it was given. */
function fakeStrategist(picks: Readonly<Record<string, string>>, fallbackReason?: string) {
  const graphs: WorkGraph[] = [];
  const strategist: EngineeringStrategist = {
    planStrategy(graph) {
      graphs.push(graph);
      const strategy: ResourceStrategy = {
        graphId: graph.graphId,
        policy: {
          name: 'strategy',
          version: '1',
          configId: 'abc123def456',
          base: {
            name: 'deterministic',
            version: '1',
            ...(fallbackReason === undefined
              ? {}
              : { fallback: { from: 'resource-intelligence@1', reason: fallbackReason } }),
          },
        },
        units: graph.units.map((unit) => {
          const pick = picks[unit.unitId];
          return {
            unitId: unit.unitId,
            decision:
              pick === undefined
                ? {
                    outcome: 'no-eligible-resource' as const,
                    taskId: unit.task.id,
                    rejected: [],
                    policy: { name: 'strategy', version: '1' },
                    decidedAt: '2026-10-04T00:00:00.000Z',
                  }
                : {
                    outcome: 'selected' as const,
                    taskId: unit.task.id,
                    selected: {
                      resourceId: resourceId(pick),
                      eligible: true,
                      score: 1,
                      reasons: [],
                    },
                    alternatives: [],
                    rejected: [],
                    policy: { name: 'strategy', version: '1' },
                    decidedAt: '2026-10-04T00:00:00.000Z',
                  },
          };
        }),
        decidedAt: '2026-10-04T00:00:00.000Z',
      };
      return Promise.resolve(strategy);
    },
  };
  return { strategist, graphs };
}

/** Preferred ids each lane was created with, in call order. */
function spyPreferences(x: Harness): (readonly ResourceId[] | undefined)[] {
  const seen: (readonly ResourceId[] | undefined)[] = [];
  const original = x.runtime.nexar.createTask.bind(x.runtime.nexar);
  vi.spyOn(x.runtime.nexar, 'createTask').mockImplementation((input) => {
    seen.push(input.requirements?.preferredResourceIds);
    return original(input);
  });
  return seen;
}

describe('EngineeringExecution: strategy planning', () => {
  it('plans one unit per lane, chained, with the review lane reviewing the feature lane', async () => {
    const x = await harness();
    const { strategist, graphs } = fakeStrategist({ feature: 'impl', review: 'reviewer' });
    await x.makeRunner({ strategist }).run({ projectId: 'demo', goal: `Go. ${GOAL_MARKER}` });

    expect(graphs).toHaveLength(1);
    const [graph] = graphs;
    expect(graph?.graphId).toBe(TASK);
    expect(graph?.reviewDiversity).toBe('preferred');
    expect(graph?.units.map((u) => u.unitId)).toEqual(['feature', 'review']);
    expect(graph?.units[0]).toMatchObject({
      task: { id: `${TASK}:feature`, kind: 'coding' },
      laneRole: 'feature',
    });
    expect(graph?.units[0]?.task.requirements.capabilities).toEqual(['coding', 'repo-editing']);
    expect(graph?.units[0]).not.toHaveProperty('dependsOn');
    expect(graph?.units[1]).toMatchObject({
      laneRole: 'review',
      dependsOn: ['feature'],
      reviewOf: 'feature',
    });
    // No prompt or goal text reaches the planner.
    expect(JSON.stringify(graph)).not.toContain(GOAL_MARKER);
  });

  it('puts the planned resource first in the lane preferences and records the plan', async () => {
    const x = await harness();
    const seen = spyPreferences(x);
    const { strategist } = fakeStrategist({ feature: 'impl', review: 'reviewer' });
    await x.makeRunner({ strategist }).run({ projectId: 'demo', goal: `Go. ${GOAL_MARKER}` });

    expect(seen[0]?.[0]).toBe('impl');
    const rec = await record(x);
    expect(rec.strategy).toEqual({ policy: 'strategy@1', configId: 'abc123def456', units: 2 });
    expect(rec.lanes[0]).toMatchObject({ laneId: 'feature', resourceId: 'impl', planned: 'impl' });
    expect(rec.lanes[0]?.fallback).toBe(false);
  });

  it('keeps owner lane preferences after the planned resource', async () => {
    h = await createHarness({
      newId: () => TASK,
      engineering: { lanePreferences: { feature: ['impl'] } },
    });
    const seen = spyPreferences(h);
    const { strategist } = fakeStrategist({ feature: 'architect' });
    await h.makeRunner({ strategist }).run({ projectId: 'demo', goal: 'Go.' });

    expect(seen[0]).toEqual(['architect', 'impl']);
  });

  it('runs the lane elsewhere and records the fallback when the planned resource cannot serve it', async () => {
    const x = await harness();
    // `architect` lacks the lane's capabilities, so routing at run time rejects it.
    const { strategist } = fakeStrategist({ feature: 'architect' });
    await x.makeRunner({ strategist }).run({ projectId: 'demo', goal: 'Go.' });

    const rec = await record(x);
    expect(rec.lanes[0]).toMatchObject({
      laneId: 'feature',
      resourceId: 'impl',
      planned: 'architect',
      fallback: true,
    });
  });

  it('records the plan fallback reason code', async () => {
    const x = await harness();
    const { strategist } = fakeStrategist({ feature: 'impl' }, 'INTERNAL_ERROR');
    await x.makeRunner({ strategist }).run({ projectId: 'demo', goal: 'Go.' });

    expect((await record(x)).strategy).toMatchObject({ fallback: 'INTERNAL_ERROR' });
  });

  it('runs exactly as before when the strategist throws', async () => {
    const x = await harness();
    const seen = spyPreferences(x);
    const strategist: EngineeringStrategist = {
      planStrategy: () => Promise.reject(new NexarError('INTERNAL_ERROR', `secret ${GOAL_MARKER}`)),
    };
    silentLogger.warnings.length = 0;
    await x.makeRunner({ strategist }).run({ projectId: 'demo', goal: 'Go.' });

    expect(seen[0]).toBeUndefined();
    const rec = await record(x);
    expect(rec).not.toHaveProperty('strategy');
    expect(rec.lanes[0]).not.toHaveProperty('planned');
    expect(rec.lanes[0]).not.toHaveProperty('fallback');
    expect(rec.lanes[0]?.resourceId).toBe('impl');
    expect(silentLogger.warnings).toContain('resource strategy could not be planned');
  });

  it('is unchanged without a strategist', async () => {
    const x = await harness();
    const seen = spyPreferences(x);
    await x.run({ goal: 'Go.' });

    expect(seen[0]).toBeUndefined();
    const rec = await record(x);
    expect(rec).not.toHaveProperty('strategy');
    expect(rec.lanes[0]).not.toHaveProperty('planned');
  });

  it('plans report plans too, without a lane role for the report lane', async () => {
    const x = await harness();
    const { strategist, graphs } = fakeStrategist({ report: 'reviewer' });
    await x.makeRunner({ strategist }).run({
      projectId: 'demo',
      planId: 'repository-report',
      goal: 'Plan.',
    });

    expect(graphs[0]?.units).toHaveLength(1);
    expect(graphs[0]?.units[0]).not.toHaveProperty('laneRole');
    expect(graphs[0]?.units[0]).not.toHaveProperty('reviewOf');
    const rec = await record(x);
    expect(rec.lanes[0]).toMatchObject({
      outcome: 'succeeded',
      planned: 'reviewer',
      fallback: false,
    });
  });
});
