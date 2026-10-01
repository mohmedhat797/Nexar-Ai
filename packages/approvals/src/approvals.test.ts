import { mkdtemp, readdir, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { isNexarError } from '@nexar/contracts';
import {
  ApprovalGate,
  FileApprovalStore,
  InMemoryApprovalStore,
  OutwardActionRegistry,
  V0_2_OUTWARD_EXECUTORS,
  canonicalJson,
  decide,
  fingerprintAction,
  performOutwardAction,
  recordPolicyDecision,
  type ApprovalStore,
  type OutwardAction,
} from './index.js';

class FakeClock {
  private ms = Date.parse('2026-01-01T00:00:00.000Z');
  now = (): Date => new Date(this.ms);
  advance(ms: number): void {
    this.ms += ms;
  }
}

const SECRET = 'hunter2-super-secret-body';
const action: OutwardAction = {
  type: 'email.send',
  target: 'alice@example.com',
  parameters: { subject: 'Hi', body: SECRET, cc: ['b@example.com'] },
};
const ctx = { summary: 'Send email to alice', risk: 'high' as const, taskId: 'task-1' };

async function expectDenied(p: Promise<unknown>, reason: string): Promise<void> {
  const err = await p.then(
    () => undefined,
    (e: unknown) => e,
  );
  expect(isNexarError(err)).toBe(true);
  const e = err as { code: string; details?: { reason?: string } };
  expect(e.code).toBe('APPROVAL_DENIED');
  expect(e.details?.reason).toBe(reason);
  expect(JSON.stringify(err)).not.toContain(SECRET);
}

async function waitForPending(store: ApprovalStore): Promise<string> {
  for (let i = 0; i < 2000; i++) {
    const [first] = await store.list({ status: 'pending' });
    if (first !== undefined) return first.id;
    await new Promise((r) => setTimeout(r, 2));
  }
  throw new Error('no pending approval appeared');
}

describe('canonicalJson / fingerprintAction', () => {
  it('is independent of key order', () => {
    expect(canonicalJson({ b: 1, a: { d: [1, { z: 1, y: 2 }], c: null } })).toBe(
      canonicalJson({ a: { c: null, d: [1, { y: 2, z: 1 }] }, b: 1 }),
    );
    expect(fingerprintAction(action)).toBe(
      fingerprintAction({
        parameters: action.parameters,
        target: action.target,
        type: action.type,
      }),
    );
    expect(fingerprintAction(action)).toMatch(/^[0-9a-f]{64}$/);
  });

  it('allows shared (non-cyclic) references', () => {
    const shared = { a: 1 };
    expect(canonicalJson({ x: shared, y: shared })).toBe('{"x":{"a":1},"y":{"a":1}}');
  });

  it('rejects non-JSON values', () => {
    const cyclic: Record<string, unknown> = {};
    cyclic['self'] = cyclic;
    const bad: unknown[] = [
      undefined,
      () => 1,
      Symbol('s'),
      10n,
      NaN,
      Infinity,
      -Infinity,
      cyclic,
      new Date(),
      new Map(),
      { nested: { u: undefined } },
      [undefined],
    ];
    for (const value of bad) {
      expect(() => canonicalJson(value)).toThrowError(
        expect.objectContaining({ code: 'VALIDATION_ERROR' }) as Error,
      );
    }
  });

  it('changes when any parameter changes', () => {
    const changed = { ...action, parameters: { ...action.parameters, cc: ['c@example.com'] } };
    expect(fingerprintAction(changed)).not.toBe(fingerprintAction(action));
  });
});

describe('ApprovalGate', () => {
  let dir: string;
  let clock: FakeClock;
  let store: FileApprovalStore;
  const gateFor = (s: ApprovalStore, instanceId?: string): ApprovalGate =>
    new ApprovalGate({
      mode: 'store',
      store: s,
      clock: clock.now,
      pollIntervalMs: 5,
      ...(instanceId === undefined ? {} : { instanceId }),
    });

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'nexar-approvals-'));
    clock = new FakeClock();
    store = new FileApprovalStore(join(dir, 'approvals'));
  });
  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it('defaults to deny-all and stores nothing', async () => {
    const gate = new ApprovalGate();
    await expectDenied(gate.request(action, ctx), 'no-approver');
    await expectDenied(new ApprovalGate({ mode: 'deny-all' }).request(action, ctx), 'no-approver');
    expect(await store.list()).toEqual([]);
  });

  it('approve path: grant consumes once', async () => {
    const gate = gateFor(store);
    const pending = gate.request(action, ctx);
    const id = await waitForPending(store);
    const decided = await decide(store, id, 'approve', {
      by: 'mo',
      reason: 'ok',
      clock: clock.now,
    });
    expect(decided.status).toBe('approved');
    const grant = await pending;
    await grant.consume(action);
    expect((await store.get(id))?.status).toBe('consumed');
    await expectDenied(grant.consume(action), 'already-consumed');
  });

  it('deny path', async () => {
    const gate = gateFor(store);
    const pending = gate.request(action, ctx);
    const assertion = expectDenied(pending, 'denied');
    const id = await waitForPending(store);
    await decide(store, id, 'deny', { by: 'mo', clock: clock.now });
    await assertion;
    const record = await store.get(id);
    expect(record?.status).toBe('denied');
    expect(record?.decidedBy).toBe('mo');
  });

  it('expires during the wait', async () => {
    const gate = gateFor(store);
    const pending = gate.request(action, { ...ctx, ttlMs: 1000 });
    const assertion = expectDenied(pending, 'expired');
    const id = await waitForPending(store);
    clock.advance(1000);
    await assertion;
    expect((await store.get(id))?.status).toBe('expired');
  });

  it('cannot decide an expired request', async () => {
    const gate = gateFor(store);
    const pending = gate.request(action, { ...ctx, ttlMs: 1000 });
    const assertion = expectDenied(pending, 'expired');
    const id = await waitForPending(store);
    clock.advance(5000);
    await expectDenied(decide(store, id, 'approve', { by: 'mo', clock: clock.now }), 'expired');
    await assertion;
    await expectDenied(
      decide(store, id, 'approve', { by: 'mo', clock: clock.now }),
      'invalid-state',
    );
  });

  it('refuses consume after the approval expired', async () => {
    const gate = gateFor(store);
    const pending = gate.request(action, { ...ctx, ttlMs: 1000 });
    const id = await waitForPending(store);
    await decide(store, id, 'approve', { by: 'mo', clock: clock.now });
    const grant = await pending;
    clock.advance(1000);
    await expectDenied(grant.consume(action), 'expired');
    expect((await store.get(id))?.status).toBe('expired');
  });

  it('cancels when aborted during the wait', async () => {
    const gate = gateFor(store);
    const controller = new AbortController();
    const pending = gate.request(action, { ...ctx, signal: controller.signal });
    const assertion = expectDenied(pending, 'aborted');
    const id = await waitForPending(store);
    controller.abort();
    await assertion;
    expect((await store.get(id))?.status).toBe('cancelled');
    await expectDenied(decide(store, id, 'approve', { by: 'mo' }), 'invalid-state');
  });

  it('fails closed when the store is unwritable', async () => {
    const blocker = join(dir, 'file');
    await writeFile(blocker, 'x');
    const gate = gateFor(new FileApprovalStore(join(blocker, 'approvals')));
    await expectDenied(gate.request(action, ctx), 'store-failure');
  });

  it('rejects a changed action at consume and cancels the approval', async () => {
    const gate = gateFor(store);
    const pending = gate.request(action, ctx);
    const id = await waitForPending(store);
    await decide(store, id, 'approve', { by: 'mo', clock: clock.now });
    const grant = await pending;
    const tampered = { ...action, parameters: { ...action.parameters, cc: ['evil@example.com'] } };
    await expectDenied(grant.consume(tampered), 'fingerprint-mismatch');
    expect((await store.get(id))?.status).toBe('cancelled');
    await expectDenied(grant.consume(action), 'already-consumed');
  });

  it('is single-use across processes (exactly one consume wins)', async () => {
    const gate = gateFor(store);
    const pending = gate.request(action, ctx);
    const id = await waitForPending(store);
    await decide(store, id, 'approve', { by: 'mo', clock: clock.now });
    const grant = await pending;
    const otherProcess = new FileApprovalStore(join(dir, 'approvals'));
    const results = await Promise.allSettled([
      grant.consume(action),
      otherProcess.transition(id, ['approved'], 'consumed', {}),
      otherProcess.transition(id, ['approved'], 'consumed', {}),
    ]);
    expect(results.filter((r) => r.status === 'fulfilled')).toHaveLength(1);
    expect((await store.get(id))?.status).toBe('consumed');
  });

  it('recovers after restart: old pending is cancelled and can no longer be approved', async () => {
    const oldGate = gateFor(store, 'old-instance');
    const controller = new AbortController();
    const pending = oldGate.request(action, { ...ctx, signal: controller.signal });
    const settled = pending.catch(() => undefined);
    const id = await waitForPending(store);

    const newGate = gateFor(new FileApprovalStore(join(dir, 'approvals')), 'new-instance');
    expect(await newGate.recoverAfterRestart()).toBe(1);
    const record = await store.get(id);
    expect(record?.status).toBe('cancelled');
    expect(record?.reason).toBe('restart');
    await expectDenied(decide(store, id, 'approve', { by: 'mo' }), 'invalid-state');
    controller.abort();
    await settled;
    expect(await newGate.recoverAfterRestart()).toBe(0);
  });

  it('does not cancel its own requests on recovery', async () => {
    const gate = gateFor(store, 'same');
    const controller = new AbortController();
    const settled = gate
      .request(action, { ...ctx, signal: controller.signal })
      .catch(() => undefined);
    await waitForPending(store);
    expect(await gate.recoverAfterRestart()).toBe(0);
    controller.abort();
    await settled;
  });

  it('fails closed on a corrupt record', async () => {
    const gate = gateFor(store);
    const pending = gate.request(action, ctx);
    const assertion = expectDenied(pending, 'unknown-state');
    const id = await waitForPending(store);
    await writeFile(join(dir, 'approvals', `${id}.json`), '{not json');
    await assertion;
    await expectDenied(decide(store, id, 'approve', { by: 'mo' }), 'unknown-state');
    await expect(store.transition(id, ['pending'], 'approved', {})).rejects.toMatchObject({
      code: 'APPROVAL_DENIED',
    });
    expect(await store.list()).toEqual([]);
  });

  it('fails closed when the record vanishes', async () => {
    const gate = gateFor(store);
    const assertion = expectDenied(gate.request(action, ctx), 'unknown-state');
    const id = await waitForPending(store);
    await rm(join(dir, 'approvals', `${id}.json`));
    await assertion;
  });

  it('rejects malformed ids without touching the filesystem', async () => {
    const untouched = new FileApprovalStore(join(dir, 'never-created'));
    for (const id of [
      '../etc/passwd',
      'apr_xyz',
      'apr_' + 'A'.repeat(32),
      '',
      'apr_' + 'a'.repeat(33),
    ]) {
      await expect(untouched.get(id)).rejects.toMatchObject({ code: 'VALIDATION_ERROR' });
      await expect(untouched.transition(id, ['pending'], 'approved', {})).rejects.toMatchObject({
        code: 'VALIDATION_ERROR',
      });
    }
    await expect(stat(join(dir, 'never-created'))).rejects.toMatchObject({ code: 'ENOENT' });
  });

  it('never stores action parameters and uses restrictive permissions', async () => {
    const gate = gateFor(store);
    const pending = gate.request(action, ctx);
    const id = await waitForPending(store);
    await decide(store, id, 'approve', { by: 'mo', clock: clock.now });
    const grant = await pending;
    await grant.consume(action);

    const approvalsDir = join(dir, 'approvals');
    const names = await readdir(approvalsDir);
    expect(names.sort()).toEqual([`${id}.consumed`, `${id}.json`]);
    for (const name of names) {
      const bytes = await readFile(join(approvalsDir, name), 'utf8');
      expect(bytes).not.toContain(SECRET);
      expect((await stat(join(approvalsDir, name))).mode & 0o777).toBe(0o600);
    }
    expect((await stat(approvalsDir)).mode & 0o777).toBe(0o700);
    const record = JSON.parse(await readFile(join(approvalsDir, `${id}.json`), 'utf8')) as Record<
      string,
      unknown
    >;
    expect(record['fingerprint']).toBe(fingerprintAction(action));
    expect(record).not.toHaveProperty('parameters');
  });

  it('validates the action shape', async () => {
    const gate = gateFor(store);
    await expect(gate.request({ ...action, type: 'Email' }, ctx)).rejects.toMatchObject({
      code: 'VALIDATION_ERROR',
    });
    await expect(gate.request({ ...action, target: 'x'.repeat(201) }, ctx)).rejects.toMatchObject({
      code: 'VALIDATION_ERROR',
    });
    expect(await store.list()).toEqual([]);
  });
});

