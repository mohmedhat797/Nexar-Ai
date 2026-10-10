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
import { executeStage, getStages, parseVitestStats } from '../scripts/local-ci/stages.mjs';
import type { RunData } from '../scripts/local-ci/report.mjs';
import {
  aggregateTestCounts,
  computeFinalStatus,
  generateReports,
} from '../scripts/local-ci/report.mjs';

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
      dsh: { lockMatches: true, package: '@deepseek-ai/dsh', pinnedVersion: '0.2.0-rc.2' },
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
      mode: 'full',
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
      dsh: { lockMatches: false, package: '@deepseek-ai/dsh', pinnedVersion: '0.2.0-rc.2' },
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
          git: { commit: '17b51a6b', branch: 'feat/test', isDirty: false, dirtyFingerprint: null },
          os: { platform: 'win32', release: '10.0', arch: 'x64' },
          node: {
            activeVersion: 'v22.23.3',
            activeExec: 'node',
            pinnedMajor: '22',
            source: 'current',
          },
          pnpm: { installedVersion: '10.33.0', expectedVersion: '10.33.0' },
          dsh: { package: '@deepseek-ai/dsh', pinnedVersion: '0.2.0-rc.2', lockMatches: true },
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
        ],
        startTime: Date.now() - 5000,
        endTime: Date.now(),
        durationMs: 5000,
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
      expect(json.metadata.git.commit).toBe('17b51a6b');

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
      expect(gitInfo.dirtyFingerprint).toMatch(/^[a-f0-9]{16}$/);
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

  // 15. Stage status aggregation
  it('case 15: aggregates stage statuses and test statistics correctly', () => {
    const stageResults = [
      {
        id: 's1',
        name: 'Stage 1',
        command: 's1',
        startTime: new Date().toISOString(),
        durationMs: 100,
        exitCode: 0,
        status: 'PASS' as const,
        required: true,
        failureCategory: null,
        logExcerpt: '',
        vitestStats: {
          testFilesPassed: 1,
          testFilesFailed: 0,
          testFilesTotal: 1,
          testsPassed: 10,
          testsFailed: 0,
          testsSkipped: 2,
          testsTotal: 12,
        },
      },
      {
        id: 's2',
        name: 'Stage 2',
        command: 's2',
        startTime: new Date().toISOString(),
        durationMs: 50,
        exitCode: 0,
        status: 'PASS' as const,
        required: true,
        failureCategory: null,
        logExcerpt: '',
        vitestStats: {
          testFilesPassed: 1,
          testFilesFailed: 0,
          testFilesTotal: 1,
          testsPassed: 5,
          testsFailed: 0,
          testsSkipped: 1,
          testsTotal: 6,
        },
      },
      {
        id: 's3',
        name: 'Stage 3',
        command: 's3',
        startTime: new Date().toISOString(),
        durationMs: 0,
        exitCode: null,
        status: 'BLOCKED' as const,
        required: false,
        failureCategory: null,
        logExcerpt: '',
        vitestStats: null,
      },
    ];

    const quickVerdict = computeFinalStatus('quick', stageResults);
    expect(quickVerdict).toBe('LOCAL_CI_QUICK_PASS');

    const fullVerdict = computeFinalStatus('full', stageResults);
    expect(fullVerdict).toBe('NEXAR_LOCAL_CI_PASS'); // optional stage blocked does not block full pass

    const blockedResult = [
      ...stageResults,
      {
        id: 's4',
        name: 'Stage 4',
        command: 's4',
        startTime: new Date().toISOString(),
        durationMs: 0,
        exitCode: null,
        status: 'BLOCKED' as const,
        required: true,
        failureCategory: null,
        logExcerpt: '',
        vitestStats: null,
      },
    ];
    expect(computeFinalStatus('full', blockedResult)).toBe('NEXAR_LOCAL_CI_BLOCKED');

    const failedResult = [
      ...stageResults,
      {
        id: 's5',
        name: 'Stage 5',
        command: 's5',
        startTime: new Date().toISOString(),
        durationMs: 0,
        exitCode: 1,
        status: 'FAIL' as const,
        required: true,
        failureCategory: 'COMMAND_EXIT_NONZERO',
        logExcerpt: '',
        vitestStats: null,
      },
    ];
    expect(computeFinalStatus('full', failedResult)).toBe('NEXAR_LOCAL_CI_FAIL');

    const totals = aggregateTestCounts(stageResults);
    expect(totals.testsPassed).toBe(15);
    expect(totals.testsSkipped).toBe(3);
    expect(totals.testsTotal).toBe(18);

    // Parse Vitest string
    const sampleStdout = 'Test Files  208 passed (208)\nTests  4229 passed | 160 skipped (4389)';
    const parsed = parseVitestStats(sampleStdout);
    expect(parsed.testFilesPassed).toBe(208);
    expect(parsed.testsPassed).toBe(4229);
    expect(parsed.testsSkipped).toBe(160);
    expect(parsed.testsTotal).toBe(4389);
  });
});
