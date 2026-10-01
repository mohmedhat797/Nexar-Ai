import { describe, expect, it } from 'vitest';
import {
  NexarError,
  estimated,
  measured,
  unavailable,
  type CostEstimate,
  type ExecutionAdapter,
  type ExecutionResult,
  type Logger,
  type Measured,
  type ResourceRouter,
} from '@nexar/contracts';
import { InMemoryTelemetrySink } from '@nexar/telemetry';
import { EchoExecutionAdapter, echoResource } from '@nexar/integration-echo';
import { AdapterRegistry } from './adapter-registry.js';
import { parseConfig } from './config.js';
import { createNexar } from './create-nexar.js';
import { Nexar } from './engine.js';

function estimate(cashUsd: Measured<number>): CostEstimate {
  return { class: 'cash', cashUsd, inputTokens: 10, outputTokens: 20, estimator: 'estimator@1' };
}

const silent: Logger = {
  debug: () => undefined,
  info: () => undefined,
  warn: () => undefined,
  error: () => undefined,
  child: () => silent,
};

/** Routes like the real controller but attaches `cost`; the adapter reports `actual` as cost. */
function setup(cost: CostEstimate | undefined, actual: Measured<number> | 'fail') {
  const config = parseConfig(
    {
      version: 1,
      resources: [echoResource()],
      routing: { policy: 'deterministic', defaultResourceId: 'local-echo' },
    },
    'test',
  );
  const sink = new InMemoryTelemetrySink();
  const echo = new EchoExecutionAdapter();
  const base = createNexar(config, { adapters: [echo], telemetry: sink });
  const router: ResourceRouter = {
    async route(task) {
      const decision = await base.controller.route(task);
      if (decision.outcome !== 'selected' || cost === undefined) return decision;
      return { ...decision, selected: { ...decision.selected, cost } };
    },
  };
  const adapter: ExecutionAdapter = {
    id: echo.id,
    displayName: 'cost-fake',
    supports: (r) => echo.supports(r),
    probe: () => echo.probe(),
    async execute(request, context): Promise<ExecutionResult> {
      if (actual === 'fail') throw new NexarError('PROVIDER_ERROR', 'boom');
      const result = await echo.execute(request, context);
      return { ...result, usage: { ...result.usage, costUsd: actual } };
    },
  };
  const adapters = new AdapterRegistry();
  adapters.register(adapter);
  const nexar = new Nexar({
    registry: base.registry,
    router,
    adapters,
    telemetry: sink,
    logger: silent,
  });
  return { nexar, sink };
}

const run = async (s: ReturnType<typeof setup>) =>
  s.nexar.run(s.nexar.createTask({ kind: 'general', prompt: 'x' }));

describe('estimate vs actual', () => {
  it('records absolute and relative error for measured actuals', async () => {
    const s = setup(estimate(estimated(0.012, 'b')), measured(0.01));
    await run(s);
    const rec = s.sink.records()[0]?.costEstimate;
    expect(rec).toMatchObject({
      estimator: 'estimator@1',
      class: 'cash',
      estimatedUsd: { status: 'estimated', value: 0.012 },
      actualUsd: { status: 'measured', value: 0.01 },
    });
    expect(rec?.absoluteErrorUsd).toBeCloseTo(0.002, 9);
    expect(rec?.relativeError).toBeCloseTo(0.2, 9);
  });

  it('accepts estimated actuals', async () => {
    const s = setup(estimate(estimated(0.5, 'b')), estimated(0.25, 'list price'));
    await run(s);
    const rec = s.sink.records()[0]?.costEstimate;
    expect(rec?.absoluteErrorUsd).toBe(0.25);
    expect(rec?.relativeError).toBe(1);
  });

  it('omits relativeError when the actual is 0', async () => {
    const s = setup(estimate(estimated(0.5, 'b')), measured(0));
    await run(s);
    const rec = s.sink.records()[0]?.costEstimate;
    expect(rec?.absoluteErrorUsd).toBe(0.5);
    expect(rec).not.toHaveProperty('relativeError');
  });

  it('records no errors when the actual is unavailable', async () => {
    const s = setup(estimate(estimated(0.5, 'b')), unavailable('n/a'));
    await run(s);
    const rec = s.sink.records()[0]?.costEstimate;
    expect(rec?.actualUsd.status).toBe('unavailable');
    expect(rec).not.toHaveProperty('absoluteErrorUsd');
    expect(rec).not.toHaveProperty('relativeError');
  });

  it('records no errors when the estimate is unavailable', async () => {
    const s = setup(estimate(unavailable('no size facts')), measured(0.1));
    await run(s);
    const rec = s.sink.records()[0]?.costEstimate;
    expect(rec?.estimatedUsd.status).toBe('unavailable');
    expect(rec).not.toHaveProperty('absoluteErrorUsd');
  });

  it('is recorded on failure with an unavailable actual', async () => {
    const s = setup(estimate(estimated(0.5, 'b')), 'fail');
    await expect(run(s)).rejects.toThrow();
    const rec = s.sink.records()[0]?.costEstimate;
    expect(rec).toMatchObject({
      estimatedUsd: { value: 0.5 },
      actualUsd: { status: 'unavailable' },
    });
    expect(rec).not.toHaveProperty('absoluteErrorUsd');
  });

  it('is absent when the selected assessment has no estimate', async () => {
    const s = setup(undefined, measured(0.1));
    await run(s);
    expect(s.sink.records()[0]).not.toHaveProperty('costEstimate');
  });

  it('never produces NaN or Infinity', async () => {
    const s = setup(estimate(estimated(Number.NaN, 'b')), measured(Infinity));
    await run(s);
    const rec = s.sink.records()[0]?.costEstimate;
    expect(rec).not.toHaveProperty('absoluteErrorUsd');
    expect(rec).not.toHaveProperty('relativeError');
  });
});
