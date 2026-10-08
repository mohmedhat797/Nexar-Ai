import { describe, expect, it } from 'vitest';
import {
  NexarError,
  estimated,
  isNexarError,
  measured,
  unavailable,
  type BridgeGrant,
  type IntelligenceRequest,
  type Logger,
  type Measured,
  type ResourceSnapshot,
} from '@nexar/contracts';
import { allocateNext } from '@nexar/resource-controller';
import {
  IntelligenceBridge,
  type BridgeAllocator,
  type BridgeEvent,
  type BridgeJobStatus,
  type ChildExecution,
  type ChildExecutor,
  type ChildTaskInput,
} from './bridge.js';
import { NOW, routingPolicy, snap } from './fixtures.js';

const SENTINEL = 'SENTINEL-input-output-ref';

const grant: BridgeGrant = {
  grantId: 'g1',
  sessionId: 's1',
  turnId: 't1',
  projectId: 'proj',
  engine: 'openworker',
  access: 'draft',
  maxUnits: 8,
  expiresAt: '2026-03-01T13:00:00.000Z',
};

const request = (patch: Partial<IntelligenceRequest> = {}): IntelligenceRequest => ({
  lineage: {
    rootSessionId: 's1',
    turnId: 't1',
    correlationId: 'c1',
    depth: 0,
    chain: ['nexar', 'openworker'],
  },
  unitId: 'u1',
  kind: 'analysis',
  requirements: { capabilities: ['text-generation'] },
  input: 'summarize this',
  access: 'read-only',
  ...patch,
});

const execution = (resourceId: string, cost = measured(0)): ChildExecution => ({
  text: 'the answer',
  resourceId,
  usage: { inputTokens: measured(10), outputTokens: measured(5), costUsd: cost },
});

const silent: Logger = {
  debug: () => undefined,
  info: () => undefined,
  warn: () => undefined,
  error: () => undefined,
  child: () => silent,
};

interface SetupOptions {
  readonly candidates?: readonly ResourceSnapshot[];
  readonly executor?: ChildExecutor;
  readonly now?: () => Date;
  readonly maxJobsPerGrant?: number;
  readonly grant?: Partial<BridgeGrant>;
}

function setup(options: SetupOptions = {}) {
  const candidates = options.candidates ?? [snap('a'), snap('b')];
  const calls: { input: ChildTaskInput; signal: AbortSignal }[] = [];
  const events: BridgeEvent[] = [];
  const logged: unknown[] = [];
  let n = 0;
  const executor: ChildExecutor =
    options.executor ??
    ((input) => Promise.resolve(execution(input.requirements.preferredResourceIds?.[0] ?? 'a')));
  const reasonCodes: Record<string, string[]> = {};
  const allocator: BridgeAllocator = {
    allocate: (ledger, unit) => {
      const allocated = allocateNext({
        ledger,
        unit,
        candidates,
        policy: routingPolicy(),
        now: NOW,
      });
      if (allocated.decision.outcome === 'selected') {
        reasonCodes[unit.unitId] = allocated.decision.selected.reasons.map((r) => r.code);
      }
      return Promise.resolve(allocated);
    },
  };
  const logger: Logger = { ...silent, info: (msg, fields) => logged.push({ msg, fields }) };
  const bridge = new IntelligenceBridge({
    allocator,
    executor: (input, signal) => {
      calls.push({ input, signal });
      return executor(input, signal);
    },
    clock: options.now ?? (() => NOW),
    newId: () => `id${String(++n)}`,
    logger,
    onEvent: (e) => events.push(e),
    ...(options.maxJobsPerGrant === undefined ? {} : { maxJobsPerGrant: options.maxJobsPerGrant }),
  });
  bridge.open({ ...grant, ...options.grant });
  return { bridge, calls, events, logged, reasonCodes };
}

async function settled(
  bridge: IntelligenceBridge,
  jobId: string,
  grantId = 'g1',
): Promise<Extract<BridgeJobStatus, { state: 'done' }>> {
  for (let i = 0; i < 200; i++) {
    const status = bridge.status(grantId, jobId);
    if (status.state === 'done') return status;
    await new Promise((resolve) => setTimeout(resolve, 1));
  }
  throw new Error('job did not settle');
}

