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

const echo = (id: string, overrides: object = {}) => ({
  id,
  displayName: id,
  kind: { type: 'model', provider: 'nexar', model: 'echo', access: 'local' },
  capabilities: ['text-generation', 'reasoning', 'knowledge-work', 'coding'],
  runtime: { adapter: 'echo', locality: 'local' },
  auth: { mode: 'none' },
  cost: { model: 'free' },
  dataLocality: 'local',
  ...overrides,
});

describe('nexar route --explain', () => {
  let dir: string;
  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'nexar-cli-explain-'));
  });
  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  async function configure(policy: 'deterministic' | 'resource-intelligence'): Promise<void> {
    await writeFile(
      join(dir, 'nexar.config.json'),
      JSON.stringify({
        version: 1,
        resources: [
          echo('local-echo'),
          echo('per-token-echo', {
            cost: {
              model: 'per-token',
              currency: 'USD',
              inputPerMillionTokens: 1000,
              outputPerMillionTokens: 1000,
            },
          }),
        ],
        routing: { policy, defaultResourceId: 'local-echo' },
        telemetry: { jsonlPath: 'telemetry.jsonl' },
      }),
    );
  }

  it('prints the full breakdown for every candidate with resource-intelligence@1', async () => {
    await configure('resource-intelligence');
    const c = capture(dir);
    const code = await runCli(
      ['route', '--kind', 'general', '--explain', '--max-cost', '0.01', 'TOP SECRET PROMPT'],
      c.io,
    );
    const out = c.out();
    expect(code).toBe(0);
    expect(out).toMatch(/^Policy: resource-intelligence@1 \(config [0-9a-f]{12}\)/);
    expect(out).toMatch(/Facts: estimated input tokens \d+, requested output tokens default/);
    expect(out).toContain('History: window');
    expect(out).toContain('Selected resource: local-echo');
    expect(out).toMatch(/1\. local-echo: eligible, tier 1, score [\d.]+/);
    expect(out).toMatch(/quota [\d.]+ × 0\.2 = [\d.]+ \(neutral: /);
    expect(out).toMatch(/success 0\.5 × 0\.2 = 0\.1 \(neutral: cold-start 0<5\)/);
    expect(out).toContain('cost: free, $0.000000');
    // The per-token resource would exceed the 1-cent limit.
    expect(out).toMatch(/- per-token-echo: rejected/);
    expect(out).toContain('cost.exceeds-limit');
    expect(out).not.toContain('TOP SECRET');
  });

  it('works with deterministic@1 and keeps the concise output without --explain', async () => {
    await configure('deterministic');
    const detailed = capture(dir);
    expect(await runCli(['route', '--kind', 'general', '--explain', 'hello'], detailed.io)).toBe(0);
    expect(detailed.out()).toMatch(/^Policy: deterministic@1\n/);
    expect(detailed.out()).toContain('Candidates:');

    const concise = capture(dir);
    expect(await runCli(['route', '--kind', 'general', 'hello'], concise.io)).toBe(0);
    expect(concise.out()).toMatch(/^Selected resource: local-echo/);
    expect(concise.out()).not.toContain('Candidates:');
  });
});

describe('route task budget options', () => {
  let dir: string;
  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'nexar-cli-budget-'));
    await writeFile(
      join(dir, 'nexar.config.json'),
      JSON.stringify({
        version: 1,
        resources: [echo('local-echo', { cost: { model: 'unknown' } })],
        routing: { policy: 'resource-intelligence', defaultResourceId: 'local-echo' },
      }),
    );
  });
  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it('rejects an invalid --max-cost', async () => {
    const c = capture(dir);
    expect(await runCli(['route', '--kind', 'general', '--max-cost', '-1', 'x'], c.io)).toBe(2);
    expect(c.err()).toContain('--max-cost');
  });

  it('fails closed on unknown cost under a strict limit and unknown quota when required', async () => {
    const cost = capture(dir);
    await runCli(['route', '--kind', 'general', '--json', '--max-cost', '0.5', 'x'], cost.io);
    const d1 = JSON.parse(cost.out()) as {
      outcome: string;
      rejected: { reasons: { code: string }[] }[];
    };
    expect(d1.outcome).toBe('no-eligible-resource');
    expect(d1.rejected[0]?.reasons.map((r) => r.code)).toContain('cost.not-estimable');

    const quota = capture(dir);
    await runCli(['route', '--kind', 'general', '--json', '--require-known-quota', 'x'], quota.io);
    const d2 = JSON.parse(quota.out()) as {
      outcome: string;
      rejected: { reasons: { code: string }[] }[];
    };
    expect(d2.outcome).toBe('no-eligible-resource');
    expect(d2.rejected[0]?.reasons.map((r) => r.code)).toContain('quota.unknown-strict');
  });
});
