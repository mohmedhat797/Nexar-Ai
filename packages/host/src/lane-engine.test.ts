import { existsSync, statSync } from 'node:fs';
import { mkdtemp, realpath, rm, writeFile } from 'node:fs/promises';
import { request, type IncomingMessage } from 'node:http';
import { connect } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { measured, type Logger, type ModelTurnPortRequest } from '@nexar/contracts';
import { createNexarWithProjects, parseConfig } from '@nexar/core';
import { deepseekHarnessResource } from '@nexar/integration-deepseek-harness';
import { EchoExecutionAdapter } from '@nexar/integration-echo';
import { piModelResource } from '@nexar/integration-pi';
import { SANDBOX_GATEWAY_PORT, validateServices } from '@nexar/sandbox';
import { PlaneLaneEngine, type PlaneLaneEngineOptions } from './lane-engine.js';

const logger: Logger = {
  debug: () => undefined,
  info: () => undefined,
  warn: () => undefined,
  error: () => undefined,
  child: () => logger,
};

const LANE = {
  engineeringTaskId: 'eng-0123456789ab',
  laneId: 'feature',
  role: 'feature',
  round: 0,
  projectId: 'demo',
  access: 'read-write',
} as const;

const dsh = deepseekHarnessResource();
const pi = piModelResource({
  id: 'control-model',
  provider: 'anthropic',
  model: 'm',
  capabilities: ['text-generation', 'reasoning', 'knowledge-work', 'model-turn'],
});

function chat(socketPath: string, token: string): Promise<{ status: number; body: string }> {
  return new Promise((resolve, reject) => {
    const payload = JSON.stringify({
      model: 'nexar-control',
      messages: [{ role: 'user', content: 'hi' }],
    });
    const req = request(
      {
        socketPath,
        method: 'POST',
        path: '/v1/chat/completions',
        headers: {
          host: `127.0.0.1:${String(SANDBOX_GATEWAY_PORT)}`,
          authorization: `Bearer ${token}`,
          'content-type': 'application/json',
          'content-length': Buffer.byteLength(payload),
        },
      },
      (res: IncomingMessage) => {
        let body = '';
        res.setEncoding('utf8');
        res.on('data', (chunk: string) => (body += chunk));
        res.on('end', () => resolve({ status: res.statusCode ?? 0, body }));
      },
    );
    req.on('error', reject);
    req.end(payload);
  });
}

function bridge(socketPath: string, frame: unknown): Promise<{ ok: boolean; code?: string }> {
  return new Promise((resolve, reject) => {
    const socket = connect(socketPath);
    let buffered = '';
    socket.setEncoding('utf8');
    socket.on('data', (chunk: string) => {
      buffered += chunk;
      if (buffered.includes('\n')) {
        socket.destroy();
        resolve(JSON.parse(buffered) as { ok: boolean; code?: string });
      }
    });
    socket.on('error', reject);
    socket.on('connect', () => socket.write(`${JSON.stringify(frame)}\n`));
  });
}

