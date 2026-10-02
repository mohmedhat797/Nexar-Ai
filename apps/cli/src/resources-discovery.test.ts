import { chmod, mkdir, mkdtemp, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { runCli } from './cli.js';
import type { CliIo } from './io.js';

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

describe('discovery in the CLI', () => {
  let dir: string;
  let bin: string;
  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'nexar-cli-discovery-'));
    bin = join(dir, 'bin');
    await mkdir(bin);
    // A fake `codex` that leaves a marker if anything runs it: discovery must only stat it.
    const binary = join(bin, process.platform === 'win32' ? 'codex.CMD' : 'codex');
    await writeFile(
      binary,
      process.platform === 'win32'
        ? `@echo off\r\necho ran > "${join(dir, 'RAN')}"\r\nexit /b 1\r\n`
        : `#!/bin/sh\ntouch "${join(dir, 'RAN')}"\nexit 1\n`,
    );
    await chmod(binary, 0o755);
  });
  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  function capture() {
    let out = '';
    let err = '';
    const io: CliIo = {
      stdout: (s) => (out += s),
      stderr: (s) => (err += s),
      // Only the fake bin directory: the host's real CLIs must not leak into the test.
      env: { PATH: bin },
      cwd: dir,
    };
    return { io, out: () => out, err: () => err };
  }

  async function configure(discovery?: unknown): Promise<void> {
    await writeFile(
      join(dir, 'nexar.config.json'),
      JSON.stringify({
        version: 1,
        resources: [echo],
        routing: { policy: 'resource-intelligence', defaultResourceId: 'local-echo' },
        ...(discovery === undefined ? {} : { discovery }),
      }),
    );
  }

  const ran = () =>
    stat(join(dir, 'RAN')).then(
      () => true,
      () => false,
    );

  it('lists discovered resources with provenance and a per-source report', async () => {
    await configure();
    const c = capture();
    expect(await runCli(['resources', '--discovered', '--no-refresh'], c.io)).toBe(0);
    const out = c.out();
    expect(out).toMatch(/local-echo\s+model:nexar\/echo\s+echo\s+configured/);
    expect(out).toMatch(/codex\s+agent:codex\s+codex\s+discovered:cli:codex\s+unknown\s+unknown/);
    expect(out).toMatch(/cli:codex\s+ok\s+1/);
    expect(out).toMatch(/cli:claude-code\s+ok\s+0/);
    expect(out).toMatch(/pi-catalog\s+disabled\s+0/);
    expect(out).toMatch(/local-endpoints\s+disabled\s+0/);
    expect(out).not.toContain(bin);
    expect(await ran()).toBe(false);
  });

  it('includes provenance and reports in --json', async () => {
    await configure();
    const c = capture();
    expect(await runCli(['resources', '--discovered', '--json', '--no-refresh'], c.io)).toBe(0);
    const body = JSON.parse(c.out()) as {
      resources: { id: string; provenance: string }[];
      discovery: { reports: { source: string; status: string }[]; collisions: number };
    };
    expect(body.resources.map((r) => [r.id, r.provenance])).toEqual([
      ['local-echo', 'configured'],
      ['codex', 'discovered:cli:codex'],
    ]);
    expect(body.discovery.reports.map((r) => r.source)).toContain('cli:codex');
    expect(body.discovery.collisions).toBe(0);
  });

  it('keeps the configured descriptor on an id collision and honours excludeIds', async () => {
    await configure({ excludeIds: ['codex'] });
    const c = capture();
    await runCli(['resources', '--discovered', '--json', '--no-refresh'], c.io);
    const body = JSON.parse(c.out()) as { resources: { id: string }[] };
    expect(body.resources.map((r) => r.id)).toEqual(['local-echo']);
  });

  it('does not discover or register anything for routing unless enabled', async () => {
    await configure();
    const plain = capture();
    expect(await runCli(['resources', '--json', '--no-refresh'], plain.io)).toBe(0);
    const rows = JSON.parse(plain.out()) as { id: string; provenance: string }[];
    expect(rows.map((r) => [r.id, r.provenance])).toEqual([['local-echo', 'configured']]);

    const route = capture();
    await runCli(['route', '--kind', 'coding', '--json', 'x'], route.io);
    const decision = JSON.parse(route.out()) as { rejected: { resourceId: string }[] };
    expect(JSON.stringify(decision)).not.toContain('"codex"');
  });

  it('registers discovered resources for routing when discovery is enabled', async () => {
    await configure({ enabled: true });
    const c = capture();
    await runCli(['route', '--kind', 'coding', '--json', '--prefer', 'codex', 'x'], c.io);
    const decision = JSON.parse(c.out()) as {
      selected?: { resourceId: string };
      rejected: { resourceId: string }[];
    };
    const ids = [decision.selected?.resourceId, ...decision.rejected.map((r) => r.resourceId)];
    // Registered, so the adapter probe (not discovery) decides its state before routing.
    expect(ids).toContain('codex');
  });
});
