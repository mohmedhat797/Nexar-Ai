import { mkdtemp, readFile, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { ExecutionRecord, TelemetryEvent } from '@nexar/contracts';
import { createNexar, parseConfig } from '@nexar/core';
import { EchoExecutionAdapter } from '@nexar/integration-echo';

describe('offline execution: config → createNexar → run → JSONL telemetry', () => {
  let dir: string;
  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'nexar-offline-'));
  });
  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it('runs a task end to end and writes telemetry next to the config', async () => {
    const config = parseConfig(
      {
        version: 1,
        resources: [
          {
            id: 'local-echo',
            displayName: 'Local Echo',
            kind: { type: 'model', provider: 'nexar', model: 'echo', access: 'local' },
            capabilities: ['text-generation'],
            runtime: { adapter: 'echo', locality: 'local' },
            auth: { mode: 'none' },
            cost: { model: 'free' },
            dataLocality: 'local',
          },
        ],
        routing: { policy: 'deterministic', defaultResourceId: 'local-echo' },
        telemetry: { jsonlPath: '.nexar/telemetry.jsonl' },
      },
      'integration-test',
    );
    const { nexar } = createNexar(config, {
      adapters: [new EchoExecutionAdapter()],
      configDir: dir,
    });

    const task = nexar.createTask({ kind: 'general', prompt: 'offline please' });
    const { result, record } = await nexar.run(task);
    expect(result.text).toBe('[echo:local-echo] offline please');

    const file = join(dir, '.nexar', 'telemetry.jsonl');
    expect((await stat(file)).mode & 0o777).toBe(0o600);
    const events = (await readFile(file, 'utf8'))
      .trimEnd()
      .split('\n')
      .map((line) => JSON.parse(line) as TelemetryEvent);
    expect(events.map((e) => e.type)).toEqual([
      'route.decided',
      'execution.started',
      'execution.finished',
    ]);
    const finished = events[2] as Extract<TelemetryEvent, { type: 'execution.finished' }>;
    const persisted: ExecutionRecord = finished.record;
    expect(persisted).toEqual(JSON.parse(JSON.stringify(record)));
    expect(persisted).toMatchObject({
      taskId: task.id,
      resourceId: 'local-echo',
      adapter: 'echo',
      outcome: 'succeeded',
    });
    expect(persisted.usage.costUsd).toEqual({ status: 'measured', value: 0 });
  });
});
