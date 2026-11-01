// Structured report generation (JSON + Markdown) and terminal presentation for Nexar Local CI.
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { getGitInfo, isSupportedNode } from './platform.mjs';
import { inspectWindowsPackage } from './stages.mjs';

export const EXPECTED_STAGES = {
  quick: ['format-check', 'lint', 'boundaries', 'typecheck', 'test-offline'],
  windows_full: [
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
  ],
  linux_full: [
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
  ],
};

/**
 * Computes overall validation verdict against deterministic stage manifests.
 */
export function computeFinalStatus(mode, stageResults = [], options = {}) {
  const platform = options.platform || process.platform;
  const isWsl = Boolean(options.isWsl);

  if (!stageResults || stageResults.length === 0) {
    if (mode === 'quick') return 'LOCAL_CI_QUICK_FAIL';
    return platform === 'win32' ? 'NEXAR_WINDOWS_FULL_FAIL' : 'NEXAR_LINUX_FULL_FAIL';
  }

  const hasFailures = stageResults.some((s) => s.status === 'FAIL');
  const hasBlocked = stageResults.some((s) => s.status === 'BLOCKED' && s.required);

  if (mode === 'quick') {
    const expected = EXPECTED_STAGES.quick;
    const missing = expected.some(
      (id) => !stageResults.some((s) => s.id === id && s.status === 'PASS'),
    );
    if (missing || hasFailures || hasBlocked) {
      return 'LOCAL_CI_QUICK_FAIL';
    }
    return 'LOCAL_CI_QUICK_PASS';
  }

  // Full mode
  const isWindows = platform === 'win32';
  const expectedRequired = isWindows ? EXPECTED_STAGES.windows_full : EXPECTED_STAGES.linux_full;

  if (hasFailures) {
    return isWindows ? 'NEXAR_WINDOWS_FULL_FAIL' : 'NEXAR_LINUX_FULL_FAIL';
  }

  if (hasBlocked) {
    return isWindows ? 'NEXAR_WINDOWS_FULL_BLOCKED' : 'NEXAR_LINUX_FULL_BLOCKED';
  }

  // Verify that every required stage is present and marked PASS
  for (const reqId of expectedRequired) {
    const found = stageResults.find((s) => s.id === reqId);
    if (!found || found.status !== 'PASS') {
      if (found && found.status === 'BLOCKED') {
        return isWindows ? 'NEXAR_WINDOWS_FULL_BLOCKED' : 'NEXAR_LINUX_FULL_BLOCKED';
      }
      return isWindows ? 'NEXAR_WINDOWS_FULL_FAIL' : 'NEXAR_LINUX_FULL_FAIL';
    }
  }

  if (isWindows) {
    return 'NEXAR_WINDOWS_FULL_PASS';
  }
  return isWsl ? 'NEXAR_LINUX_WSL2_PASS' : 'NEXAR_LINUX_FULL_PASS';
}

/**
 * Aggregates and verifies cross-platform evidence across matching clean runs.
 */
