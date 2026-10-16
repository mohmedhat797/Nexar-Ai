import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { measured, resourceId, type TelemetryEvent } from '@nexar/contracts';
import { createNexar, parseConfig } from '@nexar/core';
import { ControlModelGateway } from '@nexar/engine-gateway';
import { TelemetryQuotaSource, noopLogger } from '@nexar/telemetry';

describe('control accounting: runtime sink → JSONL → quota source', () => {
  it('persists two model calls once each and attributes measured tokens to the selected resource', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'nexar-control-accounting-'));
    try {
      const config = parseConfig(
        {
          version: 1,
          resources: [
            {
              id: 'selected-model',
              displayName: 'Selected model',
              kind: { type: 'model', provider: 'offline', model: 'fixture', access: 'local' },
              capabilities: ['text-generation', 'knowledge-work', 'reasoning', 'model-turn'],
              runtime: { adapter: 'pi', locality: 'local' },
              auth: { mode: 'none' },
              cost: { model: 'unknown' },
              dataLocality: 'local',
            },
          ],
          routing: { policy: 'deterministic' },
          telemetry: { jsonlPath: 'accounting.jsonl' },
        },
        'control-accounting-test',
      );
      const runtime = createNexar(config, { adapters: [], configDir: dir });
      expect(runtime.telemetry).toBeDefined();
      const now = new Date('2026-10-10T12:00:00.000Z');
      const gateway = new ControlModelGateway({
        ports: () => ({
          turn: () =>
            Promise.resolve({
              text: 'private-model-text',
              toolCalls: [],
              finishReason: 'stop',
              usage: { inputTokens: measured(11), outputTokens: measured(7) },
            }),
        }),
        candidates: () =>
          runtime.registry.snapshot().map((snapshot) => ({
            ...snapshot,
            state: {
              availability: 'available',
              auth: 'authenticated',
              observedAt: now.toISOString(),
            },
          })),
        policy: runtime.policy,
        clock: () => now,
        newId: randomUUID,
        logger: noopLogger,
        ...(runtime.telemetry === undefined ? {} : { telemetry: runtime.telemetry }),
      });
      const lineage = {
        rootSessionId: 'session',
        turnId: 'turn',
        correlationId: 'correlation',
        depth: 0,
      };
      const decision = gateway.begin(
        'dsh',
        { mode: 'pinned', resourceId: 'selected-model', fallback: 'none' },
        lineage,
      );
      for (let i = 0; i < 2; i++)
        await gateway.turn(
          {
            engine: 'dsh',
            lineage,
            controlDecisionId: decision.controlDecisionId,
            messages: [{ role: 'user', content: 'private-owner-prompt' }],
          },
          new AbortController().signal,
        );
      const path = join(dir, 'accounting.jsonl');
      const raw = await readFile(path, 'utf8');
      const events = raw
        .trim()
        .split('\n')
        .map((line) => JSON.parse(line) as TelemetryEvent);
      expect(events.map((event) => event.type)).toEqual([
        'execution.finished',
        'execution.finished',
      ]);
      expect(raw).not.toContain('private-owner-prompt');
      expect(raw).not.toContain('private-model-text');
      const id = resourceId('selected-model');
      const quota = new TelemetryQuotaSource({
        path,
        allowances: [{ resourceId: id, unit: 'tokens', limit: 100, window: 'daily' }],
      });
      const observations = (await quota.observe([id], now)).get(id);
      expect(observations?.[0]).toMatchObject({ used: 36, remaining: 64 });
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});
