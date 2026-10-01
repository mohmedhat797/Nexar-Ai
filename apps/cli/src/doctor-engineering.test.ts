import { describe, expect, it } from 'vitest';
import type { SandboxAvailability } from '@nexar/sandbox';
import type { CliSeams, VersionProbe } from './args.js';
import { runCli } from './cli.js';
import type { CliIo } from './io.js';

interface Check {
  status: string;
  name: string;
  detail: string;
}

const available: SandboxAvailability = {
  available: true,
  bwrapPath: '/usr/bin/bwrap',
  bwrapVersion: '0.9.0',
  socatPath: '/usr/bin/socat',
  detail: 'bubblewrap 0.9.0 works',
};

const HARDENED = [
  '[boot]',
  'systemd=true',
  '[automount]',
  'enabled=false',
  'mountFsTab=false',
  '[interop]',
  'enabled=false',
  'appendWindowsPath=false',
  '[user]',
  'default=nexar',
].join('\n');

/** Runs `nexar doctor --json` with every outside-world probe stubbed. */
async function doctor(options: {
  files?: Record<string, string>;
  availability?: SandboxAvailability;
  versions?: Record<string, string>;
}): Promise<{ checks: Check[]; reads: string[]; ok: boolean }> {
  const reads: string[] = [];
  const probes: string[][] = [];
  const doctorSeams: CliSeams['doctor'] = {
    availability: () => Promise.resolve(options.availability ?? available),
    readText: (path) => {
      reads.push(path);
      return Promise.resolve(options.files?.[path]);
    },
    versionOf: (command, args = ['--version']): Promise<VersionProbe> => {
      probes.push([command, ...args]);
      const output = { git: 'git version 2.43.0', ...options.versions }[command];
      return Promise.resolve(output === undefined ? { found: false } : { found: true, output });
    },
  };
  let out = '';
  const io: CliIo = {
    stdout: (s) => (out += s),
    stderr: () => undefined,
    env: { PATH: process.env['PATH'] ?? '' },
    cwd: process.cwd(),
  };
  await runCli(['doctor', '--json'], io, { doctor: doctorSeams });
  const report = JSON.parse(out) as { ok: boolean; sections: { id: string; checks: Check[] }[] };
  const section = report.sections.find((s) => s.id === 'engineering');
  expect(section).toBeDefined();
  // Presence/version probes only: `--version`, and `-V` for socat.
  for (const probe of probes) expect([['--version'], ['-V']]).toContainEqual(probe.slice(1));
  return { checks: section?.checks ?? [], reads, ok: report.ok };
}

const byName = (checks: Check[], name: string): Check | undefined =>
  checks.find((c) => c.name === name);