export function aggregateCrossPlatformEvidence(windowsReport, linuxReport) {
  const reasons = [];

  if (!windowsReport) {
    reasons.push('Windows validation report is missing');
  }
  if (!linuxReport) {
    reasons.push('Linux validation report is missing');
  }
  if (reasons.length > 0) {
    return {
      verdict: 'NEXAR_CROSS_PLATFORM_ACCEPTANCE_INCOMPLETE',
      reasons,
      matchedCommit: null,
      details: null,
    };
  }

  const winCommit = windowsReport.metadata?.git?.commit;
  const linCommit = linuxReport.metadata?.git?.commit;

  if (
    !/^[a-f0-9]{40}$/.test(winCommit || '') ||
    !/^[a-f0-9]{40}$/.test(linCommit || '') ||
    winCommit !== linCommit
  ) {
    reasons.push(
      `Commit mismatch: Windows evaluated ${winCommit ?? 'unknown'}, Linux evaluated ${linCommit ?? 'unknown'}`,
    );
  }

  if (windowsReport.metadata?.git?.isDirty) {
    reasons.push(
      `Windows tree was dirty (fingerprint: ${windowsReport.metadata.git.dirtyFingerprint})`,
    );
  }
  if (linuxReport.metadata?.git?.isDirty) {
    reasons.push(
      `Linux tree was dirty (fingerprint: ${linuxReport.metadata.git.dirtyFingerprint})`,
    );
  }

  if (windowsReport.finalStatus !== 'NEXAR_WINDOWS_FULL_PASS') {
    reasons.push(
      `Windows verdict is ${windowsReport.finalStatus}, expected NEXAR_WINDOWS_FULL_PASS`,
    );
  }

  if (windowsReport.metadata?.os?.platform !== 'win32')
    reasons.push('Windows OS identity is missing or invalid');
  const linuxOs = linuxReport.metadata?.os;
  if (
    linuxOs?.platform !== 'linux' ||
    linuxOs.isWsl !== false ||
    /microsoft|wsl/i.test(linuxOs.release || '')
  ) {
    reasons.push('Native Ubuntu evidence is required; WSL validation is separate');
  }
  const validLinuxVerdicts = ['NEXAR_LINUX_FULL_PASS'];
  if (!validLinuxVerdicts.includes(linuxReport.finalStatus)) {
    reasons.push(`Linux verdict is ${linuxReport.finalStatus}, expected NEXAR_LINUX_FULL_PASS`);
  }

  if (
    windowsReport.metadata?.dsh?.version !== '0.2.1-rc.5' ||
    linuxReport.metadata?.dsh?.version !== '0.2.1-rc.5'
  ) {
    reasons.push('DSH runtime version is not pinned 0.2.1-rc.5 on both platforms');
  }

  if (reasons.length > 0) {
    return {
      verdict: 'NEXAR_CROSS_PLATFORM_ACCEPTANCE_INCOMPLETE',
      reasons,
      matchedCommit: winCommit === linCommit ? winCommit : null,
      details: {
        windowsStatus: windowsReport.finalStatus,
        linuxStatus: linuxReport.finalStatus,
      },
    };
  }

  return {
    verdict: 'NEXAR_CROSS_PLATFORM_ACCEPTANCE_PASS',
    reasons: [],
    matchedCommit: winCommit,
    details: {
      windowsStatus: windowsReport.finalStatus,
      linuxStatus: linuxReport.finalStatus,
      linuxPlatform:
        linuxReport.finalStatus === 'NEXAR_LINUX_WSL2_PASS' ? 'WSL2 Ubuntu' : 'Native Ubuntu',
      evaluatedCommit: winCommit,
    },
  };
}

/**
 * Extracts per-stage executed test attempts. Identities may overlap across stages.
 */
export function extractStageTestMetrics(stageResults) {
  const metrics = [];
  for (const s of stageResults) {
    if (s.vitestStats) {
      metrics.push({
        stageId: s.id,
        stageName: s.name,
        testFilesPassed: s.vitestStats.testFilesPassed,
        testFilesTotal: s.vitestStats.testFilesTotal,
        testsPassed: s.vitestStats.testsPassed,
        testsSkipped: s.vitestStats.testsSkipped,
        testsFailed: s.vitestStats.testsFailed,
        testsTotal: s.vitestStats.testsTotal,
        testsPending: s.vitestStats.testsPending || 0,
        testsTodo: s.vitestStats.testsTodo || 0,
        testsUnclassified: s.vitestStats.testsUnclassified || 0,
      });
    }
  }
  return metrics;
}

/**
 * Aggregates test counts across all stages (for compatibility).
 */