describe.skipIf(process.platform === 'win32')('PlaneLaneEngine', () => {
  let base: string;
  let relay: string;
  const calls: { resource: string; request: ModelTurnPortRequest }[] = [];

  beforeEach(async () => {
    base = await realpath(await mkdtemp(join(tmpdir(), 'nexar-lane-engine-')));
    relay = join(base, 'bridge-relay.cjs');
    await writeFile(relay, '// relay');
    calls.length = 0;
  });
  afterEach(async () => {
    await rm(base, { recursive: true, force: true });
  });

  async function engine(
    resources: readonly unknown[],
    extra: Partial<PlaneLaneEngineOptions> = {},
  ): Promise<PlaneLaneEngine> {
    const config = parseConfig(
      { version: 1, resources, routing: { policy: 'deterministic' } },
      'test',
      { baseDir: base },
    );
    const runtime = await createNexarWithProjects(config, {
      adapters: [new EchoExecutionAdapter()],
      logger,
    });
    return new PlaneLaneEngine({
      runtime,
      io: { env: {}, cwd: base },
      logger,
      stateDir: join(base, '.nexar'),
      ttlMs: 60_000,
      relayScript: relay,
      ports: (descriptor) => ({
        turn: (turnRequest) => {
          calls.push({ resource: descriptor.id, request: turnRequest });
          return Promise.resolve({
            text: 'fake-turn',
            toolCalls: [],
            finishReason: 'stop',
            usage: { inputTokens: measured(3), outputTokens: measured(1) },
          });
        },
      }),
      ...extra,
    });
  }

  it('is unavailable without a DeepSeek Harness resource', async () => {
    const e = await engine([pi]);
    expect(await e.open(LANE)).toEqual({ unavailable: 'engine-unavailable' });
  });

  it('is unavailable on win32', async () => {
    const e = await engine([dsh, pi], { platform: 'win32' });
    expect(await e.open(LANE)).toEqual({ unavailable: 'engine-unavailable' });
  });

  it('has no control resource without a model-turn resource', async () => {
    const e = await engine([dsh]);
    expect(await e.open(LANE)).toEqual({ unavailable: 'control-unavailable' });
    expect(existsSync(join(base, '.nexar', 'lanes'))).toBe(false);
  });

  it('serves the gateway and bridge on private sockets, then revokes and removes them', async () => {
    const e = await engine([dsh, pi]);
    const session = await e.open(LANE);
    if ('unavailable' in session) throw new Error(`unavailable: ${session.unavailable}`);
    const { gateway } = session;
    expect(session.engineResourceId).toBe(dsh.id);
    expect(gateway).toMatchObject({
      engine: 'dsh',
      model: 'nexar-control',
      controlResourceId: 'control-model',
    });
    expect(gateway.token.length).toBeGreaterThan(16);
    const { dir } = gateway.services;
    expect(gateway.services).toMatchObject({ gateway: true, bridge: true, relayScript: relay });
    expect(statSync(dir).mode & 0o777).toBe(0o700);
    expect(statSync(join(dir, 'gateway.sock')).mode & 0o777).toBe(0o600);
    expect(statSync(join(dir, 'bridge.sock')).mode & 0o777).toBe(0o600);
    // The sandbox accepts exactly this spec.
    await expect(validateServices(gateway.services)).resolves.toMatchObject({ dir });

    const reply = await chat(join(dir, 'gateway.sock'), gateway.token);
    expect(reply.status).toBe(200);
    expect(reply.body).toContain('fake-turn');
    expect(calls.map((c) => c.resource)).toEqual(['control-model']);

    const status = await bridge(join(dir, 'bridge.sock'), {
      v: 1,
      id: 's1',
      token: gateway.token,
      op: 'status',
      jobId: 'unknown-job',
    });
    // Authenticated: the failure is about the job, not about authentication.
    expect(status.code).not.toBe('AUTH_REQUIRED');

    expect(session.controlFailed?.()).toBe(false);
    await session.close();
    await session.close();
    expect(existsSync(dir)).toBe(false);
    await expect(chat(join(dir, 'gateway.sock'), gateway.token)).rejects.toBeDefined();
  });

  it('keeps lanes apart: a token is only valid on its own lane', async () => {
    const e = await engine([dsh, pi]);
    const first = await e.open(LANE);
    const second = await e.open({ ...LANE, laneId: 'second' });
    if ('unavailable' in first || 'unavailable' in second) throw new Error('unavailable');
    expect(second.gateway.services.dir).not.toBe(first.gateway.services.dir);
    const foreign = await chat(
      join(second.gateway.services.dir, 'gateway.sock'),
      first.gateway.token,
    );
    expect(foreign.status).toBe(401);
    await first.close();
    // Closing one lane leaves the other serving.
    const own = await chat(join(second.gateway.services.dir, 'gateway.sock'), second.gateway.token);
    expect(own.status).toBe(200);
    await second.close();
  });

  it('offers no bridge relay when the script is not built', async () => {
    const e = await engine([dsh, pi], { relayScript: join(base, 'missing.cjs') });
    const session = await e.open(LANE);
    if ('unavailable' in session) throw new Error('unavailable');
    expect(session.gateway.services.bridge).toBe(false);
    expect(session.gateway.services.relayScript).toBeUndefined();
    await session.close();
  });
});
