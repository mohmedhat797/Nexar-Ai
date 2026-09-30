import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { runCli } from './cli.js';
import type { CliIo } from './io.js';

interface Captured {
  readonly io: CliIo;
  readonly out: () => string;
  readonly err: () => string;
}

function capture(cwd: string, stdin?: string): Captured {
  let out = '';
  let err = '';
  const io: CliIo = {
    stdout: (s) => (out += s),
    stderr: (s) => (err += s),
    env: { PATH: process.env['PATH'] ?? '' },
    cwd,
    ...(stdin === undefined ? {} : { stdin: () => Promise.resolve(stdin) }),
  };
  return { io, out: () => out, err: () => err };
}

describe('nexar cli (in-process, offline)', () => {
  let dir: string;
  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'nexar-cli-'));
  });
  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it('prints help and exits 0', async () => {
    const c = capture(dir);
    expect(await runCli(['--help'], c.io)).toBe(0);
    expect(c.out()).toContain('Usage: nexar');
    expect(c.out()).toContain('resources');
  });

  it('prints command help', async () => {
    const c = capture(dir);
    expect(await runCli(['run', '-h'], c.io)).toBe(0);
    expect(c.out()).toContain('--timeout');
  });

  it('prints the version', async () => {
    const c = capture(dir);
    expect(await runCli(['--version'], c.io)).toBe(0);
    expect(c.out()).toBe('0.1.0\n');
  });

  it('rejects an unknown command with usage on stderr and exit 2', async () => {
    const c = capture(dir);
    expect(await runCli(['frobnicate'], c.io)).toBe(2);
    expect(c.err()).toContain('unknown command "frobnicate"');
    expect(c.err()).toContain('Usage: nexar');
    expect(c.out()).toBe('');
  });

  it('rejects an unknown option and a missing command with exit 2', async () => {
    const a = capture(dir);
    expect(await runCli(['resources', '--bogus'], a.io)).toBe(2);
    const b = capture(dir);
    expect(await runCli([], b.io)).toBe(2);
    expect(b.err()).toContain('a command is required');
  });

  it('rejects an invalid log level with exit 2', async () => {
    const c = capture(dir);
    expect(await runCli(['--log-level', 'loud', 'resources'], c.io)).toBe(2);
  });

  it('lists local-echo with the default config', async () => {
    const c = capture(dir);
    expect(await runCli(['resources'], c.io)).toBe(0);
    expect(c.out()).toContain('local-echo');
    expect(c.out()).toContain('model:nexar/echo');
    expect(c.out()).toContain('available');
  });

  it('lists resources as JSON without refreshing', async () => {
    const c = capture(dir);
    expect(await runCli(['resources', '--json', '--no-refresh'], c.io)).toBe(0);
    const rows = JSON.parse(c.out()) as { id: string; availability: string }[];
    expect(rows.map((r) => r.id)).toEqual(['local-echo']);
    expect(rows[0]?.availability).toBe('unknown');
  });

  it('routes a general task to local-echo', async () => {
    const c = capture(dir);
    expect(await runCli(['route', '--kind', 'general', 'hi'], c.io)).toBe(0);
    expect(c.out()).toContain('Selected resource: local-echo');
  });

  it('exits 3 when no resource is eligible', async () => {
    const c = capture(dir);
    const code = await runCli(
      ['route', '--kind', 'general', '--capability', 'teleportation', 'hi'],
      c.io,
    );
    expect(code).toBe(3);
    expect(c.out()).toContain('No eligible resource');
  });

  it('requires --kind and a prompt', async () => {
    const a = capture(dir);
    expect(await runCli(['route', 'hi'], a.io)).toBe(2);
    const b = capture(dir);
    expect(await runCli(['route', '--kind', 'general'], b.io)).toBe(2);
  });

  it('runs a task: result on stdout, summary on stderr, telemetry under cwd', async () => {
    const c = capture(dir);
    expect(await runCli(['run', '--kind', 'general', 'hello'], c.io)).toBe(0);
    expect(c.out()).toBe('[echo:local-echo] hello\n');
    expect(c.err()).toContain('Selected resource: local-echo');
    expect(c.err()).toContain('[event] echoing prompt');
    expect(c.err()).toMatch(
      /resource=local-echo model=echo outcome=succeeded latency=\d+ms tokens=~\d+ \(estimated\)\/~\d+ \(estimated\) cost=0\n/,
    );
    const lines = (await readFile(join(dir, '.nexar', 'telemetry.jsonl'), 'utf8'))
      .trim()
      .split('\n')
      .map((l) => JSON.parse(l) as { type: string });
    expect(lines.map((l) => l.type)).toEqual([
      'route.decided',
      'execution.started',
      'execution.finished',
    ]);
  });

  it('--quiet suppresses the explanation and event lines', async () => {
    const c = capture(dir);
    expect(await runCli(['run', '--quiet', '--kind', 'general', 'hello'], c.io)).toBe(0);
    expect(c.err()).not.toContain('Selected resource');
    expect(c.err()).not.toContain('[event]');
    expect(c.err()).toContain('resource=local-echo');
  });

  it('run --json prints a parseable document', async () => {
    const c = capture(dir);
    expect(await runCli(['run', '--json', '--kind', 'general', 'hello'], c.io)).toBe(0);
    const doc = JSON.parse(c.out()) as {
      decision: { outcome: string };
      result: { text: string; usage: unknown; resolved: { model: string } };
      record: { outcome: string };
    };
    expect(doc.decision.outcome).toBe('selected');
    expect(doc.result.text).toBe('[echo:local-echo] hello');
    expect(doc.result.resolved.model).toBe('echo');
    expect(doc.record.outcome).toBe('succeeded');
  });

  it('reads the prompt from stdin when it is "-"', async () => {
    const c = capture(dir, 'from stdin\n');
    expect(await runCli(['run', '--kind', 'general', '-'], c.io)).toBe(0);
    expect(c.out()).toBe('[echo:local-echo] from stdin\n');
  });

  it('exits 3 from run when nothing is eligible', async () => {
    const c = capture(dir);
    const code = await runCli(
      ['run', '--kind', 'general', '--capability', 'teleportation', 'hi'],
      c.io,
    );
    expect(code).toBe(3);
    expect(c.err()).toContain('error [NO_ELIGIBLE_RESOURCE]');
    expect(c.out()).toBe('');
  });

  it('rejects a bad --timeout with exit 2', async () => {
    const c = capture(dir);
    expect(await runCli(['run', '--timeout', 'soon', '--kind', 'general', 'hi'], c.io)).toBe(2);
  });

  it('reports an unreadable config as exit 1', async () => {
    const c = capture(dir);
    const code = await runCli(['--config', join(dir, 'missing.json'), 'resources'], c.io);
    expect(code).toBe(1);
    expect(c.err()).toContain('error [CONFIGURATION_ERROR]');
  });

  it('doctor --json reports a structured report', async () => {
    const c = capture(dir);
    const code = await runCli(['doctor', '--json'], c.io);
    const report = JSON.parse(c.out()) as {
      ok: boolean;
      sections: { id: string; checks: { status: string; name: string }[] }[];
    };
    expect(report.sections.map((s) => s.id)).toEqual([
      'runtime',
      'config',
      'resources',
      'external',
    ]);
    expect(code).toBe(report.ok ? 0 : 1);
    const resources = report.sections.find((s) => s.id === 'resources');
    expect(resources?.checks.map((x) => x.name)).toEqual(['local-echo']);
    const external = report.sections.find((s) => s.id === 'external');
    expect(external?.checks.map((x) => x.name)).toEqual([
      'claude',
      'dsh',
      'codex',
      'agy',
      'openworker-server',
    ]);
  });

  it('doctor prints markers, and fails on an invalid config', async () => {
    const good = capture(dir);
    await runCli(['doctor'], good.io);
    expect(good.out()).toContain('Runtime');
    expect(good.out()).toContain('✔ local-echo');

    const bad = capture(dir);
    const code = await runCli(['--config', join(dir, 'missing.json'), 'doctor'], bad.io);
    expect(code).toBe(1);
    expect(bad.out()).toContain('✖ config');
  });
});
