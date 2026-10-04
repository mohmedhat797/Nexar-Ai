import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { NexarError, resourceId, type ExecutionGateway } from '@nexar/contracts';
import { createHarness, silentLogger, type Harness } from './fixtures.testkit.js';
import {
  readEngineeringRecord,
  type EngineeringProgress,
  type EngineeringRecord,
  type LaneEngine,
  type LaneEngineLane,
  type LaneEngineSession,
  type LaneEngineUnavailable,
} from './index.js';

const TASK = 'eng-0123456789ab';
const SENTINEL = 'sentinel-token-0000';
const never = { ownerApproval: 'never' };

const gateway: ExecutionGateway = {
  engine: 'dsh',
  services: { dir: '/svc', gateway: true, bridge: true },
  token: SENTINEL,
  model: 'nexar-control',
  controlResourceId: 'control-model',
  controlDecisionId: 'dec-1',
};

class FakeLaneEngine implements LaneEngine {
  readonly opened: LaneEngineLane[] = [];
  closed = 0;
  controlFailed = false;
  constructor(
    private readonly behavior:
      { engineResourceId: string } | { unavailable: LaneEngineUnavailable } | 'throw',
  ) {}

  open(lane: LaneEngineLane): ReturnType<LaneEngine['open']> {
    this.opened.push(lane);
    if (this.behavior === 'throw') return Promise.reject(new NexarError('INTERNAL_ERROR', 'boom'));
    if ('unavailable' in this.behavior) return Promise.resolve(this.behavior);
    const session: LaneEngineSession = {
      engineResourceId: resourceId(this.behavior.engineResourceId),
      gateway,
      controlFailed: () => this.controlFailed,
      close: () => {
        this.closed += 1;
        return Promise.resolve();
      },
    };
    return Promise.resolve(session);
  }
}

let h: Harness | undefined;
beforeEach(() => {
  silentLogger.warnings.length = 0;
});
afterEach(() => {
  h?.dispose();
  h = undefined;
});

async function harness(laneEngine: LaneEngine | undefined): Promise<Harness> {
  const base = await createHarness({ newId: () => TASK, engineering: never });
  h = base;
  if (laneEngine === undefined) return base;
  return {
    ...base,
    run: (input = {}, options = {}) =>
      base
        .makeRunner({ laneEngine })
        .run({ projectId: 'demo', goal: 'Add the feature.', ...input }, options),
  };
}

const record = async (x: Harness): Promise<EngineeringRecord> => {
  const r = await readEngineeringRecord(x.stateDir, TASK);
  if (r === undefined) throw new Error('no record');
  return r;
};

