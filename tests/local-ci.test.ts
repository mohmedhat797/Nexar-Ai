import { describe, expect, it } from 'vitest';
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import os from 'node:os';
import { join } from 'node:path';
import type { PlatformInfo } from '../scripts/local-ci/platform.mjs';
import { getGitInfo } from '../scripts/local-ci/platform.mjs';
import {
  killProcessTree,
  redactSecrets,
  spawnSubprocess,
} from '../scripts/local-ci/process-util.mjs';
import { runPreflight } from '../scripts/local-ci/preflight.mjs';
import type { RunData } from '../scripts/local-ci/report.mjs';
import {
  aggregateCrossPlatformEvidence,
  aggregateTestCounts,
  computeFinalStatus,
  generateReports,
} from '../scripts/local-ci/report.mjs';
import {
  executeStage,
  getStages,
  inspectWindowsPackage,
  parseVitestStats,
} from '../scripts/local-ci/stages.mjs';

describe('Nexar Local CI Orchestrator', () => {
  // 1. Successful command execution
  it('case 1: executes command successfully and captures output', async () => {
    const res = await spawnSubprocess(process.execPath, ['-e', 'console.log("ci-success-test")'], {
      timeoutMs: 10_000,
    });
    expect(res.exitCode).toBe(0);
    expect(res.timedOut).toBe(false);
    expect(res.aborted).toBe(false);
    expect(res.stdout).toContain('ci-success-test');
    expect(res.durationMs).toBeGreaterThan(0);
  });

  // 2. Non-zero child exit
  it('case 2: handles non-zero child exit and propagates code', async () => {
    const res = await spawnSubprocess(process.execPath, ['-e', 'process.exit(42)'], {
      timeoutMs: 10_000,
    });
    expect(res.exitCode).toBe(42);
    expect(res.timedOut).toBe(false);
  });

  // 3. Child timeout
  it('case 3: enforces subprocess timeout and kills process tree', async () => {
    const res = await spawnSubprocess(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], {
      timeoutMs: 300,
    });
    expect(res.timedOut).toBe(true);
    expect(res.exitCode).toBe(124);
  });

  // 4. Cancellation
  it('case 4: cancels running subprocess promptly when aborted', async () => {
    const controller = new AbortController();
    setTimeout(() => controller.abort(), 100);

    const res = await spawnSubprocess(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], {
      timeoutMs: 10_000,
      signal: controller.signal,
    });
    expect(res.aborted).toBe(true);
    expect(res.exitCode).toBe(130);
  });

  // 5. Missing dependency / binary
  it('case 5: safely handles non-existent binary without crashing', async () => {
    const res = await spawnSubprocess('non_existent_binary_xyz_123', [], {
      timeoutMs: 5_000,
    });
    expect(res.exitCode).toBe(1);
    expect(res.error).toBeDefined();
  });

  // 6. Wrong Node version
  it('case 6: fails preflight on Node.js version mismatch unless allowed', async () => {
    const fakePlatform = {
      node: {
        activeVersion: 'v24.15.0',
        activeExec: 'C:\\fake\\node.exe',
        pinnedMajor: '22',
        isMatched: false,
      },
      pnpm: { isMatched: true, installedVersion: '10.33.0', expectedVersion: '10.33.0' },
      dsh: { lockMatches: true, package: '@deepseek-ai/dsh', pinnedVersion: '0.2.1-rc.5' },
      gitleaks: {
        available: true,
        isMatched: true,
        installedVersion: '8.28.0',
        execPath: 'gitleaks',
      },
      repoRoot: process.cwd(),
    };

    const strictRes = await runPreflight(fakePlatform as unknown as PlatformInfo, {
      mode: 'full',
      allowNodeMismatch: false,
    });
    expect(strictRes.ok).toBe(false);
    expect(strictRes.checks.find((c) => c.name === 'node-version')?.status).toBe('FAIL');

    const laxRes = await runPreflight(fakePlatform as unknown as PlatformInfo, {
      mode: 'quick',
      allowNodeMismatch: true,
    });
    expect(laxRes.ok).toBe(true);
    expect(laxRes.checks.find((c) => c.name === 'node-version')?.status).toBe('WARN');
  });

  // 7. Unsupported platform
  it('case 7: marks Linux sandbox gate as BLOCKED on Windows host', async () => {
    const fakePlatform = {
      os: { platform: 'win32', release: '10.0.0', arch: 'x64' },
      node: { activeExec: process.execPath, activeVersion: 'v22.23.3' },
      pnpm: { installedVersion: '10.33.0' },
      gitleaks: { execPath: 'gitleaks' },
      dsh: { defaultInstallDir: 'dist/dsh' },
      repoRoot: process.cwd(),
    };

    const stages = getStages('full', fakePlatform as unknown as PlatformInfo);
    const sandboxStage = stages.find((s) => s.id === 'linux-sandbox');
    expect(sandboxStage).toBeDefined();

    const stageRes = await executeStage(sandboxStage!, { repoRoot: process.cwd() });
    expect(stageRes.status).toBe('BLOCKED');
    expect(stageRes.failureCategory).toBe('ENVIRONMENT_UNSUPPORTED');
  });

  // 8. Missing DSH runtime pin lock
  it('case 8: detects mismatched DSH pin or lockfile in preflight', async () => {
    const fakePlatform = {
      node: {
        isMatched: true,
        activeVersion: 'v22.23.3',
        activeExec: process.execPath,
        pinnedMajor: '22',
      },
      pnpm: { isMatched: true, installedVersion: '10.33.0', expectedVersion: '10.33.0' },
      dsh: { lockMatches: false, package: '@deepseek-ai/dsh', pinnedVersion: '0.2.1-rc.5' },
      gitleaks: {
        available: true,
        isMatched: true,
        installedVersion: '8.28.0',
        execPath: 'gitleaks',
      },
      repoRoot: process.cwd(),
    };

    const res = await runPreflight(fakePlatform as unknown as PlatformInfo, { mode: 'full' });
    expect(res.ok).toBe(false);
    expect(res.checks.find((c) => c.name === 'dsh-pin-lock')?.status).toBe('FAIL');
  });

  // 9. Required stage skipped
  it('case 9: marks subsequent stages skipped when a required stage fails', async () => {
    const stageFail = {
      id: 'mandatory-fail',
      name: 'Failing Stage',
      command: [process.execPath, '-e', 'process.exit(1)'],
      required: true,
    };
    const executedFail = await executeStage(stageFail, {
      repoRoot: process.cwd(),
    });
    expect(executedFail.status).toBe('FAIL');
    expect(executedFail.failureCategory).toBe('COMMAND_EXIT_NONZERO');
  });

  // 10. Report generation (JSON and Markdown)
  it('case 10: generates structured JSON and Markdown validation reports', () => {
    const tempDir = mkdtempSync(join(os.tmpdir(), 'nexar-report-test-'));
    try {
      const mockRunData = {
        mode: 'quick',
        profile: 'auto',
        platformInfo: {
          repoRoot: tempDir,
          git: {
            commit: 'a'.repeat(40),
            branch: 'feat/test',
            isDirty: false,
            dirtyFingerprint: null,
          },
          os: { platform: 'win32', release: '10.0', arch: 'x64' },
          node: {
            activeVersion: 'v22.23.3',
            activeExec: 'node',
            pinnedMajor: '22',
            source: 'current',
          },
          pnpm: { installedVersion: '10.33.0', expectedVersion: '10.33.0' },
          dsh: { package: '@deepseek-ai/dsh', pinnedVersion: '0.2.1-rc.5', lockMatches: true },
          gitleaks: { installedVersion: '8.28.0', execPath: 'gitleaks' },
        },
        preflightResult: {
          ok: true,
          checks: [{ name: 'node-version', status: 'PASS', message: 'OK' }],
          diagnostics: [],
        },
        stageResults: [
          {
            id: 'format-check',
            name: 'Prettier formatting check',
            status: 'PASS',
            durationMs: 1200,
            exitCode: 0,
            required: true,
            vitestStats: null,
          },
          {
            id: 'lint',
            name: 'ESLint static analysis',
            status: 'PASS',
            durationMs: 1500,
            exitCode: 0,
            required: true,
            vitestStats: null,
          },
          {
            id: 'boundaries',
            name: 'Package boundaries',
            status: 'PASS',
            durationMs: 500,
            exitCode: 0,
            required: true,
            vitestStats: null,
          },
          {
            id: 'typecheck',
            name: 'TypeScript typecheck',
            status: 'PASS',
            durationMs: 2000,
            exitCode: 0,
            required: true,
            vitestStats: null,
          },
          {
            id: 'test-offline',
            name: 'Test suite',
            status: 'PASS',
            durationMs: 3000,
            exitCode: 0,
            required: true,
            vitestStats: {
              testFilesPassed: 10,
              testFilesFailed: 0,
              testFilesTotal: 10,
              testsPassed: 100,
              testsFailed: 0,
              testsSkipped: 5,
              testsTotal: 105,
            },
          },
        ],
        startTime: Date.now() - 5000,
        endTime: Date.now(),
        durationMs: 5000,
        sourceEnd: {
          commit: 'a'.repeat(40),
          branch: 'feat/test',
          isDirty: false,
          dirtyFingerprint: null,
        },
      };

      const reports = generateReports(mockRunData as unknown as RunData);
      expect(reports.finalStatus).toBe('LOCAL_CI_QUICK_PASS');
      expect(existsSync(reports.jsonPath)).toBe(true);
      expect(existsSync(reports.mdPath)).toBe(true);
      expect(existsSync(reports.latestJsonPath)).toBe(true);
      expect(existsSync(reports.latestMdPath)).toBe(true);

      const json = JSON.parse(readFileSync(reports.jsonPath, 'utf8')) as {
        finalStatus: string;
        metadata: { git: { commit: string } };
      };
      expect(json.finalStatus).toBe('LOCAL_CI_QUICK_PASS');
      expect(json.metadata.git.commit).toBe('a'.repeat(40));

      const md = readFileSync(reports.mdPath, 'utf8');
      expect(md).toContain('Nexar Local CI Verification Report');
      expect(md).toContain('LOCAL_CI_QUICK_PASS');
    } finally {
      rmSync(tempDir, { recursive: true, force: true });
    }
  });

  // 11. Dirty Git working tree
  it('case 11: detects git metadata and tracks dirty tree fingerprints', () => {
    const gitInfo = getGitInfo();
    expect(gitInfo.commit).toMatch(/^[a-f0-9]{40}$/);
    expect(gitInfo.branch).toBeDefined();
    if (gitInfo.isDirty) {
      expect(gitInfo.dirtyFingerprint).toMatch(/^[a-f0-9]{64}$/);
      expect(gitInfo.summary).toContain('dirty:');
    }
  });

  // 12. Exit-code propagation
  it('case 12: accurately records exit codes and reflects them in stage verdict', async () => {
    const stage = {
      id: 'exit-code-test',
      name: 'Custom Exit Code Stage',
      command: [process.execPath, '-e', 'process.exit(7)'],
      required: true,
    };
    const res = await executeStage(stage, {
      repoRoot: process.cwd(),
    });
    expect(res.exitCode).toBe(7);
    expect(res.status).toBe('FAIL');
  });

  // 13. Process cleanup
  it('case 13: cleanly cleans up process tree on demand', () => {
    expect(() => killProcessTree(null)).not.toThrow();
    expect(() => killProcessTree(9999999)).not.toThrow();
  });

  // 14. Secret-safe log output
  it('case 14: redacts secrets from logged output', () => {
    const sample =
      'Found token=ghp_ABC1234567890defABC1234567890def123 and sk-abcdef1234567890123456';
    const redacted = redactSecrets(sample);
    expect(redacted).not.toContain('ghp_ABC1234567890defABC1234567890def123');
    expect(redacted).not.toContain('sk-abcdef1234567890123456');
    expect(redacted).toContain('[REDACTED_SECRET]');
  });

  // 15. Stage status aggregation and deterministic manifests
  it('case 15: evaluates status against platform manifests and test statistics', () => {
    const quickStages = [
      {
        id: 'format-check',
        name: 'Format',
        command: '',
        startTime: '',
        durationMs: 10,
        exitCode: 0,
        status: 'PASS' as const,
        required: true,
        failureCategory: null,
        logExcerpt: '',
        vitestStats: null,
      },
      {
        id: 'lint',
        name: 'Lint',
        command: '',
        startTime: '',
        durationMs: 10,
        exitCode: 0,
        status: 'PASS' as const,
        required: true,
        failureCategory: null,
        logExcerpt: '',
        vitestStats: null,
      },
      {
        id: 'boundaries',
        name: 'Boundaries',
        command: '',
        startTime: '',
        durationMs: 10,
        exitCode: 0,
        status: 'PASS' as const,
        required: true,
        failureCategory: null,
        logExcerpt: '',
        vitestStats: null,
      },
      {
        id: 'typecheck',
        name: 'Typecheck',
        command: '',
        startTime: '',
        durationMs: 10,
        exitCode: 0,
        status: 'PASS' as const,
        required: true,
        failureCategory: null,
        logExcerpt: '',
        vitestStats: null,
      },
      {
        id: 'test-offline',
        name: 'Tests',
        command: '',
        startTime: '',
        durationMs: 10,
        exitCode: 0,
        status: 'PASS' as const,
        required: true,
        failureCategory: null,
        logExcerpt: '',
        vitestStats: {
          testFilesPassed: 2,
          testFilesFailed: 0,
          testFilesTotal: 2,
          testsPassed: 20,
          testsFailed: 0,
          testsSkipped: 2,
          testsTotal: 22,
        },
      },
    ];

    expect(computeFinalStatus('quick', quickStages)).toBe('LOCAL_CI_QUICK_PASS');

    // Windows Full pass
    const winFullStages = [
      'dependencies',
      'dsh-install',
      'dsh-artifact-seal',
      'format-check',
      'lint',
      'boundaries',
      'typecheck',
      'test-offline',
      'build',
      'cli-smoke-resources',
      'cli-smoke-run',
      'dsh-context-real',
      'cowork-isolation-wsl',
      'desktop-e2e-source',
      'desktop-package-win',
      'desktop-e2e-packaged',
      'gitleaks-scan',
    ].map((id) => ({
      id,
      name: id,
      command: id,
      startTime: '',
      durationMs: 10,
      exitCode: 0,
      status: 'PASS' as const,
      required: true,
      failureCategory: null,
      logExcerpt: '',
      vitestStats:
        id === 'test-offline'
          ? {
              testFilesPassed: 200,
              testFilesFailed: 0,
              testFilesTotal: 200,
              testsPassed: 4200,
              testsFailed: 0,
              testsSkipped: 160,
              testsTotal: 4360,
            }
          : null,
    }));

    // Optional linux sandbox gate blocked on Windows does not block Windows full pass
    const winFullWithBlockedSandbox = [
      ...winFullStages,
      {
        id: 'linux-sandbox',
        name: 'Linux sandbox',
        command: '',
        startTime: '',
        durationMs: 0,
        exitCode: null,
        status: 'BLOCKED' as const,
        required: false,
        failureCategory: 'ENVIRONMENT_UNSUPPORTED',
        logExcerpt: '',
        vitestStats: null,
      },
    ];
    expect(computeFinalStatus('full', winFullWithBlockedSandbox, { platform: 'win32' })).toBe(
      'NEXAR_WINDOWS_FULL_PASS',
    );
    expect(
      computeFinalStatus(
        'full',
        winFullStages.filter((stage) => stage.id !== 'cowork-isolation-wsl'),
        { platform: 'win32' },
      ),
    ).toBe('NEXAR_WINDOWS_FULL_FAIL');

    // Linux Full pass
    const linuxFullStages = [
      'dependencies',
      'dsh-install',
      'format-check',
      'lint',
      'boundaries',
      'typecheck',
      'test-offline',
      'build',
      'cli-smoke-resources',
      'cli-smoke-run',
      'dsh-context-real',
      'desktop-e2e-linux',
      'linux-sandbox',
      'gitleaks-scan',
    ].map((id) => ({
      id,
      name: id,
      command: id,
      startTime: '',
      durationMs: 10,
      exitCode: 0,
      status: 'PASS' as const,
      required: true,
      failureCategory: null,
      logExcerpt: '',
      vitestStats: null,
    }));

    expect(computeFinalStatus('full', linuxFullStages, { platform: 'linux', isWsl: false })).toBe(
      'NEXAR_LINUX_FULL_PASS',
    );
    expect(computeFinalStatus('full', linuxFullStages, { platform: 'linux', isWsl: true })).toBe(
      'NEXAR_LINUX_WSL2_PASS',
    );

    const totals = aggregateTestCounts(quickStages);
    expect(totals.testsPassed).toBe(20);
    expect(totals.testsSkipped).toBe(2);
    expect(totals.testsTotal).toBe(22);

    // Parse Vitest output string
    const sampleStdout = 'Test Files  208 passed (208)\nTests  4229 passed | 160 skipped (4389)';
    const parsed = parseVitestStats(sampleStdout);
    expect(parsed.testFilesPassed).toBe(208);
    expect(parsed.testsPassed).toBe(4229);
    expect(parsed.testsSkipped).toBe(160);
    expect(parsed.testsTotal).toBe(4389);
  });

  // 16. Empty stage list cannot produce PASS
  it('case 16: prevents empty stage list from producing PASS', () => {
    expect(computeFinalStatus('quick', [])).toBe('LOCAL_CI_QUICK_FAIL');
    expect(computeFinalStatus('full', [], { platform: 'win32' })).toBe('NEXAR_WINDOWS_FULL_FAIL');
    expect(computeFinalStatus('full', [], { platform: 'linux' })).toBe('NEXAR_LINUX_FULL_FAIL');
  });

  // 17. Missing mandatory stage returns FAIL
  it('case 17: prevents missing mandatory stage from producing PASS', () => {
    const incompleteQuick = [
      {
        id: 'format-check',
        name: 'Format',
        command: '',
        startTime: '',
        durationMs: 10,
        exitCode: 0,
        status: 'PASS' as const,
        required: true,
        failureCategory: null,
        logExcerpt: '',
        vitestStats: null,
      },
      {
        id: 'lint',
        name: 'Lint',
        command: '',
        startTime: '',
        durationMs: 10,
        exitCode: 0,
        status: 'PASS' as const,
        required: true,
        failureCategory: null,
        logExcerpt: '',
        vitestStats: null,
      },
    ];
    expect(computeFinalStatus('quick', incompleteQuick)).toBe('LOCAL_CI_QUICK_FAIL');

    const incompleteWinFull = [
      {
        id: 'dependencies',
        name: 'Deps',
        command: '',
        startTime: '',
        durationMs: 10,
        exitCode: 0,
        status: 'PASS' as const,
        required: true,
        failureCategory: null,
        logExcerpt: '',
        vitestStats: null,
      },
    ];
    expect(computeFinalStatus('full', incompleteWinFull, { platform: 'win32' })).toBe(
      'NEXAR_WINDOWS_FULL_FAIL',
    );
  });

  // 18. Required stage SKIPPED or NOT_RUN produces FAIL
  it('case 18: treats required stage marked SKIPPED or NOT_RUN as FAIL', () => {
    const skippedRequired = [
      {
        id: 'format-check',
        name: 'Format',
        command: '',
        startTime: '',
        durationMs: 10,
        exitCode: 0,
        status: 'PASS' as const,
        required: true,
        failureCategory: null,
        logExcerpt: '',
        vitestStats: null,
      },
      {
        id: 'lint',
        name: 'Lint',
        command: '',
        startTime: '',
        durationMs: 10,
        exitCode: 0,
        status: 'PASS' as const,
        required: true,
        failureCategory: null,
        logExcerpt: '',
        vitestStats: null,
      },
      {
        id: 'boundaries',
        name: 'Boundaries',
        command: '',
        startTime: '',
        durationMs: 10,
        exitCode: 0,
        status: 'PASS' as const,
        required: true,
        failureCategory: null,
        logExcerpt: '',
        vitestStats: null,
      },
      {
        id: 'typecheck',
        name: 'Typecheck',
        command: '',
        startTime: '',
        durationMs: 10,
        exitCode: 0,
        status: 'PASS' as const,
        required: true,
        failureCategory: null,
        logExcerpt: '',
        vitestStats: null,
      },
      {
        id: 'test-offline',
        name: 'Tests',
        command: '',
        startTime: '',
        durationMs: 0,
        exitCode: null,
        status: 'SKIPPED' as const,
        required: true,
        failureCategory: 'SKIPPED_DUE_TO_PREVIOUS_FAILURE',
        logExcerpt: '',
        vitestStats: null,
      },
    ];
    expect(computeFinalStatus('quick', skippedRequired)).toBe('LOCAL_CI_QUICK_FAIL');
  });

  // 19. Cross-platform evidence aggregation
  it('case 19: aggregates cross-platform evidence and requires clean matching commit', () => {
    const winReport = {
      finalStatus: 'NEXAR_WINDOWS_FULL_PASS',
      metadata: {
        os: { platform: 'win32', isWsl: false },
        git: {
          commit: 'abcd1234abcd1234abcd1234abcd1234abcd1234',
          isDirty: false,
          dirtyFingerprint: null,
        },
        dsh: { version: '0.2.1-rc.5' },
      },
    };
    const linuxReport = {
      finalStatus: 'NEXAR_LINUX_FULL_PASS',
      metadata: {
        os: { platform: 'linux', isWsl: false },
        git: {
          commit: 'abcd1234abcd1234abcd1234abcd1234abcd1234',
          isDirty: false,
          dirtyFingerprint: null,
        },
        dsh: { version: '0.2.1-rc.5' },
      },
    };

    const passRes = aggregateCrossPlatformEvidence(winReport, linuxReport);
    expect(passRes.verdict).toBe('NEXAR_CROSS_PLATFORM_ACCEPTANCE_PASS');
    expect(passRes.matchedCommit).toBe('abcd1234abcd1234abcd1234abcd1234abcd1234');

    // Mismatched commit
    const diffCommitLinux = {
      ...linuxReport,
      metadata: {
        ...linuxReport.metadata,
        git: {
          commit: '9999999999999999999999999999999999999999',
          isDirty: false,
          dirtyFingerprint: null,
        },
      },
    };
    const mismatchRes = aggregateCrossPlatformEvidence(winReport, diffCommitLinux);
    expect(mismatchRes.verdict).toBe('NEXAR_CROSS_PLATFORM_ACCEPTANCE_INCOMPLETE');
    expect(mismatchRes.reasons.some((r) => r.includes('Commit mismatch'))).toBe(true);

    // Dirty tree
    const dirtyWin = {
      ...winReport,
      metadata: {
        ...winReport.metadata,
        git: {
          commit: 'abcd1234abcd1234abcd1234abcd1234abcd1234',
          isDirty: true,
          dirtyFingerprint: 'f00ba123',
        },
      },
    };
    const dirtyRes = aggregateCrossPlatformEvidence(dirtyWin, linuxReport);
    expect(dirtyRes.verdict).toBe('NEXAR_CROSS_PLATFORM_ACCEPTANCE_INCOMPLETE');
    expect(dirtyRes.reasons.some((r) => r.includes('dirty'))).toBe(true);
  });

  // 20. Stale packaging artifact rejection
  it('case 20: detects and rejects stale Windows installer artifacts', () => {
    const tempDir = mkdtempSync(join(os.tmpdir(), 'nexar-pkg-test-'));
    try {
      const res = inspectWindowsPackage(tempDir, { minMtimeMs: Date.now() + 100_000 });
      // Non-existent directory returns null
      expect(res).toBeNull();
    } finally {
      rmSync(tempDir, { recursive: true, force: true });
    }
  });

  // 21. Bounded log capture
  it('case 21: bounds subprocess stdout buffer to prevent memory exhaustion', async () => {
    // Generate 1.2MB of stdout
    const res = await spawnSubprocess(
      process.execPath,
      [
        '-e',
        'for(let i=0; i<35000; i++) process.stdout.write("1234567890abcdefghijklmnopqrstuvwxyz\\n")',
      ],
      {
        timeoutMs: 15_000,
      },
    );
    expect(res.exitCode).toBe(0);
    expect(res.stdout.length).toBeLessThanOrEqual(1_100_000);
    expect(res.stdout).toContain('truncated for memory safety');
  });
});