describe('InMemoryApprovalStore', () => {
  it('enforces the transition table', async () => {
    const store = new InMemoryApprovalStore();
    const clock = new FakeClock();
    const gate = new ApprovalGate({ mode: 'store', store, clock: clock.now, pollIntervalMs: 5 });
    const pending = gate.request(action, ctx);
    const id = await waitForPending(store);
    await expectDenied(store.transition(id, ['approved'], 'consumed', {}), 'invalid-state');
    await expectDenied(store.transition(id, ['pending'], 'consumed', {}), 'invalid-state');
    await decide(store, id, 'approve', { by: 'mo', clock: clock.now });
    const grant = await pending;
    await grant.consume(action);
    await expectDenied(store.transition(id, ['approved'], 'consumed', {}), 'already-consumed');
    await expectDenied(store.transition(id, ['consumed'], 'approved', {}), 'invalid-state');
  });
});

describe('performOutwardAction', () => {
  it('v0.2 registers no executors', () => {
    expect(V0_2_OUTWARD_EXECUTORS).toEqual([]);
  });

  it('never sends without an executor, and never asks for approval', async () => {
    const store = new InMemoryApprovalStore();
    const gate = new ApprovalGate({ mode: 'store', store, pollIntervalMs: 5 });
    const registry = new OutwardActionRegistry();
    const err = await performOutwardAction(action, { registry, gate, ctx }).then(
      () => undefined,
      (e: unknown) => e,
    );
    expect(err).toMatchObject({ code: 'POLICY_REJECTED', details: { reason: 'no-executor' } });
    expect(await store.list()).toEqual([]);
  });

  it('denies by default even with an executor when no approver exists', async () => {
    const registry = new OutwardActionRegistry();
    let calls = 0;
    registry.register({ type: 'email.send', execute: () => Promise.resolve(void calls++) });
    await expectDenied(
      performOutwardAction(action, { registry, gate: new ApprovalGate(), ctx }),
      'no-approver',
    );
    expect(calls).toBe(0);
  });

  it('executes exactly once after approval', async () => {
    const store = new InMemoryApprovalStore();
    const gate = new ApprovalGate({ mode: 'store', store, pollIntervalMs: 5 });
    const registry = new OutwardActionRegistry();
    const executed: OutwardAction[] = [];
    registry.register({
      type: 'email.send',
      execute: (a) => {
        executed.push(a);
        return Promise.resolve();
      },
    });
    expect(registry.has('email.send')).toBe(true);
    expect(() =>
      registry.register({ type: 'email.send', execute: () => Promise.resolve() }),
    ).toThrow();

    const run = performOutwardAction(action, { registry, gate, ctx });
    const id = await waitForPending(store);
    await decide(store, id, 'approve', { by: 'mo' });
    await run;
    expect(executed).toEqual([action]);
    expect((await store.get(id))?.status).toBe('consumed');
  });

  it('does not execute when denied', async () => {
    const store = new InMemoryApprovalStore();
    const gate = new ApprovalGate({ mode: 'store', store, pollIntervalMs: 5 });
    const registry = new OutwardActionRegistry();
    let calls = 0;
    registry.register({ type: 'email.send', execute: () => Promise.resolve(void calls++) });
    const run = performOutwardAction(action, { registry, gate, ctx });
    const assertion = expectDenied(run, 'denied');
    const id = await waitForPending(store);
    await decide(store, id, 'deny', { by: 'mo' });
    await assertion;
    expect(calls).toBe(0);
  });
});