describe('nexar doctor: engineering plane', () => {
  it('reports bwrap and socat with versions, and skips the WSL checks outside WSL', async () => {
    const { checks, reads } = await doctor({
      files: {
        '/proc/version': 'Linux version 6.8.0 (buildd@lcy02) #1 SMP',
        '/proc/sys/kernel/apparmor_restrict_unprivileged_userns': '0\n',
      },
      versions: { socat: 'socat version 1.8.0.0 on 03 Jul 2026' },
    });
    expect(byName(checks, 'bwrap')).toMatchObject({ status: 'ok' });
    expect(byName(checks, 'bwrap')?.detail).toContain('0.9.0');
    expect(byName(checks, 'socat')).toEqual({
      status: 'ok',
      name: 'socat',
      detail: 'socat version 1.8.0.0',
    });
    expect(byName(checks, 'kernel.apparmor_restrict_unprivileged_userns')).toMatchObject({
      status: 'info',
      detail: '0',
    });
    expect(checks.some((c) => c.name.startsWith('wsl.conf'))).toBe(false);
    expect(reads).not.toContain('/etc/wsl.conf');
  });

  it('warns when bwrap is unavailable, socat is missing or AppArmor restricts user namespaces', async () => {
    const { checks, ok } = await doctor({
      availability: { available: false, detail: 'bubblewrap (bwrap) was not found' },
      files: { '/proc/sys/kernel/apparmor_restrict_unprivileged_userns': '1' },
    });
    expect(byName(checks, 'bwrap')).toMatchObject({ status: 'warn' });
    expect(byName(checks, 'bwrap')?.detail).toContain('was not found');
    expect(byName(checks, 'socat')).toMatchObject({ status: 'warn' });
    expect(byName(checks, 'kernel.apparmor_restrict_unprivileged_userns')).toMatchObject({
      status: 'warn',
    });
    // The engineering plane is optional: its warnings never fail doctor.
    expect(ok).toBe(true);
  });

  it('omits the AppArmor check when the sysctl file does not exist', async () => {
    const { checks } = await doctor({});
    expect(byName(checks, 'kernel.apparmor_restrict_unprivileged_userns')).toBeUndefined();
  });

  it('accepts a hardened wsl.conf under WSL', async () => {
    const { checks } = await doctor({
      files: {
        '/proc/version': 'Linux version 5.15.0-microsoft-standard-WSL2',
        '/etc/wsl.conf': HARDENED,
      },
    });
    const wsl = checks.filter((c) => c.name.startsWith('wsl.conf'));
    expect(wsl.map((c) => c.name)).toEqual([
      'wsl.conf automount.enabled',
      'wsl.conf interop.enabled',
      'wsl.conf interop.appendwindowspath',
      'wsl.conf boot.systemd',
    ]);
    expect(wsl.every((c) => c.status === 'ok')).toBe(true);
  });

  it('warns on every drift from ADR-018', async () => {
    const drifted = ['[automount]', 'enabled=true', '[interop]', 'appendWindowsPath=true'].join(
      '\n',
    );
    const { checks } = await doctor({
      files: {
        '/proc/version': 'Linux version 5.15.0-Microsoft-standard-WSL2',
        '/etc/wsl.conf': drifted,
      },
    });
    const wsl = checks.filter((c) => c.name.startsWith('wsl.conf'));
    expect(wsl.map((c) => c.status)).toEqual(['warn', 'warn', 'warn', 'warn']);
    expect(byName(checks, 'wsl.conf automount.enabled')?.detail).toBe(
      'true (ADR-018 requires false)',
    );
    expect(byName(checks, 'wsl.conf interop.enabled')?.detail).toBe(
      'unset (ADR-018 requires false)',
    );
    expect(byName(checks, 'wsl.conf boot.systemd')?.detail).toBe('unset (ADR-018 requires true)');
  });

  it('warns when wsl.conf is missing under WSL', async () => {
    const { checks } = await doctor({
      files: { '/proc/version': 'Linux version 5.15.0-microsoft-standard-WSL2' },
    });
    expect(byName(checks, 'wsl.conf')).toMatchObject({ status: 'warn' });
  });

  it('checks the codex and agy CLIs by --version presence only', async () => {
    let out = '';
    const asked: string[][] = [];
    await runCli(
      ['doctor', '--json'],
      { stdout: (s) => (out += s), stderr: () => undefined, env: { PATH: '' }, cwd: process.cwd() },
      {
        doctor: {
          availability: () => Promise.resolve(available),
          readText: () => Promise.resolve(undefined),
          versionOf: (command, args = ['--version']) => {
            asked.push([command, ...args]);
            return Promise.resolve(
              command === 'codex' ? { found: true, output: 'codex-cli 0.9.1' } : { found: false },
            );
          },
        },
      },
    );
    const external = (
      JSON.parse(out) as { sections: { id: string; checks: Check[] }[] }
    ).sections.find((s) => s.id === 'external');
    expect(byName(external?.checks ?? [], 'codex')).toEqual({
      status: 'ok',
      name: 'codex',
      detail: 'codex-cli 0.9.1',
    });
    expect(byName(external?.checks ?? [], 'agy')).toEqual({
      status: 'warn',
      name: 'agy',
      detail: 'not found',
    });
    expect(asked).toContainEqual(['codex', '--version']);
    expect(asked).toContainEqual(['agy', '--version']);
    expect(JSON.stringify(external)).not.toContain('not integrated in v0.1 (found');
  });
});
