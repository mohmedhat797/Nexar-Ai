import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Client, InMemoryTransport } from '@modelcontextprotocol/client';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { measured, type Logger, type RouteDecision, type WorkUnit } from '@nexar/contracts';
// The relay is exercised against the real bridge endpoint and bridge; only the engine is faked.
import { BridgeHost, DelegationUnitLimit, type ChildTaskInput } from '@nexar/engine-gateway';
import { createBridgeRelayServer } from './bridge-relay.js';

const silent: Logger = {
  debug: () => undefined,
  info: () => undefined,
  warn: () => undefined,
  error: () => undefined,
  child: () => silent,
};

describe('relay <-> endpoint <-> bridge (fake executor)', () => {
  let dir: string;
  let host: BridgeHost;
  let client: Client;
  let close: () => void;
  const executed: ChildTaskInput[] = [];
  const allocated: WorkUnit[] = [];

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'nexar-relay-int-'));
    let n = 0;
    host = new BridgeHost({
      allocator: {
        allocate: (ledger, unit) => {
          allocated.push(unit);
          return Promise.resolve({
            decision: {
              outcome: 'selected',
              selected: { resourceId: 'res-a' },
            } as unknown as RouteDecision,
            ledger,
          });
        },
      },
      executor: (input) => {
        executed.push(input);
        return Promise.resolve({
          text: `done: ${input.prompt.length > 0 ? 'ok' : 'empty'}`,
          resourceId: 'res-a',
          usage: { inputTokens: measured(3), outputTokens: measured(2), costUsd: measured(0) },
        });
      },
      clock: () => new Date(),
      newId: () => `id${String(++n)}`,
      logger: silent,
      runtimeDir: join(dir, 'runtime'),
    });
    const endpoint = await host.start();
    const { token } = host.mint({
      sessionId: 's1',
      turnId: 't1',
      correlationId: 'c1',
      projectId: 'proj',
      engine: 'dsh',
      access: 'draft',
      maxUnits: 4,
      ttlMs: 60_000,
    });
    const relay = createBridgeRelayServer({ endpoint, token, version: '0.0.0' });
    close = () => relay.close();
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    await relay.create().connect(serverTransport);
    client = new Client({ name: 'test', version: '0.0.0' });
    await client.connect(clientTransport);
  });

  afterEach(async () => {
    close();
    await host.stop();
    await rm(dir, { recursive: true, force: true });
    executed.length = 0;
    allocated.length = 0;
  });

  const call = async (name: string, args: Record<string, unknown>) => {
    const result = (await client.callTool({ name, arguments: args })) as {
      content: { text: string }[];
      isError?: boolean;
    };
    return {
      body: JSON.parse(result.content[0]?.text ?? '') as Record<string, unknown>,
      isError: result.isError,
    };
  };

  const done = async (jobId: string) => {
    let result = await call('nexar.intelligence_status', { jobId });
    for (let i = 0; i < 100 && result.body['state'] !== 'done'; i++) {
      await new Promise((resolve) => setTimeout(resolve, 5));
      result = await call('nexar.intelligence_status', { jobId });
    }
    expect(result.body).toMatchObject({ state: 'done', result: { outcome: 'succeeded' } });
  };

  it('preserves standalone sentinel normalization and genuine multi-unit reviews on the default contract', async () => {
    const first = await call('nexar.intelligence_submit', {
      unitId: 'earlier',
      input: 'x',
      access: 'read-only',
    });
    await done(first.body['jobId'] as string);
    const review = await call('nexar.intelligence_submit', {
      unitId: 'review',
      reviewOf: 'earlier',
      input: 'x',
      access: 'read-only',
    });
    await done(review.body['jobId'] as string);
    expect(allocated[1]).toMatchObject({ reviewOf: 'earlier' });
    const invalid = await call('nexar.intelligence_submit', {
      unitId: 'invalid',
      reviewOf: 'not-admitted',
      input: 'x',
      access: 'read-only',
    });
    expect(invalid).toMatchObject({ isError: true, body: { error: 'POLICY_REJECTED' } });
    expect(allocated).toHaveLength(2);
    expect(executed).toHaveLength(2);
    // Existing relay/endpoint/bridge suites also cover all legacy sentinels separately.
    const sentinel = await call('nexar.intelligence_submit', {
      unitId: 'independent',
      reviewOf: 'none',
      input: 'x',
      access: 'read-only',
    });
    await done(sentinel.body['jobId'] as string);
    expect(allocated[2]).not.toHaveProperty('reviewOf');
  });

  it('restricted schema rejects historical invalid arguments before allocation, then completes exactly one independent unit', async () => {
    close();
    await client.close();
    const identity = {
      sessionId: 'restricted',
      turnId: 'restricted-turn',
      projectId: 'proj',
      engine: 'dsh' as const,
    };
    const { token } = host.mint({
      ...identity,
      correlationId: 'restricted-correlation',
      access: 'read-only',
      maxUnits: 1,
      unitLimit: new DelegationUnitLimit(1, identity),
      ttlMs: 60_000,
    });
    const relay = createBridgeRelayServer({
      endpoint: host.endpoint(),
      token,
      version: '0.0.0',
      standaloneOnly: true,
    });
    close = () => relay.close();
    const [a, b] = InMemoryTransport.createLinkedPair();
    await relay.create().connect(b);
    client = new Client({ name: 'restricted-test', version: '0.0.0' });
    await client.connect(a);
    const { tools } = await client.listTools();
    expect(
      tools.find((tool) => tool.name === 'nexar.intelligence_submit')?.inputSchema.properties,
    ).not.toHaveProperty('reviewOf');
    for (const [unitId, reviewOf] of [
      ['nxr066-review', 'nxr066-review'],
      ['nxr066-analysis', 'nxr055-analysis'],
    ]) {
      expect(
        await call('nexar.intelligence_submit', {
          unitId,
          reviewOf,
          input: 'x',
          access: 'read-only',
        }),
      ).toMatchObject({ isError: true, body: { error: 'VALIDATION_ERROR' } });
    }
    expect(allocated).toHaveLength(0);
    expect(executed).toHaveLength(0);
    const result = await call('nexar.intelligence_submit', {
      unitId: 'analysis',
      input: 'x',
      access: 'read-only',
      capabilities: ['code-review', 'requirements-analysis'],
    });
    expect(result.isError).toBeUndefined();
    await done(result.body['jobId'] as string);
    expect(allocated).toHaveLength(1);
    expect(executed).toHaveLength(1);
    expect(allocated[0]).not.toHaveProperty('reviewOf');
    expect(executed[0]?.requirements.capabilities).toEqual(['code-review', 'knowledge-work']);
    expect(executed[0]?.prompt).toMatch(/^Access: read-only\n/);
    expect(
      await call('nexar.intelligence_submit', {
        unitId: 'second',
        input: 'x',
        access: 'read-only',
      }),
    ).toMatchObject({ isError: true, body: { error: 'POLICY_REJECTED' } });
    expect(allocated).toHaveLength(1);
    expect(executed).toHaveLength(1);
  });

  it('submits a unit, polls it to done, and the child is bound to the grant', async () => {
    const submitted = await call('nexar.intelligence_submit', {
      unitId: 'u1',
      input: 'summarize this',
      access: 'read-only',
    });
    expect(submitted.isError).toBeUndefined();
    const jobId = submitted.body['jobId'] as string;

    let status = await call('nexar.intelligence_status', { jobId });
    for (let i = 0; i < 100 && status.body['state'] !== 'done'; i++) {
      await new Promise((resolve) => setTimeout(resolve, 10));
      status = await call('nexar.intelligence_status', { jobId });
    }
    expect(status.body['state']).toBe('done');
    expect(status.body['result']).toMatchObject({ outcome: 'succeeded', resourceId: 'res-a' });

    expect(executed).toHaveLength(1);
    expect(executed[0]?.projectId).toBe('proj');
    expect(executed[0]?.metadata).toMatchObject({ rootSessionId: 's1', turnId: 't1', depth: 2 });
  });

  it('surfaces host policy errors as isError codes', async () => {
    const readOnly = host.mint({
      sessionId: 's2',
      turnId: 't2',
      correlationId: 'c2',
      projectId: 'proj',
      engine: 'dsh',
      access: 'read-only',
      maxUnits: 1,
      ttlMs: 60_000,
    });
    const relay = createBridgeRelayServer({
      endpoint: host.endpoint(),
      token: readOnly.token,
      version: '0.0.0',
    });
    const [a, b] = InMemoryTransport.createLinkedPair();
    await relay.create().connect(b);
    const other = new Client({ name: 'test', version: '0.0.0' });
    await other.connect(a);
    const result = (await other.callTool({
      name: 'nexar.intelligence_submit',
      arguments: { unitId: 'u1', input: 'x', access: 'draft' },
    })) as { content: { text: string }[]; isError?: boolean };
    relay.close();
    expect(result.isError).toBe(true);
    expect(JSON.parse(result.content[0]?.text ?? '')).toEqual({ error: 'POLICY_REJECTED' });
    expect(executed).toHaveLength(0);
  });
});