describe('recordPolicyDecision', () => {
  const agentAction: OutwardAction = {
    type: 'agent.tool',
    target: 'deepseek-harness:bash',
    parameters: { args: { command: SECRET } },
  };
  const policyCtx = {
    summary: 'tool allowed by policy',
    risk: 'medium' as const,
    taskId: 'task-1',
    metadata: { tool: 'bash' },
  };

  it('records an allowed decision as consumed, decided by policy, without parameters', async () => {
    const store = new InMemoryApprovalStore();
    const record = await recordPolicyDecision(store, agentAction, policyCtx, 'allowed');
    expect(record.status).toBe('consumed');
    expect(record.decidedBy).toBe('policy');
    expect(record.fingerprint).toBe(fingerprintAction(agentAction));
    expect(JSON.stringify(await store.get(record.id))).not.toContain(SECRET);
    expect(await store.list({ status: 'pending' })).toEqual([]);
  });

  it('records a denied decision as denied', async () => {
    const store = new InMemoryApprovalStore();
    const record = await recordPolicyDecision(store, agentAction, policyCtx, 'denied');
    expect(record.status).toBe('denied');
    expect(record.decidedBy).toBe('policy');
  });

  it('cannot be approved, consumed or reused afterwards', async () => {
    const store = new InMemoryApprovalStore();
    const record = await recordPolicyDecision(store, agentAction, policyCtx, 'allowed');
    await expectDenied(decide(store, record.id, 'approve', { by: 'someone' }), 'invalid-state');
  });
});