describe.skipIf(process.platform === 'win32')('EngineeringRunner: engine gateway sessions', () => {
  it('gives write lanes a session and records the lane as engine-run', async () => {
    const engine = new FakeLaneEngine({ engineResourceId: 'impl' });
    const x = await harness(engine);
    const progress: EngineeringProgress[] = [];
    const outcome = await x.run({}, { onProgress: (e) => progress.push(e) });
    expect(outcome.status).toBe('committed');

    const writeCalls = x.adapter.calls.filter((c) => c.access === 'read-write');
    expect(writeCalls.length).toBeGreaterThan(0);
    for (const call of writeCalls) expect(call.gateway).toBe(gateway);
    const lanes = (await record(x)).lanes;
    for (const lane of lanes.filter((l) => l.laneId === 'feature')) {
      expect(lane).toMatchObject({
        executor: 'engine',
        engine: 'dsh',
        controlResourceId: 'control-model',
        controlDecisionId: 'dec-1',
      });
      expect(lane.executorReason).toBeUndefined();
    }
    // Every opened session was closed, and only write lanes opened one.
    expect(engine.closed).toBe(engine.opened.length);
    expect(engine.opened.every((l) => l.access === 'read-write' && l.projectId === 'demo')).toBe(
      true,
    );
    expect(engine.opened.map((l) => l.laneId)).not.toContain('review');
    const reviews = x.adapter.calls.filter((c) => c.lane === 'review');
    expect(reviews.length).toBeGreaterThan(0);
    for (const call of reviews) expect(call.gateway).toBeUndefined();
    for (const lane of lanes.filter((l) => l.role === 'review')) {
      expect(lane.executor).toBeUndefined();
    }
  });

  it.each(['control-unavailable', 'engine-unavailable'] as const)(
    'runs natively with reason %s',
    async (unavailable) => {
      const engine = new FakeLaneEngine({ unavailable });
      const x = await harness(engine);
      expect((await x.run()).status).toBe('committed');
      expect(x.adapter.calls.every((c) => c.gateway === undefined)).toBe(true);
      const feature = (await record(x)).lanes.find((l) => l.laneId === 'feature');
      expect(feature).toMatchObject({ executor: 'native', executorReason: unavailable });
      expect(feature?.engine).toBeUndefined();
      expect(engine.closed).toBe(0);
    },
  );

  it('treats a throwing open as engine-unavailable', async () => {
    const x = await harness(new FakeLaneEngine('throw'));
    expect((await x.run()).status).toBe('committed');
    expect((await record(x)).lanes.find((l) => l.laneId === 'feature')).toMatchObject({
      executor: 'native',
      executorReason: 'engine-unavailable',
    });
    expect(silentLogger.warnings).toContain('engine session could not be opened');
  });

  it('records engine-not-selected and passes no gateway when routing picks another resource', async () => {
    const engine = new FakeLaneEngine({ engineResourceId: 'architect' });
    const x = await harness(engine);
    expect((await x.run()).status).toBe('committed');
    const feature = x.adapter.calls.find((c) => c.lane === 'feature');
    expect(feature?.resourceId).toBe('impl');
    expect(feature?.gateway).toBeUndefined();
    expect((await record(x)).lanes.find((l) => l.laneId === 'feature')).toMatchObject({
      executor: 'native',
      executorReason: 'engine-not-selected',
    });
    expect(engine.closed).toBe(engine.opened.length);
  });

  it('prefers the engine resource first', async () => {
    // Both resources can implement; the engine's resource leads.
    const second = await createHarness({
      newId: () => TASK,
      engineering: never,
      resources: [
        { id: 'impl', capabilities: ['coding', 'repo-editing'] },
        { id: 'impl2', capabilities: ['coding', 'repo-editing'] },
        { id: 'reviewer', capabilities: ['code-review'] },
        { id: 'architect', capabilities: ['reasoning'] },
      ],
    });
    h = second;
    const outcome = await second
      .makeRunner({ laneEngine: new FakeLaneEngine({ engineResourceId: 'impl2' }) })
      .run({ projectId: 'demo', goal: 'Add the feature.' });
    expect(outcome.status).toBe('committed');
    expect(second.adapter.calls.find((c) => c.lane === 'feature')?.resourceId).toBe('impl2');
  });

  it('closes the session when the lane fails and reports a control failure as PROVIDER_ERROR', async () => {
    const engine = new FakeLaneEngine({ engineResourceId: 'impl' });
    const x = await harness(engine);
    x.adapter.queue('feature', () => {
      engine.controlFailed = true;
      throw new NexarError('INTERNAL_ERROR', 'engine died');
    });
    const outcome = await x.run();
    expect(outcome).toMatchObject({ status: 'failed', reason: 'lane.feature.PROVIDER_ERROR' });
    expect(engine.closed).toBe(1);
    expect((await record(x)).lanes[0]).toMatchObject({
      outcome: 'failed',
      errorCode: 'PROVIDER_ERROR',
      executor: 'engine',
      executorReason: 'control-resource-failed',
      controlDecisionId: 'dec-1',
    });
  });

  it('closes the session on an ordinary lane failure without claiming a control failure', async () => {
    const engine = new FakeLaneEngine({ engineResourceId: 'impl' });
    const x = await harness(engine);
    x.adapter.queue('feature', () => {
      throw new NexarError('PROVIDER_ERROR', 'upstream down');
    });
    expect(await x.run()).toMatchObject({ status: 'failed' });
    expect(engine.closed).toBe(1);
    const lane = (await record(x)).lanes[0];
    expect(lane?.executorReason).toBeUndefined();
  });

  it('closes the session on cancel', async () => {
    const engine = new FakeLaneEngine({ engineResourceId: 'impl' });
    const x = await harness(engine);
    const controller = new AbortController();
    x.adapter.queue(
      'feature',
      (_call, context) =>
        new Promise<string>((_resolve, reject) => {
          context.signal.addEventListener('abort', () =>
            reject(new NexarError('EXECUTION_CANCELLED', 'stopped')),
          );
        }),
    );
    const outcome = await x.run(
      {},
      {
        signal: controller.signal,
        onProgress: (e) => {
          if (e.type === 'lane.started') setTimeout(() => controller.abort(), 20);
        },
      },
    );
    expect(outcome.status).toBe('cancelled');
    expect(engine.closed).toBe(1);
  });

  it('survives a failing close and never leaks the token', async () => {
    const engine = new FakeLaneEngine({ engineResourceId: 'impl' });
    const open = engine.open.bind(engine);
    engine.open = async (lane) => {
      const opened = await open(lane);
      if ('unavailable' in opened) return opened;
      return { ...opened, close: () => Promise.reject(new NexarError('INTERNAL_ERROR', 'x')) };
    };
    const x = await harness(engine);
    const progress: EngineeringProgress[] = [];
    expect((await x.run({}, { onProgress: (e) => progress.push(e) })).status).toBe('committed');
    expect(silentLogger.warnings).toContain('engine session could not be closed');
    const everything = JSON.stringify([await record(x), x.events, progress, silentLogger.warnings]);
    expect(everything).not.toContain(SENTINEL);
  });

  it('is byte-identical in records without a LaneEngine', async () => {
    const x = await harness(undefined);
    expect((await x.run()).status).toBe('committed');
    for (const lane of (await record(x)).lanes) {
      expect(Object.keys(lane)).not.toEqual(expect.arrayContaining(['executor']));
    }
    expect(x.adapter.calls.every((c) => c.gateway === undefined)).toBe(true);
  });

  it('does not open sessions for report plans', async () => {
    const engine = new FakeLaneEngine({ engineResourceId: 'impl' });
    const x = await harness(engine);
    await x.run({ planId: 'repository-report' });
    expect(engine.opened).toHaveLength(0);
  });
});