export function aggregateTestCounts(stageResults) {
  const totals = {
    testFilesPassed: 0,
    testFilesFailed: 0,
    testFilesTotal: 0,
    testsPassed: 0,
    testsFailed: 0,
    testsSkipped: 0,
    testsTotal: 0,
  };

  for (const s of stageResults) {
    if (s.vitestStats) {
      totals.testFilesPassed += s.vitestStats.testFilesPassed || 0;
      totals.testFilesFailed += s.vitestStats.testFilesFailed || 0;
      totals.testFilesTotal += s.vitestStats.testFilesTotal || 0;
      totals.testsPassed += s.vitestStats.testsPassed || 0;
      totals.testsFailed += s.vitestStats.testsFailed || 0;
      totals.testsSkipped += s.vitestStats.testsSkipped || 0;
      totals.testsTotal += s.vitestStats.testsTotal || 0;
      totals.testsPending = (totals.testsPending || 0) + (s.vitestStats.testsPending || 0);
      totals.testsTodo = (totals.testsTodo || 0) + (s.vitestStats.testsTodo || 0);
      totals.testsUnclassified =
        (totals.testsUnclassified || 0) + (s.vitestStats.testsUnclassified || 0);
    }
  }

  return totals;
}

/**
 * Generates both JSON and Markdown validation reports.
 */
export function sourceIdentityMatches(before, after) {
  return Boolean(
    before &&
    after &&
    /^[a-f0-9]{40}$/.test(before.commit) &&
    before.commit === after.commit &&
    before.tree === after.tree &&
    before.isDirty === after.isDirty &&
    (!before.isDirty ||
      (/^[a-f0-9]{64}$/.test(before.dirtyFingerprint || '') &&
        before.dirtyFingerprint === after.dirtyFingerprint)) &&
    !before.error &&
    !after.error,
  );
}

export function generateReports(runData) {
  const { mode, profile, platformInfo, preflightResult, stageResults, startTime, durationMs } =
    runData;

  const sourceEnd = runData.sourceEnd || getGitInfo(platformInfo.repoRoot);
  const sourceStable = sourceIdentityMatches(platformInfo.git, sourceEnd);
  const acceptanceEligible =
    preflightResult.ok &&
    !runData.interrupted &&
    sourceStable &&
    isSupportedNode(platformInfo.node.activeVersion, platformInfo.node.pinnedVersion);
  const finalStatus = computeFinalStatus(mode, acceptanceEligible ? stageResults : [], {
    platform: platformInfo.os.platform,
    isWsl: platformInfo.os.isWsl,
  });
  const testTotals = aggregateTestCounts(stageResults);
  const stageTestMetrics = extractStageTestMetrics(stageResults);
  const packageArtifacts = inspectWindowsPackage(platformInfo.repoRoot);

  const reportObject = {
    schemaVersion: '1.0.0',
    finalStatus,
    mode,
    profile,
    timestamp: new Date(startTime).toISOString(),
    durationSeconds: parseFloat((durationMs / 1000).toFixed(2)),
    metadata: {
      repository: 'mohmedhat797/Nexar-Ai',
      git: platformInfo.git,
      sourceEnd,
      sourceStable,
      os: platformInfo.os,
      node: {
        version: platformInfo.node.activeVersion,
        execPath: platformInfo.node.activeExec,
        pinnedMajor: platformInfo.node.pinnedMajor,
        pinnedVersion: platformInfo.node.pinnedVersion,
        source: platformInfo.node.source,
      },
      pnpm: {
        version: platformInfo.pnpm.installedVersion,
        expected: platformInfo.pnpm.expectedVersion,
      },
      dsh: {
        package: platformInfo.dsh.package,
        version: platformInfo.dsh.pinnedVersion,
        lockMatches: platformInfo.dsh.lockMatches,
      },
      gitleaks: {
        version: platformInfo.gitleaks.installedVersion,
        execPath: platformInfo.gitleaks.execPath,
      },
    },
    preflight: preflightResult,
    stages: stageResults,
    testTotals,
    stageTestMetrics,
    packageArtifacts,
  };

  // Ensure output directory exists
  const reportsDir = join(platformInfo.repoRoot, '.nexar', 'ci', 'reports');
  mkdirSync(reportsDir, { recursive: true });

  const safeTimestamp = new Date(startTime).toISOString().replace(/[:.]/g, '-');
  const jsonFilename = `report-${safeTimestamp}.json`;
  const mdFilename = `report-${safeTimestamp}.md`;

  const jsonPath = join(reportsDir, jsonFilename);
  const mdPath = join(reportsDir, mdFilename);
  const latestJsonPath = join(reportsDir, 'latest.json');
  const latestMdPath = join(reportsDir, 'latest.md');

  // Markdown rendering
  const mdContent = renderMarkdownReport(reportObject);

  writeFileSync(jsonPath, JSON.stringify(reportObject, null, 2), 'utf8');
  writeFileSync(latestJsonPath, JSON.stringify(reportObject, null, 2), 'utf8');
  writeFileSync(mdPath, mdContent, 'utf8');
  writeFileSync(latestMdPath, mdContent, 'utf8');

  return {
    finalStatus,
    reportObject,
    jsonPath,
    mdPath,
    latestJsonPath,
    latestMdPath,
  };
}

