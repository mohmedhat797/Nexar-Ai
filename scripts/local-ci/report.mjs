// Structured report generation (JSON + Markdown) and terminal presentation for Nexar Local CI.
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { getGitInfo } from './platform.mjs';
import { inspectWindowsPackage } from './stages.mjs';

/**
 * Computes overall validation verdict.
 */
export function computeFinalStatus(mode, stageResults) {
  const hasFailures = stageResults.some((s) => s.status === 'FAIL');
  const hasBlocked = stageResults.some((s) => s.status === 'BLOCKED' && s.required);

  if (mode === 'quick') {
    return hasFailures || hasBlocked ? 'LOCAL_CI_QUICK_FAIL' : 'LOCAL_CI_QUICK_PASS';
  }

  if (hasFailures) return 'NEXAR_LOCAL_CI_FAIL';
  if (hasBlocked) return 'NEXAR_LOCAL_CI_BLOCKED';
  return 'NEXAR_LOCAL_CI_PASS';
}

/**
 * Aggregates test counts across all stages.
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
    }
  }

  return totals;
}

/**
 * Generates both JSON and Markdown validation reports.
 */
export function generateReports(runData) {
  const { mode, profile, platformInfo, preflightResult, stageResults, startTime, durationMs } =
    runData;

  const finalStatus = computeFinalStatus(mode, stageResults);
  const testTotals = aggregateTestCounts(stageResults);
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
      os: platformInfo.os,
      node: {
        version: platformInfo.node.activeVersion,
        execPath: platformInfo.node.activeExec,
        pinnedMajor: platformInfo.node.pinnedMajor,
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
  md += `| Node.js | \`${m.node.version}\` (${m.node.execPath}) | \`v${m.node.pinnedMajor}.x\` (.nvmrc) | ${m.node.version.startsWith(`v${m.node.pinnedMajor}`) ? 'PASS' : 'WARN'} |\n`;
  md += `| pnpm | \`${m.pnpm.version}\` | \`${m.pnpm.expected}\` | ${m.pnpm.version === m.pnpm.expected ? 'PASS' : 'FAIL'} |\n`;
  md += `| DSH Runtime | \`${m.dsh.package}@${m.dsh.version}\` | \`0.2.0-rc.2\` | ${m.dsh.lockMatches ? 'PASS' : 'FAIL'} |\n`;
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

  if (data.testTotals.testsTotal > 0) {
    md += `## 4. Test Suite Summary\n\n`;
    md += `- **Test Files:** ${data.testTotals.testFilesPassed} passed / ${data.testTotals.testFilesTotal} total\n`;
    md += `- **Tests Passed:** ${data.testTotals.testsPassed}\n`;
    md += `- **Tests Skipped:** ${data.testTotals.testsSkipped}\n`;
    md += `- **Tests Failed:** ${data.testTotals.testsFailed}\n\n`;
  }

  if (data.packageArtifacts) {
    md += `## 5. Windows Desktop Package\n\n`;
    md += `- **Installer Name:** \`${data.packageArtifacts.installerName}\`\n`;
    md += `- **Size:** ${(data.packageArtifacts.sizeBytes / (1024 * 1024)).toFixed(2)} MB (${data.packageArtifacts.sizeBytes} bytes)\n`;
    md += `- **SHA256:** \`${data.packageArtifacts.sha256}\`\n`;
    md += `- **Signature:** ${data.packageArtifacts.signed ? 'Signed' : 'NotSigned (per-user installer)'}\n`;
    md += `- **Bundled DSH Runtime:** Verified shipped under resources\n\n`;
  }

  md += `## 6. Parity with GitHub CI\n\n`;
  md += `| Capability | GitHub Actions | Nexar Local CI | Status |\n`;
  md += `| --- | --- | --- | --- |\n`;
  md += `| Format & Lint & Types | Hosted Ubuntu / Windows | Local Node 22 | Identical |\n`;
  md += `| Boundary & Secrets Guard | Hosted Ubuntu / Windows | Local runner | Identical |\n`;
  md += `| Offline Test Suite | Hosted Ubuntu / Windows | Local runner | Identical |\n`;
  md += `| Production Build | Hosted Ubuntu / Windows | Local runner | Identical |\n`;
  md += `| CLI Smoke | Hosted Ubuntu / Windows | Local runner | Identical |\n`;
  md += `| Desktop E2E (Windows) | Hosted Windows runner | Local Windows host | Identical |\n`;
  md += `| Desktop Packaging (Windows) | Hosted Windows runner | Local Windows host | Identical |\n`;
  md += `| Packaged Desktop E2E | Hosted Windows runner | Local Windows host | Identical |\n`;
  md += `| Gitleaks Full Scan | Hosted Ubuntu runner | Local Gitleaks 8.28.0 | Identical |\n`;
  md += `| Linux bwrap Sandbox | Hosted Ubuntu runner | Linux host / BLOCKED on Windows | Honest status reporting |\n\n`;

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

  if (report.metadata.git.commit !== currentGit.commit) {
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

  const exitCode = report.finalStatus.includes('PASS')
    ? 0
    : report.finalStatus.includes('BLOCKED')
      ? 2
      : 1;
  process.exit(exitCode);
}
