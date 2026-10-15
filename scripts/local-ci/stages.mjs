import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { delimiter, dirname, join } from 'node:path';
import { redactSecrets, spawnSubprocess } from './process-util.mjs';

/**
 * Extracts Vitest test statistics from command stdout/stderr.
 */
export function parseVitestStats(rawStdout = '') {
  // eslint-disable-next-line no-control-regex
  const stdout = rawStdout.replace(/\u001b\[[0-9;]*[a-zA-Z]/g, '');
  const stats = {
    testFilesPassed: 0,
    testFilesFailed: 0,
    testFilesTotal: 0,
    testsPassed: 0,
    testsFailed: 0,
    testsSkipped: 0,
    testsTotal: 0,
  };

  const fileMatch = stdout.match(
    /Test Files\s+(?:(\d+)\s+failed\s*\|?\s*)?(?:(\d+)\s+passed\s*\|?\s*)?(?:(\d+)\s+skipped\s*\|?\s*)?\(?(\d+)?\)?/,
  );
  if (fileMatch) {
    stats.testFilesFailed = fileMatch[1] ? parseInt(fileMatch[1], 10) : 0;
    stats.testFilesPassed = fileMatch[2] ? parseInt(fileMatch[2], 10) : 0;
    stats.testFilesTotal = fileMatch[4]
      ? parseInt(fileMatch[4], 10)
      : fileMatch[3]
        ? parseInt(fileMatch[3], 10)
        : stats.testFilesPassed + stats.testFilesFailed;
  }

  const testMatch = stdout.match(
    /Tests\s+(?:(\d+)\s+failed\s*\|?\s*)?(?:(\d+)\s+passed\s*\|?\s*)?(?:(\d+)\s+skipped\s*\(?(\d+)?\)?)/,
  );
  if (testMatch) {
    stats.testsFailed = testMatch[1] ? parseInt(testMatch[1], 10) : 0;
    stats.testsPassed = testMatch[2] ? parseInt(testMatch[2], 10) : 0;
    stats.testsSkipped = testMatch[3] ? parseInt(testMatch[3], 10) : 0;
    stats.testsTotal = testMatch[4]
      ? parseInt(testMatch[4], 10)
      : stats.testsPassed + stats.testsFailed + stats.testsSkipped;
  } else {
    // Check without skips
    const simpleMatch = stdout.match(
      /Tests\s+(?:(\d+)\s+failed\s*\|?\s*)?(\d+)\s+passed\s*\((\d+)\)/,
    );
    if (simpleMatch) {
      stats.testsFailed = simpleMatch[1] ? parseInt(simpleMatch[1], 10) : 0;
      stats.testsPassed = simpleMatch[2] ? parseInt(simpleMatch[2], 10) : 0;
      stats.testsTotal = simpleMatch[3] ? parseInt(simpleMatch[3], 10) : stats.testsPassed;
    }
  }

  return stats;
}

/** Count actual assertion statuses: Vitest's summary omits nested pending tests. */
export function parseVitestJsonStats(report) {
  const assertions = report.testResults.flatMap((file) => file.assertionResults);
  const count = (status) => assertions.filter((test) => test.status === status).length;
  const stats = {
    testFilesPassed: report.testResults.filter(
      (file) =>
        file.assertionResults.some((test) => test.status === 'passed') &&
        !file.assertionResults.some((test) => test.status === 'failed'),
    ).length,
    testFilesFailed: report.testResults.filter((file) =>
      file.assertionResults.some((test) => test.status === 'failed'),
    ).length,
    testFilesTotal: report.testResults.length,
    testsPassed: count('passed'),
    testsFailed: count('failed'),
    testsSkipped: count('skipped'),
    testsPending: count('pending'),
    testsTodo: count('todo'),
    testsTotal: report.numTotalTests,
  };
  stats.testsUnclassified =
    stats.testsTotal -
    stats.testsPassed -
    stats.testsFailed -
    stats.testsSkipped -
    stats.testsPending -
    stats.testsTodo;
  if (
    !Number.isSafeInteger(stats.testsTotal) ||
    stats.testsTotal !== assertions.length ||
    stats.testsUnclassified !== 0
  )
    throw new Error('Vitest assertion statistics do not reconcile');
  return stats;
}

/**
 * Inspects Windows packaging artifacts.
 */
export function inspectWindowsPackage(repoRoot, options = {}) {
  const { minMtimeMs = null } = options;
  const releaseDir = join(repoRoot, 'release', 'desktop');
  if (!existsSync(releaseDir)) return null;

  try {
    const files = readdirSync(releaseDir);
    const exeName = files.find((f) => f.endsWith('.exe') && f.includes('Nexar'));
    if (!exeName) return null;

    const exePath = join(releaseDir, exeName);
    const stats = statSync(exePath);

    // Stale check
    if (minMtimeMs && stats.mtimeMs < minMtimeMs) {
      return {
        installerName: exeName,
        installerPath: exePath,
        isStale: true,
        staleReason: `Artifact mtime (${new Date(stats.mtimeMs).toISOString()}) predates stage start (${new Date(minMtimeMs).toISOString()})`,
      };
    }

    let sha256 = null;
    const shaFile = files.find((f) => f.endsWith('.sha256') && f.includes(exeName));
    if (shaFile) {
      const content = readFileSync(join(releaseDir, shaFile), 'utf8');
      const hashMatch = content.match(/[a-f0-9]{64}/i);
      if (hashMatch) sha256 = hashMatch[0];
    }
    const buffer = readFileSync(exePath);
    const computedSha = createHash('sha256').update(buffer).digest('hex');
    if (!sha256) {
      sha256 = computedSha;
    }

    const unpackedExe = join(releaseDir, 'win-unpacked', 'Nexar.exe');
    const unpackedExists = existsSync(unpackedExe);
    const unpackedIsStale =
      unpackedExists && minMtimeMs && statSync(unpackedExe).mtimeMs < minMtimeMs;

    // Inspect bundled DSH runtime in unpacked directory
    const bundledDshManifestPath = join(
      releaseDir,
      'win-unpacked',
      'resources',
      'dsh-runtime',
      'node_modules',
      '@deepseek-ai',
      'dsh',
      'package.json',
    );
    let bundledDshExists = false;
    let bundledDshVersion = null;
    let bundledDshMatches = false;

    if (existsSync(bundledDshManifestPath)) {
      try {
        const manifest = JSON.parse(readFileSync(bundledDshManifestPath, 'utf8'));
        bundledDshExists = true;
        bundledDshVersion = manifest.version;
        bundledDshMatches = manifest.version === '0.2.0-rc.2';
      } catch {
        // ignore
      }
    }

    // Inspect Authenticode signature
    let signatureStatus = 'NotSigned';
    let signed = false;
    if (process.platform === 'win32') {
      try {
        const probe = spawnSync(
          'powershell.exe',
          ['-NoProfile', '-Command', `(Get-AuthenticodeSignature '${exePath}').Status.ToString()`],
          { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'], timeout: 10_000 },
        );
        if (probe.status === 0 && probe.stdout) {
          const status = probe.stdout.trim();
          signatureStatus = status;
          signed = status === 'Valid';
        }
      } catch {
        // PowerShell check unavailable
      }
    }

    return {
      installerName: exeName,
      installerPath: exePath,
      sizeBytes: stats.size,
      sha256,
      shaMatchesActual: sha256.toLowerCase() === computedSha.toLowerCase(),
      unpackedExists,
      unpackedPath: unpackedExe,
      bundledDshExists,
      bundledDshVersion,
      bundledDshMatches,
      signed,
      signatureStatus,
      mtimeMs: stats.mtimeMs,
      isStale: Boolean(unpackedIsStale),
      staleReason: unpackedIsStale ? 'Unpacked executable predates packaging stage' : undefined,
    };
  } catch {
    return null;
  }
}

/**
 * Builds the stage list for the chosen mode and platform.
 */
export function getStages(mode = 'quick', platformInfo, options = {}) {
  const { repoRoot } = platformInfo;
  const isWindows = platformInfo.os.platform === 'win32';
  const isLinux = platformInfo.os.platform === 'linux';

  // Base child environment: prepend active Node and Gitleaks directories to PATH
  const childEnv = { ...process.env };
  delete childEnv.NEXAR_LIVE_TESTS;
  const extraPaths = [];
  if (platformInfo.node.activeExec) {
    extraPaths.push(dirname(platformInfo.node.activeExec));
  }
  if (platformInfo.gitleaks.execPath && platformInfo.gitleaks.execPath !== 'gitleaks') {
    extraPaths.push(dirname(platformInfo.gitleaks.execPath));
  }
  if (extraPaths.length > 0) {
    childEnv.PATH = `${extraPaths.join(delimiter)}${delimiter}${process.env.PATH || ''}`;
  }

  // If running on Linux/WSL against a Windows git worktree, set GIT_DIR to translated Linux path
  const gitFilePath = join(repoRoot, '.git');
  if (isLinux && existsSync(gitFilePath) && statSync(gitFilePath).isFile()) {
    try {
      const content = readFileSync(gitFilePath, 'utf8');
      const match = content.match(/gitdir:\s*([A-Za-z]):[/\\](.+)/);
      if (match) {
        const drive = match[1].toLowerCase();
        const rest = match[2].replace(/\\/g, '/').trim();
        childEnv.GIT_DIR = `/mnt/${drive}/${rest}`;
        childEnv.GIT_WORK_TREE = repoRoot;
      }
    } catch {
      // ignore
    }
  }

  const pnpmCmd = isWindows ? 'pnpm.cmd' : 'pnpm';
  const testWorkers =
    options.workers || process.env.NEXAR_TEST_WORKERS || (isWindows ? '2' : undefined);
  const testCmdArgs = testWorkers
    ? [pnpmCmd, 'test', `--maxWorkers=${testWorkers}`]
    : [pnpmCmd, 'test'];
  testCmdArgs.push(
    '--reporter=default',
    '--reporter=json',
    '--outputFile=.nexar/ci/test-offline.json',
  );

  if (mode === 'quick') {
    return [
      {
        id: 'format-check',
        name: 'Prettier formatting check',
        command: [pnpmCmd, 'format:check'],
        timeoutMs: 120_000,
        required: true,
        env: childEnv,
      },
      {
        id: 'lint',
        name: 'ESLint static analysis',
        command: [pnpmCmd, 'lint'],
        timeoutMs: 360_000,
        required: true,
        env: childEnv,
      },
      {
        id: 'boundaries',
        name: 'Package boundaries and secret guard',
        command: [pnpmCmd, 'check:boundaries'],
        timeoutMs: 60_000,
        required: true,
        env: childEnv,
      },
      {
        id: 'typecheck',
        name: 'TypeScript typecheck (project references)',
        command: [pnpmCmd, 'typecheck'],
        timeoutMs: 300_000,
        required: true,
        env: childEnv,
      },
      {
        id: 'test-offline',
        name: 'Offline unit & integration test suite',
        command: testCmdArgs,
        timeoutMs: 600_000,
        required: true,
        env: childEnv,
      },
    ];
  }

  // FULL MODE STAGES
  const stages = [
    {
      id: 'dependencies',
      name: 'Frozen lockfile dependency verification',
      command: [pnpmCmd, 'install', '--frozen-lockfile'],
      timeoutMs: 300_000,
      required: true,
      env: childEnv,
    },
    {
      id: 'dsh-install',
      name: 'Pinned DSH runtime install & verification',
      customRun: async (ctx) => {
        // Check if cached entry is valid
        const dshTargetDir = options.dshDir || platformInfo.dsh.defaultInstallDir;
        const installer = join(repoRoot, 'scripts', 'install-dsh-runtime.mjs');
        const nodeExe = platformInfo.node.activeExec || process.execPath;

        // Run installer script
        const result = await spawnSubprocess(nodeExe, [installer, dshTargetDir], {
          cwd: repoRoot,
          env: childEnv,
          timeoutMs: 180_000,
          signal: ctx.signal,
        });

        if (result.exitCode === 0) {
          const lines = result.stdout.trim().split(/\r?\n/).filter(Boolean);
          const entry = lines[lines.length - 1];
          if (entry && existsSync(entry)) {
            ctx.dshEntry = entry;
            childEnv.NEXAR_DSH_ENTRY = entry;
          }
        }
        return result;
      },
      timeoutMs: 180_000,
      required: true,
    },
    {
      id: 'format-check',
      name: 'Prettier formatting check',
      command: [pnpmCmd, 'format:check'],
      timeoutMs: 120_000,
      required: true,
      env: childEnv,
    },
    {
      id: 'lint',
      name: 'ESLint static analysis',
      command: [pnpmCmd, 'lint'],
      timeoutMs: 360_000,
      required: true,
      env: childEnv,
    },
    {
      id: 'boundaries',
      name: 'Package boundaries and secret guard',
      command: [pnpmCmd, 'check:boundaries'],
      timeoutMs: 60_000,
      required: true,
      env: childEnv,
    },
    {
      id: 'typecheck',
      name: 'TypeScript typecheck (project references)',
      command: [pnpmCmd, 'typecheck'],
      timeoutMs: 300_000,
      required: true,
      env: childEnv,
    },
    {
      id: 'test-offline',
      name: 'Offline unit & integration test suite (with DSH entry)',
      command: testCmdArgs,
      timeoutMs: 600_000,
      required: true,
      env: childEnv,
    },
    {
      id: 'build',
      name: 'Production build (CLI and Desktop)',
      command: [pnpmCmd, 'build'],
      timeoutMs: 300_000,
      required: true,
      env: childEnv,
    },
    {
      id: 'cli-smoke-resources',
      name: 'CLI smoke: resources listing',
      command: [platformInfo.node.activeExec || 'node', 'apps/cli/dist/main.js', 'resources'],
      timeoutMs: 60_000,
      required: true,
      env: childEnv,
    },
    {
      id: 'cli-smoke-run',
      name: 'CLI smoke: offline general run',
      command: [
        platformInfo.node.activeExec || 'node',
        'apps/cli/dist/main.js',
        'run',
        '--kind',
        'general',
        'ci smoke',
      ],
      timeoutMs: 60_000,
      required: true,
      env: childEnv,
    },
    {
      id: 'dsh-context-real',
      name: 'Real DSH offline context & compaction acceptance',
      command: [
        pnpmCmd,
        'exec',
        'vitest',
        'run',
        'apps/desktop/src/main/dsh-cowork.context.real.test.ts',
      ],
      timeoutMs: 120_000,
      required: true,
      env: childEnv,
    },
  ];

  // Windows Desktop stages
  if (isWindows) {
    stages.push({
      id: 'cowork-isolation-wsl',
      name: 'Real isolated Cowork transport, cancellation, sessions and protected context',
      command: [platformInfo.node.activeExec || 'node', 'scripts/verify-cowork-wsl.mjs'],
      timeoutMs: 600_000,
      required: true,
      env: childEnv,
    });
    stages.push({
      id: 'desktop-e2e-source',
      name: 'Desktop E2E (source build with NEXAR_DSH_ENTRY)',
      command: [pnpmCmd, 'desktop:e2e'],
      timeoutMs: 600_000,
      required: true,
      env: childEnv,
    });

    stages.push({
      id: 'desktop-package-win',
      name: 'Package Windows desktop installer (with bundled DSH runtime)',
      customRun: async (ctx) => {
        ctx.packageStartTime = Date.now();
        return spawnSubprocess(pnpmCmd, ['desktop:package:win'], {
          cwd: repoRoot,
          env: childEnv,
          timeoutMs: 1_200_000,
          signal: ctx.signal,
        });
      },
      timeoutMs: 1_200_000,
      required: true,
      env: childEnv,
    });

    stages.push({
      id: 'desktop-e2e-packaged',
      name: 'Packaged Desktop E2E (bundled DSH runtime only, no external entry)',
      customRun: async (ctx) => {
        const pkgInfo = inspectWindowsPackage(repoRoot, {
          minMtimeMs: ctx.packageStartTime,
        });
        if (!pkgInfo) {
          return {
            command: 'pnpm desktop:e2e',
            exitCode: 1,
            signal: null,
            durationMs: 0,
            stdout: '',
            stderr:
              'Package inspection failed: no installer found under release/desktop. Run desktop-package-win first.',
            error: new Error('Package missing'),
          };
        }
        if (pkgInfo.isStale || !pkgInfo.shaMatchesActual) {
          return {
            command: 'pnpm desktop:e2e',
            exitCode: 1,
            signal: null,
            durationMs: 0,
            stdout: '',
            stderr: `Installer artifact rejected: ${pkgInfo.staleReason || 'SHA256 mismatch'}.`,
            error: new Error('Stale installer artifact'),
          };
        }
        if (!pkgInfo.unpackedExists) {
          return {
            command: 'pnpm desktop:e2e',
            exitCode: 1,
            signal: null,
            durationMs: 0,
            stdout: '',
            stderr:
              'Packaged binary not found at release/desktop/win-unpacked/Nexar.exe. Run desktop-package-win first.',
            error: new Error('Packaged executable missing'),
          };
        }
        if (!pkgInfo.bundledDshMatches) {
          return {
            command: 'pnpm desktop:e2e',
            exitCode: 1,
            signal: null,
            durationMs: 0,
            stdout: '',
            stderr: `Bundled DSH runtime validation failed: expected 0.2.0-rc.2, found ${pkgInfo.bundledDshVersion ?? 'missing'}.`,
            error: new Error('Bundled DSH runtime mismatch'),
          };
        }

        const packagedEnv = { ...childEnv };
        packagedEnv.NEXAR_DESKTOP_EXECUTABLE = pkgInfo.unpackedPath;
        delete packagedEnv.NEXAR_DSH_ENTRY;
        delete packagedEnv.NEXAR_DESKTOP_TEST_DSH_ENTRY;

        return spawnSubprocess(pnpmCmd, ['desktop:e2e'], {
          cwd: repoRoot,
          env: packagedEnv,
          timeoutMs: 600_000,
          signal: ctx.signal,
        });
      },
      timeoutMs: 600_000,
      required: true,
    });
  } else if (isLinux) {
    stages.push({
      id: 'desktop-e2e-linux',
      name: 'Desktop E2E under Xvfb (Linux)',
      command: ['xvfb-run', '-a', pnpmCmd, 'desktop:e2e'],
      timeoutMs: 600_000,
      required: true,
      env: childEnv,
    });
  }

  // Linux sandbox validation stage
  stages.push({
    id: 'linux-sandbox',
    name: 'Linux bubblewrap Engineering sandbox validation',
    customRun: async (ctx) => {
      if (isLinux) {
        // Native Linux execution: check bwrap and run sandbox tests
        const result = await spawnSubprocess(
          pnpmCmd,
          [
            'exec',
            'vitest',
            'run',
            'packages/sandbox/src/availability.test.ts',
            'packages/sandbox/src/launcher.integration.test.ts',
          ],
          {
            cwd: repoRoot,
            env: childEnv,
            timeoutMs: 180_000,
            signal: ctx.signal,
          },
        );
        const stats = parseVitestStats(result.stdout);
        if (
          result.exitCode === 0 &&
          (stats.testsSkipped > 0 ||
            stats.testsPassed === 0 ||
            stats.testsTotal !== stats.testsPassed)
        ) {
          return {
            ...result,
            exitCode: 1,
            stderr: `${result.stderr}\nSandbox acceptance requires executed tests with no skips or unclassified outcomes.`,
          };
        }
        return result;
      }
      // On Windows host: report limitation honestly as BLOCKED
      return {
        command: 'linux-sandbox-gate',
        exitCode: 0,
        signal: null,
        durationMs: 0,
        stdout: '',
        stderr:
          'Native Linux bubblewrap sandbox requires Linux kernel with user namespace support; not executable on Windows host.',
        statusOverride: 'BLOCKED',
        failureCategory: 'ENVIRONMENT_UNSUPPORTED',
      };
    },
    timeoutMs: 180_000,
    required: isLinux, // Blocked on Windows, required on Linux
  });

  // Gitleaks security scan
  stages.push({
    id: 'gitleaks-scan',
    name: 'Gitleaks full-history security scan (pinned 8.28.0, redacted)',
    customRun: async (ctx) => {
      const gitleaksBin = platformInfo.gitleaks.execPath || 'gitleaks';
      const args = ['git', '--redact', '--verbose', '--exit-code', '1', '.'];
      return spawnSubprocess(gitleaksBin, args, {
        cwd: repoRoot,
        env: childEnv,
        timeoutMs: 180_000,
        signal: ctx.signal,
      });
    },
    timeoutMs: 180_000,
    required: true,
  });

  return stages;
}

/**
 * Executes a single stage with lifecycle logging and status evaluation.
 */
export async function executeStage(stage, context) {
  const startTime = Date.now();
  const stageRecord = {
    id: stage.id,
    name: stage.name,
    command: '',
    startTime: new Date(startTime).toISOString(),
    durationMs: 0,
    exitCode: null,
    status: 'NOT_RUN', // PASS | FAIL | BLOCKED | SKIPPED
    required: stage.required,
    failureCategory: null,
    logExcerpt: '',
    vitestStats: null,
  };

  try {
    let result;
    if (stage.customRun) {
      result = await stage.customRun(context);
    } else {
      const [cmd, ...args] = stage.command;
      result = await spawnSubprocess(cmd, args, {
        cwd: context.repoRoot,
        env: stage.env || process.env,
        timeoutMs: stage.timeoutMs || 300_000,
        signal: context.signal,
      });
    }

    stageRecord.command = redactSecrets(
      result.command || (stage.command ? stage.command.join(' ') : stage.name),
    );
    stageRecord.exitCode = result.exitCode;
    stageRecord.durationMs = result.durationMs || Date.now() - startTime;

    if (result.timedOut) {
      stageRecord.status = 'FAIL';
      stageRecord.failureCategory = 'TIMEOUT';
    } else if (result.aborted) {
      stageRecord.status = 'FAIL';
      stageRecord.failureCategory = 'CANCELLED';
    } else if (result.statusOverride === 'BLOCKED' && result.exitCode === 0) {
      stageRecord.status = 'BLOCKED';
      stageRecord.failureCategory = result.failureCategory || 'ENVIRONMENT_UNSUPPORTED';
    } else if (result.exitCode === 0 && !result.signal && !result.error) {
      stageRecord.status = 'PASS';
    } else {
      stageRecord.status = 'FAIL';
      stageRecord.failureCategory = 'COMMAND_EXIT_NONZERO';
    }

    // Capture log excerpt
    const combinedOutput = redactSecrets(
      `${result.stdout || ''}\n${result.stderr || ''}\n${result.error?.message || ''}`,
    ).trim();
    const logDir = join(context.repoRoot, '.nexar', 'ci', 'logs');
    mkdirSync(logDir, { recursive: true });
    stageRecord.logPath = join(logDir, `${startTime}-${stage.id.replace(/[^a-z0-9-]/gi, '_')}.log`);
    writeFileSync(stageRecord.logPath, combinedOutput, 'utf8');
    const lines = combinedOutput.split(/\r?\n/).filter(Boolean);
    stageRecord.logExcerpt = lines.slice(-25).join('\n');

    // Parse Vitest statistics if applicable
    if (
      result.stdout &&
      (result.stdout.includes('Test Files') || result.stdout.includes('Tests'))
    ) {
      stageRecord.vitestStats = parseVitestStats(result.stdout);
    }

    if (stage.id === 'test-offline' && stageRecord.status === 'PASS') {
      const reportPath = join(context.repoRoot, '.nexar', 'ci', 'test-offline.json');
      if (statSync(reportPath).mtimeMs < startTime) throw new Error('Vitest JSON report is stale');
      stageRecord.vitestStats = parseVitestJsonStats(JSON.parse(readFileSync(reportPath, 'utf8')));
    }

    return stageRecord;
  } catch (err) {
    stageRecord.durationMs = Date.now() - startTime;
    stageRecord.exitCode = 1;
    stageRecord.status = 'FAIL';
    stageRecord.failureCategory = 'EXECUTION_EXCEPTION';
    stageRecord.logExcerpt = redactSecrets(err.message);
    return stageRecord;
  }
}
