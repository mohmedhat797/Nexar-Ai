import { describe, expect, it } from 'vitest';
import {
  checkSandboxAvailability,
  type SandboxAvailability,
  type SelfTestResult,
} from '@nexar/sandbox';
import type { CliSeams } from './args.js';
import { runCli } from './cli.js';
import type { CliIo } from './io.js';

function capture() {
  let out = '';
  let err = '';
  const io: CliIo = {
    stdout: (s) => (out += s),
    stderr: (s) => (err += s),
    env: { PATH: process.env['PATH'] ?? '' },
    cwd: process.cwd(),
  };
  return { io, out: () => out, err: () => err };
}

const available: SandboxAvailability = {
  available: true,
  bwrapPath: '/usr/bin/bwrap',
  bwrapVersion: '0.9.0',
  socatPath: '/usr/bin/socat',
  detail: 'bubblewrap 0.9.0 works',
};

function seams(
  availability: SandboxAvailability,
  results: readonly SelfTestResult[] = [],
): CliSeams {
  return {
    sandbox: {
      availability: () => Promise.resolve(availability),
      runSelfTest: () => Promise.resolve([...results]),
    },
  };
}

const passing: SelfTestResult[] = [
  { name: 'workspace is writable at /work', passed: true, detail: 'ok' },
  { name: 'root filesystem is read-only', passed: true, detail: 'ok' },
];

describe('nexar sandbox selftest', () => {
  it('prints each check and exits 0 when all pass', async () => {
    const c = capture();
    expect(await runCli(['sandbox', 'selftest'], c.io, seams(available, passing))).toBe(0);
    expect(c.out()).toContain('✔ sandbox: bubblewrap 0.9.0 works');
    expect(c.out()).toContain('✔ workspace is writable at /work');
    expect(c.out()).toContain('✔ root filesystem is read-only');
  });

  it('exits 1 and shows the detail of a failed check', async () => {
    const c = capture();
    const results = [
      ...passing,
      { name: 'only loopback network interface exists', passed: false, detail: 'exit 0: eth0' },
    ];
    expect(await runCli(['sandbox', 'selftest'], c.io, seams(available, results))).toBe(1);
    expect(c.out()).toContain('✖ only loopback network interface exists: exit 0: eth0');
  });

  it('exits 7 when bubblewrap is unavailable, without running any check', async () => {
    const c = capture();
    const unavailable: SandboxAvailability = {
      available: false,
      detail: 'bubblewrap (bwrap) was not found',
    };
    const run = seams(unavailable);
    const code = await runCli(['sandbox', 'selftest'], c.io, {
      sandbox: { ...run.sandbox, runSelfTest: () => Promise.reject(new Error('must not run')) },
    });
    expect(code).toBe(7);
    expect(c.out()).toContain('unavailable — bubblewrap (bwrap) was not found');
  });

  it('--json reports the checks', async () => {
    const c = capture();
    expect(await runCli(['sandbox', 'selftest', '--json'], c.io, seams(available, passing))).toBe(
      0,
    );
    expect(JSON.parse(c.out())).toEqual({
      ok: true,
      available: true,
      detail: available.detail,
      checks: passing,
    });

    const u = capture();
    const unavailable: SandboxAvailability = { available: false, detail: 'bwrap --version failed' };
    expect(await runCli(['sandbox', 'selftest', '--json'], u.io, seams(unavailable))).toBe(7);
    expect(JSON.parse(u.out())).toEqual({
      ok: false,
      available: false,
      detail: 'bwrap --version failed',
      checks: [],
    });
  });

  it('does not count an empty result list as a pass', async () => {
    const c = capture();
    expect(await runCli(['sandbox', 'selftest'], c.io, seams(available, []))).toBe(1);
  });
});

const real = await checkSandboxAvailability();

describe.skipIf(!real.available)('nexar sandbox selftest (real bubblewrap)', () => {
  it('passes every isolation check', async () => {
    const c = capture();
    const code = await runCli(['sandbox', 'selftest', '--json'], c.io);
    const report = JSON.parse(c.out()) as { ok: boolean; checks: SelfTestResult[] };
    expect(report.checks.filter((check) => !check.passed)).toEqual([]);
    expect(report.ok).toBe(true);
    expect(code).toBe(0);
  }, 120_000);
});