/**
 * Formats Markdown report.
 */
function renderMarkdownReport(data) {
  const m = data.metadata;
  const statusEmoji = data.finalStatus.includes('PASS')
    ? '✅'
    : data.finalStatus.includes('BLOCKED')
      ? '⚠️'
      : '❌';

  let md = `# Nexar Local CI Verification Report\n\n`;
  md += `**Final Verdict:** \`${data.finalStatus}\` ${statusEmoji}\n\n`;
  md += `- **Mode:** \`${data.mode}\`\n`;
  md += `- **Profile:** \`${data.profile}\`\n`;
  md += `- **Timestamp:** ${data.timestamp}\n`;
  md += `- **Total Duration:** ${data.durationSeconds} s\n`;
  md += `- **Repository:** ${m.repository}\n`;
  md += `- **Branch:** \`${m.git.branch}\`\n`;
  md += `- **Commit SHA:** \`${m.git.commit}\`\n`;
  md += `- **Working Tree:** ${m.git.isDirty ? `⚠️ Dirty (fingerprint: \`${m.git.dirtyFingerprint}\`)` : 'Clean'}\n\n`;

  md += `## 1. Environment Metadata\n\n`;
  md += `| Component | Active Value | Expected / Pin | Status |\n`;
  md += `| --- | --- | --- | --- |\n`;
  md += `| OS | ${m.os.platform} (${m.os.release}) ${m.os.arch} | Windows / Linux | Verified |\n`;
  md += `| Node.js | \`${m.node.version}\` (${m.node.execPath}) | \`v${m.node.pinnedVersion}\` (.nvmrc) | ${isSupportedNode(m.node.version, m.node.pinnedVersion) ? 'PASS' : 'WARN'} |\n`;
  md += `| pnpm | \`${m.pnpm.version}\` | \`${m.pnpm.expected}\` | ${m.pnpm.version === m.pnpm.expected ? 'PASS' : 'FAIL'} |\n`;
  md += `| DSH Runtime | \`${m.dsh.package}@${m.dsh.version}\` | \`0.2.1-rc.5\` | ${m.dsh.lockMatches ? 'PASS' : 'FAIL'} |\n`;
  md += `| Gitleaks | \`${m.gitleaks.version ?? 'none'}\` | \`8.28.0\` | ${m.gitleaks.version === '8.28.0' ? 'PASS' : 'BLOCKED'} |\n\n`;

  md += `## 2. Preflight Gates\n\n`;
  md += `| Gate | Status | Message |\n`;
  md += `| --- | --- | --- |\n`;
  for (const c of data.preflight.checks) {
    const s =
      c.status === 'PASS'
        ? '✅ PASS'
        : c.status === 'WARN'
          ? '⚠️ WARN'
          : c.status === 'SKIPPED'
            ? '⏭️ SKIPPED'
            : '❌ FAIL';
    md += `| \`${c.name}\` | ${s} | ${c.message} |\n`;
  }
  md += `\n`;

  md += `## 3. CI Stage Breakdown\n\n`;
  md += `| Stage | Status | Duration | Exit Code | Details |\n`;
  md += `| --- | --- | --- | --- | --- |\n`;
  for (const s of data.stages) {
    const icon =
      s.status === 'PASS'
        ? '✅ PASS'
        : s.status === 'BLOCKED'
          ? '⚠️ BLOCKED'
          : s.status === 'SKIPPED'
            ? '⏭️ SKIPPED'
            : '❌ FAIL';
    const dur = `${(s.durationMs / 1000).toFixed(2)}s`;
    const details = s.vitestStats
      ? `${s.vitestStats.testsPassed} tests passed (${s.vitestStats.testsSkipped} skipped)`
      : s.failureCategory
        ? `Reason: ${s.failureCategory}`
        : 'Done';
    md += `| **${s.name}** | ${icon} | ${dur} | \`${s.exitCode ?? '-'}\` | ${details} |\n`;
  }
  md += `\n`;

  if (data.stageTestMetrics && data.stageTestMetrics.length > 0) {
    md += `## 4. Test Suite Summary by Stage\n\n`;
    md += `Executed attempts overlap across stages; this is not a unique-test total.\n\n`;
    md += `| Stage | Files Passed / Total | Passed | Skipped | Pending | Todo | Unclassified | Failed | Total |\n`;
    md += `| --- | --- | --- | --- | --- | --- | --- | --- | --- |\n`;
    for (const t of data.stageTestMetrics) {
      md += `| **${t.stageName}** | ${t.testFilesPassed}/${t.testFilesTotal} | ${t.testsPassed} | ${t.testsSkipped} | ${t.testsPending} | ${t.testsTodo} | ${t.testsUnclassified} | ${t.testsFailed} | ${t.testsTotal} |\n`;
    }
    md += `\n`;
  } else if (data.testTotals.testsTotal > 0) {
    md += `## 4. Test Suite Summary\n\n`;
    md += `- **Tests Passed:** ${data.testTotals.testsPassed}\n`;
    md += `- **Tests Skipped:** ${data.testTotals.testsSkipped}\n`;
    md += `- **Tests Failed:** ${data.testTotals.testsFailed}\n\n`;
  }

  if (data.packageArtifacts) {
    md += `## 5. Windows Desktop Package\n\n`;
    md += `- **Installer Name:** \`${data.packageArtifacts.installerName}\`\n`;
    md += `- **Size:** ${(data.packageArtifacts.sizeBytes / (1024 * 1024)).toFixed(2)} MB (${data.packageArtifacts.sizeBytes} bytes)\n`;
    md += `- **SHA256:** \`${data.packageArtifacts.sha256}\` (Byte match: ${data.packageArtifacts.shaMatchesActual ? 'VERIFIED' : 'UNVERIFIED'})\n`;
    md += `- **Signature:** ${data.packageArtifacts.signed ? 'Signed' : `NotSigned (${data.packageArtifacts.signatureStatus ?? 'per-user installer'})`}\n`;
    md += `- **Bundled DSH Runtime:** ${data.packageArtifacts.bundledDshMatches ? 'Verified shipped 0.2.1-rc.5 under resources' : data.packageArtifacts.bundledDshExists ? `Mismatched version (${data.packageArtifacts.bundledDshVersion})` : 'Not found under resources'}\n\n`;
  }

  md += `## 6. Parity with GitHub CI\n\n`;
  md += `| Capability | GitHub Actions | Nexar Local CI | Coverage Status |\n`;
  md += `| --- | --- | --- | --- |\n`;
  md += `| Format & Lint & Types | Hosted Ubuntu / Windows | Local Node 22 | Equivalent command coverage (environment differs) |\n`;
  md += `| Boundary & Secrets Guard | Hosted Ubuntu / Windows | Local runner | Equivalent command coverage |\n`;
  md += `| Offline Test Suite | Hosted Ubuntu / Windows | Local runner | Equivalent command coverage |\n`;
  md += `| Production Build | Hosted Ubuntu / Windows | Local runner | Equivalent command coverage |\n`;
  md += `| CLI Smoke | Hosted Ubuntu / Windows | Local runner | Equivalent command coverage |\n`;
  md += `| Desktop E2E (Windows) | Hosted Windows runner | Local Windows host | See actual desktop-e2e-source stage status |\n`;
  md += `| Desktop Packaging (Windows) | Hosted Windows runner | Local Windows host | See actual desktop-package-win stage status |\n`;
  md += `| Packaged Desktop E2E | Hosted Windows runner | Local Windows host | See actual desktop-e2e-packaged stage status |\n`;
  md += `| Gitleaks Full Scan | Hosted Ubuntu runner | Local Gitleaks 8.28.0 | Equivalent command coverage |\n`;
  md += `| Linux bwrap Sandbox | Hosted Ubuntu runner | Linux host / BLOCKED on Windows | Requires actual linux-sandbox stage PASS; WSL is separate |\n\n`;

  md += `---\n*Generated automatically by Nexar Local CI Orchestrator*\n`;
  return md;
}

