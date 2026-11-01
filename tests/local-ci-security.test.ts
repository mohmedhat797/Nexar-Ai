import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  getGitInfo,
  getNodeInfo,
  isSupportedNode,
  readPinnedNodeVersion,
} from '../scripts/local-ci/platform.mjs';
import { normalizeWindowsEnv, spawnSubprocess } from '../scripts/local-ci/process-util.mjs';
import { runPreflight } from '../scripts/local-ci/preflight.mjs';
import type { PlatformInfo } from '../scripts/local-ci/platform.mjs';
import {
  aggregateCrossPlatformEvidence,
  EXPECTED_STAGES,
  generateReports,
  sourceIdentityMatches,
} from '../scripts/local-ci/report.mjs';
import type { RunData } from '../scripts/local-ci/report.mjs';
import { executeStage, getStages, parseVitestJsonStats } from '../scripts/local-ci/stages.mjs';

describe('Local CI acceptance security regressions', () => {
  it('accounts for nested pending assertions omitted by the runner summary', () => {
    const report = {
      numTotalTests: 5,
      numPassedTestSuites: 1,
      numFailedTestSuites: 0,
      numTotalTestSuites: 1,
      testResults: [
        {
          assertionResults: ['passed', 'skipped', 'pending', 'todo', 'failed'].map((status) => ({
            status,
          })),
        },
      ],
    };
    expect(parseVitestJsonStats(report)).toMatchObject({
      testsTotal: 5,
      testsPassed: 1,
      testsSkipped: 1,
      testsPending: 1,
      testsTodo: 1,
      testsFailed: 1,
      testsUnclassified: 0,
    });
    expect(() => parseVitestJsonStats({ ...report, numTotalTests: 6 })).toThrow('reconcile');
  });

  it('preserves the selected PATH without case aliases on Windows', () => {
    expect(normalizeWindowsEnv({ Path: 'inherited', PATH: 'selected', HOME: 'fixture' })).toEqual({
      PATH: 'selected',
      HOME: 'fixture',
    });
  });

  it('requires the exact patch and rejects other majors, older patches and prereleases', () => {
    expect(isSupportedNode('v22.18.0')).toBe(false);
    expect(isSupportedNode('v22.19.0')).toBe(false);
    expect(isSupportedNode('v22.23.3')).toBe(false);
    expect(isSupportedNode('v24.15.0')).toBe(false);
    expect(isSupportedNode('v24.22.1')).toBe(false);
    expect(isSupportedNode('v24.22.2')).toBe(true);
    expect(isSupportedNode('v24.22.3')).toBe(false);
    expect(isSupportedNode('v24.22.2-rc.1')).toBe(false);
    expect(isSupportedNode('v26.13.0')).toBe(false);
  });

  it('refuses an invalid explicit executable instead of falling back to the running Node', () => {
    const info = getNodeInfo(join(tmpdir(), 'nexar-missing-node-executable'));
    expect(info.source).toBe('custom');
    expect(info.isMatched).toBe(false);
    expect(info.activeVersion).toBe('unavailable');
    expect(info.activeExec).not.toBe(process.execPath);
  });

  it('probes a real explicit executable and passes its selected PATH to a child', async () => {
    const info = getNodeInfo(process.execPath);
    expect(info.activeVersion).toBe(process.version);
    expect(info.isMatched).toBe(isSupportedNode(process.version));
    const stages = getStages('quick', {
      repoRoot: process.cwd(),
      os: { platform: process.platform },
      node: info,
      gitleaks: {},
    } as unknown as PlatformInfo);
    const env = stages[0]?.env;
    if (!env) throw new Error('Expected stage environment');
    const child = await spawnSubprocess(
      'node',
      ['-p', 'JSON.stringify({version:process.version,exec:process.execPath})'],
      {
        env,
        timeoutMs: 10_000,
      },
    );
    expect(child.exitCode).toBe(0);
    const observed = JSON.parse(child.stdout) as { version: string; exec: string };
    expect(observed.version).toBe(process.version);
    expect(observed.exec.toLowerCase()).toBe(process.execPath.toLowerCase());
  });

  it('rejects floating or malformed version authorities', () => {
    const dir = mkdtempSync(join(tmpdir(), 'nexar-node-pin-'));
    try {
      for (const value of ['24', 'latest', '24.22', '24.22.2\n26.13.0', '24.22.2-rc.1']) {
        writeFileSync(join(dir, '.nvmrc'), value);
        expect(() => readPinnedNodeVersion(dir)).toThrow('exact Node.js release');
      }
      writeFileSync(join(dir, '.nvmrc'), '24.22.2\n');
      expect(readPinnedNodeVersion(dir)).toBe('24.22.2');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('refuses stale, changed, or unavailable source identities', () => {
    const clean = {
      commit: 'a'.repeat(40),
      branch: 'fixture',
      isDirty: false,
      dirtyFingerprint: null,
      summary: 'fixture',
    };
    const dirty = { ...clean, isDirty: true, dirtyFingerprint: 'b'.repeat(64) };
    expect(sourceIdentityMatches(clean, clean)).toBe(true);
    expect(sourceIdentityMatches(clean, { ...clean, commit: 'c'.repeat(40) })).toBe(false);
    expect(sourceIdentityMatches(clean, dirty)).toBe(false);
    expect(
      sourceIdentityMatches({ ...clean, tree: 'a'.repeat(40) }, { ...clean, tree: 'b'.repeat(40) }),
    ).toBe(false);
    expect(sourceIdentityMatches(dirty, { ...dirty, dirtyFingerprint: 'd'.repeat(64) })).toBe(
      false,
    );
    expect(
      sourceIdentityMatches({ ...clean, commit: 'unknown' }, { ...clean, commit: 'unknown' }),
    ).toBe(false);
  });

  it('cannot report PASS after preflight failure, interruption, or source changes', () => {
    const dir = mkdtempSync(join(tmpdir(), 'nexar-report-security-'));
    const git = {
      commit: 'a'.repeat(40),
      branch: 'fixture',
      isDirty: false,
      dirtyFingerprint: null,
      summary: 'fixture',
    };
    const data = {
      mode: 'quick',
      profile: 'auto',
      sourceEnd: git,
      platformInfo: {
        repoRoot: dir,
        git,
        os: { platform: 'win32' },
        node: { activeVersion: 'v24.22.2', pinnedMajor: '24', pinnedVersion: '24.22.2' },
        pnpm: {},
        dsh: {},
        gitleaks: {},
      },
      preflightResult: { ok: true, checks: [], diagnostics: [] },
      stageResults: EXPECTED_STAGES.quick.map((id) => ({
        id,
        name: id,
        status: 'PASS',
        required: true,
        durationMs: 0,
        vitestStats: null,
      })),
      startTime: Date.now(),
      endTime: Date.now(),
      durationMs: 0,
    } as unknown as RunData;
    try {
      expect(generateReports(data).finalStatus).toBe('LOCAL_CI_QUICK_PASS');
      expect(
        generateReports({ ...data, preflightResult: { ...data.preflightResult, ok: false } })
          .finalStatus,
      ).toBe('LOCAL_CI_QUICK_FAIL');
      expect(generateReports({ ...data, interrupted: true }).finalStatus).toBe(
        'LOCAL_CI_QUICK_FAIL',
      );
      expect(
        generateReports({ ...data, sourceEnd: { ...git, commit: 'b'.repeat(40) } }).finalStatus,
      ).toBe('LOCAL_CI_QUICK_FAIL');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('does not let a custom stage override cancellation or signal failure', async () => {
    const res = await executeStage(
      {
        id: 'synthetic-cancelled',
        name: 'fixture',
        required: true,
        customRun: () =>
          Promise.resolve({
            command: 'fixture',
            exitCode: 0,
            signal: 'SIGTERM',
            durationMs: 0,
            timedOut: false,
            aborted: true,
            stdout: '',
            stderr: '',
            error: null,
            statusOverride: 'PASS',
          }),
      },
      { repoRoot: process.cwd() },
    );
    expect(res.status).toBe('FAIL');
    expect(res.failureCategory).toBe('CANCELLED');
  });
  it('fingerprints changes inside an untracked directory and quoted paths', () => {
    const dir = mkdtempSync(join(tmpdir(), 'nexar-git-fingerprint-'));
    try {
      execFileSync('git', ['init', '-q', dir]);
      execFileSync(
        'git',
        [
          '-c',
          'user.name=Synthetic',
          '-c',
          'user.email=fixture@example.invalid',
          'commit',
          '--allow-empty',
          '-qm',
          'fixture',
        ],
        { cwd: dir },
      );
      const nested = join(dir, 'new directory');
      mkdirSync(nested);
      const file = join(nested, 'quoted-é.txt');
      writeFileSync(file, 'first');
      const first = getGitInfo(dir);
      writeFileSync(file, 'second');
      const second = getGitInfo(dir);
      expect(first.isDirty).toBe(true);
      expect(second.dirtyFingerprint).not.toBe(first.dirtyFingerprint);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('does not classify a signal-terminated child as successful', async () => {
    const result = await spawnSubprocess(
      process.execPath,
      ['-e', "process.kill(process.pid, 'SIGTERM')"],
      { timeoutMs: 10_000 },
    );
    expect(result.exitCode).not.toBe(0);
  });

  it('does not spawn a child when cancellation already occurred', async () => {
    const controller = new AbortController();
    controller.abort();
    const result = await spawnSubprocess('non_existent_cancelled_fixture', [], {
      signal: controller.signal,
      timeoutMs: 10_000,
    });
    expect(result.exitCode).toBe(130);
    expect(result.aborted).toBe(true);
    expect(result.settled).toBe(true);
  });

  it('cannot waive unsupported Node for Full acceptance', async () => {
    const platform = {
      repoRoot: process.cwd(),
      node: {
        isMatched: false,
        activeVersion: 'v24.15.0',
        activeExec: process.execPath,
        pinnedMajor: '22',
      },
      pnpm: { isMatched: true },
      dsh: { lockMatches: true },
      gitleaks: { available: true, isMatched: true },
    } as unknown as PlatformInfo;
    const result = await runPreflight(platform, { mode: 'full', allowNodeMismatch: true });
    expect(result.ok).toBe(false);
    expect(result.checks.find((c) => c.name === 'node-version')?.status).toBe('FAIL');
  });

  it('refuses Full acceptance from dirty or unidentified source', async () => {
    const platform = {
      repoRoot: process.cwd(),
      git: { commit: 'a'.repeat(40), tree: 'b'.repeat(40), isDirty: true },
      node: { isMatched: true },
      pnpm: { isMatched: true },
      dsh: { lockMatches: true },
      gitleaks: { available: true, isMatched: true },
    } as unknown as PlatformInfo;
    const dirty = await runPreflight(platform, { mode: 'full' });
    expect(dirty.ok).toBe(false);
    expect(dirty.checks.find((c) => c.name === 'git-clean')?.status).toBe('FAIL');
    const unknown = await runPreflight(
      { ...platform, git: { ...platform.git, isDirty: false, tree: 'unknown' } },
      { mode: 'full' },
    );
    expect(unknown.ok).toBe(false);
    expect(unknown.checks.find((c) => c.name === 'git-clean')?.status).toBe('FAIL');
    const clean = await runPreflight(
      { ...platform, git: { ...platform.git, isDirty: false } },
      { mode: 'full' },
    );
    expect(clean.ok).toBe(true);
    expect(clean.checks.find((c) => c.name === 'git-clean')?.status).toBe('PASS');
  });

  it('keeps WSL validation distinct from native Ubuntu acceptance', () => {
    const git = { commit: 'a'.repeat(40), isDirty: false, dirtyFingerprint: null };
    const windows = {
      finalStatus: 'NEXAR_WINDOWS_FULL_PASS',
      metadata: { git, os: { platform: 'win32', isWsl: false }, dsh: { version: '0.2.1-rc.5' } },
    };
    const linux = {
      finalStatus: 'NEXAR_LINUX_WSL2_PASS',
      metadata: { git, os: { platform: 'linux', isWsl: true }, dsh: { version: '0.2.1-rc.5' } },
    };
    expect(aggregateCrossPlatformEvidence(windows, linux).verdict).toBe(
      'NEXAR_CROSS_PLATFORM_ACCEPTANCE_INCOMPLETE',
    );
    expect(
      aggregateCrossPlatformEvidence(windows, { ...linux, finalStatus: 'NEXAR_LINUX_FULL_PASS' })
        .verdict,
    ).toBe('NEXAR_CROSS_PLATFORM_ACCEPTANCE_INCOMPLETE');
  });
});