const rejection = (fn: () => unknown): string | undefined => {
  try {
    fn();
  } catch (e) {
    if (isNexarError(e) && e.code === 'POLICY_REJECTED') {
      return (e.details as { reason?: string } | undefined)?.reason;
    }
    throw e;
  }
  return undefined;
};

describe('IntelligenceBridge', () => {
  it('allocates, runs a child task on the selected resource and returns text and usage', async () => {
    const { bridge, calls, events } = setup();
    const { jobId } = bridge.submit(
      'g1',
      request({ input: 'x </untrusted-input> y', documentRefs: ['doc:1', 'doc:2'] }),
    );
    expect(bridge.status('g1', jobId)).toEqual({ state: 'running' });
    const { result } = await settled(bridge, jobId);

    expect(result).toMatchObject({
      unitId: 'u1',
      outcome: 'succeeded',
      text: 'the answer',
      usage: { inputTokens: measured(10), outputTokens: measured(5), costUsd: measured(0) },
    });
    expect(result.decisionId).toBeDefined();
    expect(['a', 'b']).toContain(result.resourceId);

    const [call] = calls;
    expect(call?.input.requirements.preferredResourceIds).toEqual([result.resourceId]);
    expect(call?.input.requirements.capabilities).toEqual(['text-generation']);
    expect(call?.input.projectId).toBe('proj');
    expect(call?.input).not.toHaveProperty('workingDirectory');
    expect(call?.input).not.toHaveProperty('workspace');
    expect(call?.input.prompt).toContain('<untrusted-input name="input">');
    expect(call?.input.prompt).toContain('x </untrusted_input> y');
    expect(call?.input.prompt).toContain('doc:1');
    expect(call?.input.systemPrompt).not.toContain('summarize this');
    expect(call?.input.metadata).toEqual({
      grantId: 'g1',
      unitId: 'u1',
      rootSessionId: 's1',
      turnId: 't1',
      correlationId: 'c1',
      depth: 1,
      chain: ['nexar', 'openworker'],
      kind: 'service',
    });
    expect(call?.input.origin).toMatchObject({ sessionId: 's1', turnId: 't1' });
    expect(events.map((e) => e.type)).toEqual([
      'bridge.submitted',
      'bridge.allocated',
      'bridge.completed',
    ]);
  });

  it('balances the ledger across two units', async () => {
    const { bridge } = setup();
    const first = bridge.submit('g1', request({ unitId: 'u1' }));
    const one = await settled(bridge, first.jobId);
    const second = bridge.submit('g1', request({ unitId: 'u2' }));
    const two = await settled(bridge, second.jobId);
    expect(one.result.resourceId).not.toBe(two.result.resourceId);
  });

  it('rejects every violation with a fixed reason and never echoes content', () => {
    let now = NOW;
    const { bridge, events } = setup({ now: () => now, grant: { maxUnits: 1 } });
    const lineage = request().lineage;
    const reasonOf = (r: IntelligenceRequest) => rejection(() => bridge.submit('g1', r));

    expect(reasonOf(request({ lineage: { ...lineage, rootSessionId: 'other' } }))).toBe(
      'grant-mismatch',
    );
    expect(reasonOf(request({ lineage: { ...lineage, turnId: 'other' } }))).toBe('grant-mismatch');
    expect(reasonOf(request({ lineage: { ...lineage, chain: ['nexar'] } }))).toBe('grant-mismatch');
    expect(rejection(() => bridge.submit('nope', request()))).toBe('grant-mismatch');
    expect(reasonOf(request({ lineage: { ...lineage, depth: 2 } }))).toBe('depth-exceeded');
    expect(bridge.submit('g1', request({ lineage: { ...lineage, depth: 1 } })).jobId).toBeDefined();
    expect(reasonOf(request({ unitId: 'u2' }))).toBe('unit-limit');
    now = new Date('2026-03-01T13:00:00.000Z');
    expect(reasonOf(request({ unitId: 'u3' }))).toBe('grant-expired');

    for (const e of events.filter((x) => x.type === 'bridge.rejected')) {
      expect(e.reason).toBeDefined();
    }
  });

  it('refuses to widen scope', () => {
    const { bridge } = setup({ grant: { access: 'read-only' } });
    expect(rejection(() => bridge.submit('g1', request({ access: 'draft' })))).toBe(
      'scope-widening',
    );
    expect(bridge.submit('g1', request({ access: 'read-only' })).jobId).toBeDefined();
  });

  it('rejects invalid requests and duplicate unit ids', async () => {
    const { bridge } = setup();
    expect(() => bridge.submit('g1', request({ unitId: 'bad id' }))).toThrow(/unitId/);
    const { jobId } = bridge.submit('g1', request());
    expect(() => bridge.submit('g1', request())).toThrow(/Duplicate/);
    await settled(bridge, jobId);
  });

  describe('reviewOf', () => {
    // `a` is free and `b` is paid, so without review diversity both units would land on `a`.
    const cheapAndDear = [snap('a'), snap('b', { cost: { model: 'subscription' } })];

    it('keeps the reviewing unit off the reviewed unit’s resource when another is eligible', async () => {
      const { bridge, reasonCodes } = setup({ candidates: cheapAndDear });
      const draft = await settled(bridge, bridge.submit('g1', request({ unitId: 'draft' })).jobId);
      const review = await settled(
        bridge,
        bridge.submit('g1', request({ unitId: 'review', reviewOf: 'draft' })).jobId,
      );
      expect(draft.result.resourceId).toBe('a');
      expect(review.result.resourceId).toBe('b');
      expect(reasonCodes['draft']).not.toContain('strategy.diversity');
    });

    it('allocates a reviewer submitted while the reviewed unit is still running', async () => {
      const { bridge } = setup({
        candidates: cheapAndDear,
        executor: async (input) => {
          await new Promise((r) => setTimeout(r, 5));
          return execution(input.requirements.preferredResourceIds?.[0] ?? 'a');
        },
      });
      const draft = bridge.submit('g1', request({ unitId: 'draft' }));
      const review = bridge.submit('g1', request({ unitId: 'review', reviewOf: 'draft' }));
      const [d, r] = [await settled(bridge, draft.jobId), await settled(bridge, review.jobId)];
      expect(r.result.resourceId).not.toBe(d.result.resourceId);
    });

    it('uses the same resource and records the reason when it is the only one eligible', async () => {
      const { bridge, reasonCodes } = setup({ candidates: [snap('a')] });
      await settled(bridge, bridge.submit('g1', request({ unitId: 'draft' })).jobId);
      const review = await settled(
        bridge,
        bridge.submit('g1', request({ unitId: 'review', reviewOf: 'draft' })).jobId,
      );
      expect(review.result.resourceId).toBe('a');
      expect(reasonCodes['review']).toContain('strategy.diversity');
    });

    it('normalizes sentinel reviewOf values ("none", "null", "", whitespace) to undefined', () => {
      const { bridge } = setup({ candidates: cheapAndDear });
      const s1 = bridge.submit('g1', request({ unitId: 'u1', reviewOf: 'none' }));
      expect(s1.jobId).toBeDefined();
      const s2 = bridge.submit('g1', request({ unitId: 'u2', reviewOf: 'null' }));
      expect(s2.jobId).toBeDefined();
      const s3 = bridge.submit('g1', request({ unitId: 'u3', reviewOf: '   ' }));
      expect(s3.jobId).toBeDefined();
    });

    it('normalizes legacy capability aliases and matches available resources', async () => {
      const luna = snap('luna', {
        capabilities: ['text-generation', 'knowledge-work', 'model-turn'],
      });
      const { bridge, reasonCodes } = setup({
        candidates: [luna],
        executor: (input) =>
          Promise.resolve(execution(input.requirements.preferredResourceIds?.[0] ?? 'luna')),
      });
      const sowJob = bridge.submit(
        'g1',
        request({
          unitId: 'sow-1',
          kind: 'general',
          requirements: {
            capabilities: ['requirements-analysis', 'technical-writing', 'project-planning'],
          },
        }),
      );
      const settledSow = await settled(bridge, sowJob.jobId);
      expect(settledSow.result.outcome).toBe('succeeded');
      expect(settledSow.result.resourceId).toBe('luna');
      expect(reasonCodes['sow-1']).toContain('capability.match');
    });

    it('fails closed with NO_ELIGIBLE_RESOURCE when required capabilities include unknown strings', async () => {
      const luna = snap('luna', {
        capabilities: ['text-generation', 'knowledge-work', 'model-turn'],
      });
      const { bridge } = setup({ candidates: [luna] });
      const failJob = bridge.submit(
        'g1',
        request({
          unitId: 'unknown-cap',
          requirements: {
            capabilities: ['requirements-analysis', 'quantum-computing'],
          },
        }),
      );
      const settledFail = await settled(bridge, failJob.jobId);
      expect(settledFail.result.outcome).toBe('failed');
      expect(settledFail.result.errorCode).toBe('NO_ELIGIBLE_RESOURCE');
    });

    it('rejects an unknown, self or other-grant reviewOf with a fixed reason', async () => {
      const { bridge, events } = setup({ candidates: cheapAndDear });
      const reasonOf = (r: IntelligenceRequest) => rejection(() => bridge.submit('g1', r));
      expect(reasonOf(request({ unitId: 'review', reviewOf: 'draft' }))).toBe(
        'unknown-reviewed-unit',
      );
      expect(reasonOf(request({ unitId: 'review', reviewOf: 'review' }))).toBe(
        'unknown-reviewed-unit',
      );
      expect(() => bridge.submit('g1', request({ unitId: 'x', reviewOf: 'bad id' }))).toThrow(
        /reviewOf/,
      );

      // A unit of another grant is not a unit of this one.
      bridge.open({ ...grant, grantId: 'g2', turnId: 't2' });
      const other = request({ unitId: 'foreign' });
      const { jobId } = bridge.submit('g2', {
        ...other,
        lineage: { ...other.lineage, turnId: 't2' },
      });
      await settled(bridge, jobId, 'g2');
      expect(reasonOf(request({ unitId: 'review', reviewOf: 'foreign' }))).toBe(
        'unknown-reviewed-unit',
      );
      expect(
        events.filter((e) => e.reason === 'unknown-reviewed-unit').every((e) => e.unitId),
      ).toBe(true);
      // None of them consumed a unit slot.
      expect(bridge.submit('g1', request({ unitId: 'draft' })).jobId).toBeDefined();
    });
  });

  it('caps units at maxJobsPerGrant', () => {
    const { bridge } = setup({ maxJobsPerGrant: 1 });
    bridge.submit('g1', request({ unitId: 'u1' }));
    expect(rejection(() => bridge.submit('g1', request({ unitId: 'u2' })))).toBe('unit-limit');
  });

  it('stops after the budget is spent, using measured cost only', async () => {
    const { bridge, calls } = setup({
      grant: { budgetUsd: 0.01 },
      executor: (input) =>
        Promise.resolve(
          execution(input.requirements.preferredResourceIds?.[0] ?? 'a', measured(0.01)),
        ),
    });
    const { jobId } = bridge.submit('g1', request());
    await settled(bridge, jobId);
    expect(calls[0]?.input.requirements.maxCostUsd).toBeCloseTo(0.01);
    expect(bridge.accounting('g1')).toEqual({ spentUsd: 0.01, unaccounted: 0 });
    expect(rejection(() => bridge.submit('g1', request({ unitId: 'u2' })))).toBe(
      'budget-exhausted',
    );
  });

  it('counts estimated cost and never treats unavailable cost as zero', async () => {
    let cost: Measured<number> = estimated(0.002, 'tokens');
    const { bridge } = setup({
      grant: { budgetUsd: 1 },
      executor: (input) =>
        Promise.resolve(execution(input.requirements.preferredResourceIds?.[0] ?? 'a', cost)),
    });
    await settled(bridge, bridge.submit('g1', request({ unitId: 'u1' })).jobId);
    expect(bridge.accounting('g1')).toEqual({ spentUsd: 0.002, unaccounted: 0 });
    cost = unavailable();
    await settled(bridge, bridge.submit('g1', request({ unitId: 'u2' })).jobId);
    expect(bridge.accounting('g1')).toEqual({ spentUsd: 0.002, unaccounted: 1 });
  });

  it('fails with NO_ELIGIBLE_RESOURCE when nothing can run the unit', async () => {
    const { bridge, calls } = setup({ candidates: [snap('a', { capabilities: [] })] });
    const { result } = await settled(bridge, bridge.submit('g1', request()).jobId);
    expect(result).toMatchObject({ outcome: 'failed', errorCode: 'NO_ELIGIBLE_RESOURCE' });
    expect(calls).toHaveLength(0);
  });

  it('turns an executor failure into a failed result with its code', async () => {
    const { bridge } = setup({
      executor: () => Promise.reject(new NexarError('PROVIDER_ERROR', `boom ${SENTINEL}`)),
    });
    const { result } = await settled(bridge, bridge.submit('g1', request()).jobId);
    expect(result).toMatchObject({ outcome: 'failed', errorCode: 'PROVIDER_ERROR' });
    expect(result.usage.costUsd.status).toBe('unavailable');
    expect(JSON.stringify(result)).not.toContain(SENTINEL);
  });

  it('times out an executor that ignores its signal', async () => {
    const { bridge } = setup({ executor: () => new Promise<ChildExecution>(() => undefined) });
    const { result } = await settled(bridge, bridge.submit('g1', request({ timeoutMs: 20 })).jobId);
    expect(result).toMatchObject({ outcome: 'failed', errorCode: 'EXECUTION_TIMEOUT' });
  });

  it('cancel aborts the executor signal and yields cancelled', async () => {
    const { bridge, calls } = setup({
      executor: () => new Promise<ChildExecution>(() => undefined),
    });
    const { jobId } = bridge.submit('g1', request());
    for (let i = 0; i < 50 && calls.length === 0; i++) await new Promise((r) => setTimeout(r, 1));
    bridge.cancel('g1', jobId);
    const { result } = await settled(bridge, jobId);
    expect(calls[0]?.signal.aborted).toBe(true);
    expect(result).toMatchObject({ outcome: 'cancelled', errorCode: 'EXECUTION_CANCELLED' });
  });

  it('close aborts running jobs and forgets the grant', async () => {
    const { bridge, calls, events } = setup({
      executor: () => new Promise<ChildExecution>(() => undefined),
    });
    const { jobId } = bridge.submit('g1', request());
    for (let i = 0; i < 50 && calls.length === 0; i++) await new Promise((r) => setTimeout(r, 1));
    bridge.close('g1');
    expect(calls[0]?.signal.aborted).toBe(true);
    expect(() => bridge.status('g1', jobId)).toThrow(/Unknown/);
    for (let i = 0; i < 50 && !events.some((e) => e.type === 'bridge.completed'); i++) {
      await new Promise((r) => setTimeout(r, 1));
    }
    expect(events.find((e) => e.type === 'bridge.completed')?.outcome).toBe('cancelled');
    expect(rejection(() => bridge.submit('g1', request()))).toBe('grant-mismatch');
  });

  it('never puts input, output or refs in events or logs', async () => {
    const { bridge, events, logged } = setup({
      executor: (input) =>
        Promise.resolve({
          ...execution(input.requirements.preferredResourceIds?.[0] ?? 'a'),
          text: SENTINEL,
        }),
    });
    const { jobId } = bridge.submit('g1', request({ input: SENTINEL, documentRefs: [SENTINEL] }));
    const { result } = await settled(bridge, jobId);
    expect(result.text).toBe(SENTINEL);
    expect(() =>
      bridge.submit('g1', request({ input: SENTINEL, access: 'draft', unitId: 'u1' })),
    ).toThrow();
    expect(JSON.stringify(events)).not.toContain(SENTINEL);
    expect(JSON.stringify(logged)).not.toContain(SENTINEL);
  });
});
