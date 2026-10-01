import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { runCli } from './cli.js';
import type { CliIo } from './io.js';

function capture(cwd: string) {
  let out = '';
  let err = '';
  const io: CliIo = {
    stdout: (s) => (out += s),
    stderr: (s) => (err += s),
    env: { PATH: process.env['PATH'] ?? '' },
    cwd,
  };
  return { io, out: () => out, err: () => err };
}

const echo = {
  id: 'local-echo',
  displayName: 'Local Echo',
  kind: { type: 'model', provider: 'nexar', model: 'echo', access: 'local' },
  capabilities: ['text-generation', 'reasoning', 'knowledge-work', 'coding'],
  runtime: { adapter: 'echo', locality: 'local' },
  auth: { mode: 'none' },
  cost: { model: 'free' },
  dataLocality: 'local',
};

const run = (startedAt: string): unknown => ({
  type: 'execution.finished',
  at: startedAt,
  record: {
    schemaVersion: 1,
    taskId: 't',
    taskKind: 'general',
    resourceId: 'local-echo',
    outcome: 'succeeded',
    startedAt,
    endedAt: startedAt,
    latencyMs: 1,
    usage: {},
  },
});

describe('nexar resources: quota column', () => {
  let dir: string;
  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'nexar-cli-quota-'));
  });
  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  async function configure(opts: {
    telemetry?: boolean;
    allowances?: unknown[];
    events?: unknown[];
  }): Promise<void> {
    await writeFile(
      join(dir, 'nexar.config.json'),
      JSON.stringify({
        version: 1,
        resources: [echo],
        routing: {
          policy: 'deterministic',
          defaultResourceId: 'local-echo',
          ...(opts.allowances === undefined
            ? {}
            : { resourceIntelligence: { allowances: opts.allowances } }),
        },
        ...(opts.telemetry === true ? { telemetry: { jsonlPath: 'telemetry.jsonl' } } : {}),
      }),
    );
    if (opts.events !== undefined) {
      await writeFile(
        join(dir, 'telemetry.jsonl'),
        opts.events.map((e) => JSON.stringify(e)).join('\n') + '\n',
      );
    }
  }

  const monthly = {
    resourceId: 'local-echo',
    unit: 'requests',
    limit: 4,
    window: 'monthly',
    label: 'SECRET-LABEL',
  };

  it('shows unknown when nothing is declared or observed', async () => {
    await configure({});
    const c = capture(dir);
    expect(await runCli(['resources', '--no-refresh'], c.io)).toBe(0);
    const lines = c.out().split('\n');
    expect(lines[0]).toMatch(/AUTH\s+QUOTA\s+CAPABILITIES/);
    expect(lines[1]).toMatch(/\sunknown\s+unknown\s/);
  });

  it('does not invent zero usage when no telemetry file is configured', async () => {
    await configure({ allowances: [monthly] });
    const c = capture(dir);
    expect(await runCli(['resources', '--json', '--no-refresh'], c.io)).toBe(0);
    const [row] = JSON.parse(c.out()) as { quota: { freshness: string } }[];
    expect(row?.quota.freshness).toBe('unknown');
  });

  it('shows declared allowance headroom, reset and sources', async () => {
    const now = new Date().toISOString();
    await configure({ telemetry: true, allowances: [monthly], events: [run(now)] });
    const c = capture(dir);
    expect(await runCli(['resources', '--no-refresh'], c.io)).toBe(0);
    expect(c.out()).toMatch(
      /75% left · resets \d{4}-\d{2}-01T00:00Z · nexar-accounting\+owner-declared/,
    );
    expect(c.out()).not.toContain('SECRET-LABEL');
  });

  it('shows exhausted until the reset time', async () => {
    const now = new Date();
    const resetsAt = new Date(now.getTime() + 3 * 3600_000);
    await configure({
      telemetry: true,
      events: [
        {
          type: 'quota.observed',
          at: now.toISOString(),
          resourceId: 'local-echo',
          observation: {
            unit: 'percent',
            limit: 100,
            used: 100,
            remaining: 0,
            resetsAt: resetsAt.toISOString(),
            observedAt: now.toISOString(),
            provenance: { limit: 'vendor-reported', usage: 'vendor-reported' },
            label: 'exhausted-signal',
          },
        },
      ],
    });
    const c = capture(dir);
    expect(await runCli(['resources', '--no-refresh'], c.io)).toBe(0);
    const expected = resetsAt.toISOString().replace(/:\d{2}\.\d{3}Z$/, 'Z');
    expect(c.out()).toContain(`exhausted until ${expected}`);
  });

  it('includes the assessment in --json', async () => {
    const now = new Date().toISOString();
    await configure({
      telemetry: true,
      allowances: [monthly],
      events: [run(now), run(now), run(now), run(now)],
    });
    const c = capture(dir);
    expect(await runCli(['resources', '--json', '--no-refresh'], c.io)).toBe(0);
    const [row] = JSON.parse(c.out()) as {
      id: string;
      quota: { freshness: string; headroom: number; sources: string[]; resetsAt?: string };
    }[];
    expect(row?.id).toBe('local-echo');
    expect(row?.quota).toMatchObject({
      freshness: 'exhausted',
      headroom: 0,
      sources: ['nexar-accounting+owner-declared'],
    });
    expect(row?.quota.resetsAt).toBeDefined();
    expect(c.out()).not.toContain('SECRET-LABEL');
  });
});
