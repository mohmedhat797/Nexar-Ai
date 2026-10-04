import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Client, InMemoryTransport } from '@modelcontextprotocol/client';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { measured, type Logger, type RouteDecision } from '@nexar/contracts';
// The relay is exercised against the real bridge endpoint and bridge; only the engine is faked.
import { BridgeHost, type ChildTaskInput } from '@nexar/engine-gateway';
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

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'nexar-relay-int-'));
    let n = 0;
    host = new BridgeHost({
      allocator: {
        allocate: (ledger) =>
          Promise.resolve({
            decision: {
              outcome: 'selected',
              selected: { resourceId: 'res-a' },
            } as unknown as RouteDecision,
            ledger,
          }),
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
      engine: 'openworker',
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
      engine: 'openworker',
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