/**
 * Displays latest report on terminal.
 */
export function showLatestReport(repoRoot) {
  const latestJsonPath = join(repoRoot, '.nexar', 'ci', 'reports', 'latest.json');
  if (!existsSync(latestJsonPath)) {
    console.error('No previous local CI report found at .nexar/ci/reports/latest.json');
    console.error('Run `pnpm ci:local:quick` or `pnpm ci:local:full` first.');
    process.exit(1);
  }

  const report = JSON.parse(readFileSync(latestJsonPath, 'utf8'));
  const currentGit = getGitInfo(repoRoot);

  console.log('\n======================================================');
  console.log('             NEXAR LOCAL CI LATEST REPORT             ');
  console.log('======================================================\n');
  console.log(`Final Verdict:      ${report.finalStatus}`);
  console.log(`Mode:               ${report.mode}`);
  console.log(`Execution Time:     ${report.timestamp} (${report.durationSeconds}s)`);
  console.log(`Report Commit:      ${report.metadata.git.commit}`);
  console.log(`Current Git HEAD:   ${currentGit.commit}`);

  const sourceMatches = sourceIdentityMatches(report.metadata.git, currentGit);
  if (!sourceMatches) {
    console.log('\n⚠️  WARNING: Report was generated for a DIFFERENT commit than current HEAD!');
    console.log('A report from another commit cannot establish acceptance for the current tree.\n');
  }

  if (currentGit.isDirty) {
    console.log(
      `⚠️  WARNING: Working tree is currently DIRTY (fingerprint: ${currentGit.dirtyFingerprint}).\n`,
    );
  }

  console.log('---------------- STAGES BREAKDOWN ----------------');
  for (const s of report.stages) {
    const symbol =
      s.status === 'PASS' ? '✓ PASS   ' : s.status === 'BLOCKED' ? '⚠ BLOCKED' : '✗ FAIL   ';
    console.log(
      `[${symbol}] ${(s.name + ' '.repeat(45)).substring(0, 45)} ${(s.durationMs / 1000).toFixed(2)}s`,
    );
  }
  console.log('--------------------------------------------------\n');

  if (report.testTotals?.testsTotal > 0) {
    console.log(
      `Tests Summary: ${report.testTotals.testsPassed} passed, ${report.testTotals.testsSkipped} skipped, ${report.testTotals.testsFailed} failed`,
    );
  }
  if (report.packageArtifacts) {
    console.log(
      `Windows Package: ${report.packageArtifacts.installerName} (${(report.packageArtifacts.sizeBytes / (1024 * 1024)).toFixed(2)} MB)`,
    );
    console.log(`SHA256:          ${report.packageArtifacts.sha256}`);
  }
  console.log('\nFull Markdown report: .nexar/ci/reports/latest.md\n');

  const exitCode = !sourceMatches
    ? 1
    : report.finalStatus.includes('PASS')
      ? 0
      : report.finalStatus.includes('BLOCKED')
        ? 2
        : 1;
  process.exit(exitCode);
}
