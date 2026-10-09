import { mkdtemp, realpath, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { isControlCompatible, type ControlLineage } from '@nexar/contracts';
import { ControlModelGateway } from '@nexar/engine-gateway';
import { startFakeResponsesServer, type FakeResponsesServer } from '@nexar/integration-pi/testing';
import { noopLogger } from '@nexar/telemetry';
import {
  chatGptPlanModelResource,
  compose,
  createControlModelTurnPorts,
  loadHostConfig,
  type ConnectionSeam,
  type HostEnvironment,
} from './index.js';

/*
 * A Cowork-style control loop (ADR-027 section 7A) on a `chatgpt-plan:*` resource: the real gateway,
 * the real pi model-turn port and the real registry, with the plan's token seam answering and the
 * Responses route served by a local fake. Nothing contacts OpenAI.
 */

const TOKEN = 'plan-token-sentinel-7';
const OPENAI = 'https://api.openai.com/v1';
const lineage: ControlLineage = {
  rootSessionId: 's1',
  turnId: 't1',
  correlationId: 'c1',
  depth: 0,
};

let server: FakeResponsesServer;
let cwd: string;
let host: HostEnvironment;

beforeAll(async () => {
  server = await startFakeResponsesServer();
});
afterAll(async () => {
  await server.close();
});
beforeEach(async () => {
  server.requests.length = 0;
  server.replies = [];
  cwd = await realpath(await mkdtemp(join(tmpdir(), 'nexar-plan-control-')));
  host = { env: { PATH: '' }, cwd };
});
afterEach(async () => {
  await rm(cwd, { recursive: true, force: true });
});

const connections: ConnectionSeam = {
  resolve: () => Promise.resolve(TOKEN),
  fetch: (input, init) => {
    const target =
      typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
    return fetch(`${server.url}/v1/${target.slice(OPENAI.length + 1)}`, init);
  },
};

describe('Cowork control loop on a ChatGPT plan resource', () => {
  it('selects the plan resource, runs a tool-calling turn and keeps the token out of results', async () => {
    const loaded = await loadHostConfig(host, undefined);
    const plan = chatGptPlanModelResource('gpt-5.2');
    const composition = await compose(loaded, host, noopLogger, {
      connections,
      extraResources: [plan],
    });
    await composition.runtime.registry.refresh();
    const snapshots = composition.runtime.registry.snapshot();
    const snapshot = snapshots.find((s) => s.descriptor.id === plan.id);
    expect(snapshot?.state).toMatchObject({ availability: 'available', auth: 'authenticated' });
    expect(snapshot?.descriptor.provenance).toBe('discovered:host');
    expect(isControlCompatible(plan, 'openworker')).toBe(true);

    const gateway = new ControlModelGateway({
      ports: createControlModelTurnPorts(host, { connections }),
      candidates: () => composition.runtime.registry.snapshot(),
      policy: composition.runtime.policy,
      clock: () => new Date('2026-03-01T12:00:00.000Z'),
      newId: () => 'decision-1',
      logger: noopLogger,
    });
    const decision = gateway.begin('openworker', { mode: 'auto', fallback: 'auto' }, lineage);
    expect(decision.resourceId).toBe('chatgpt-plan:gpt-5.2');

    server.replies = [{ kind: 'tool-call', name: 'list_files', arguments: '{"dir":"."}' }];
    const result = await gateway.turn(
      {
        lineage,
        engine: 'openworker',
        controlDecisionId: decision.controlDecisionId,
        messages: [{ role: 'user', content: 'what is here?' }],
        tools: [
          {
            name: 'list_files',
            description: 'Lists files',
            parameters: { type: 'object', properties: { dir: { type: 'string' } } },
          },
        ],
      },
      new AbortController().signal,
    );
    expect(result.resourceId).toBe('chatgpt-plan:gpt-5.2');
    expect(result.finishReason).toBe('tool-calls');
    expect(result.toolCalls[0]).toMatchObject({ name: 'list_files', arguments: { dir: '.' } });
    expect(server.requests[0]?.headers['authorization']).toBe(`Bearer ${TOKEN}`);
    expect(server.requests[0]?.body['input']).toContainEqual({
      type: 'additional_tools',
      role: 'developer',
      tools: [
        {
          type: 'function',
          name: 'list_files',
          description: 'Lists files',
          parameters: { type: 'object', properties: { dir: { type: 'string' } } },
        },
      ],
    });
    expect(server.requests[0]?.body).not.toHaveProperty('tools');
    expect(JSON.stringify(result)).not.toContain(TOKEN);

    // A refusal of the capability is a control failure: not retried (the same body cannot succeed).
    server.replies = [
      { kind: 'error', status: 400, code: 'subscription_sharing_unsupported_capability' },
    ];
    server.requests.length = 0;
    const failure = await gateway
      .turn(
        {
          lineage,
          engine: 'openworker',
          controlDecisionId: decision.controlDecisionId,
          messages: [{ role: 'user', content: 'again' }],
        },
        new AbortController().signal,
      )
      .then(
        () => undefined,
        (e: unknown) => e as { code?: string; details?: Record<string, unknown> },
      );
    expect(failure?.code).toBe('PROVIDER_ERROR');
    expect(server.requests).toHaveLength(1);
  });

  it('is not a control candidate without the resource (nothing is published by default)', async () => {
    const loaded = await loadHostConfig(host, undefined);
    const composition = await compose(loaded, host, noopLogger, { connections });
    expect(
      composition.runtime.registry.list().some((r) => String(r.id).startsWith('chatgpt-plan:')),
    ).toBe(false);
  });
});
