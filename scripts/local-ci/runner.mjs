#!/usr/bin/env node
// Nexar Local CI Orchestrator — Cross-platform validation runner.
import { dirname, resolve } from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { getGitInfo, getPlatformInfo } from './platform.mjs';
import { runPreflight } from './preflight.mjs';
import { executeStage, getStages } from './stages.mjs';
import { generateReports, showLatestReport } from './report.mjs';
import { normalizeWindowsEnv } from './process-util.mjs';

const __dirname = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(__dirname, '..', '..');

function parseArgs() {
  const args = process.argv.slice(2);
  const options = {
    mode: 'quick',
    profile: 'auto',
    allowNodeMismatch: false,
    customNodeBin: null,
    customGitleaksBin: null,
    dshDir: null,
    workers: null,
    help: false,
  };

  for (const arg of args) {
    if (arg === '--help' || arg === '-h') {
      options.help = true;
    } else if (arg.startsWith('--mode=')) {
      options.mode = arg.split('=')[1].toLowerCase();
    } else if (arg.startsWith('--profile=')) {
      options.profile = arg.split('=')[1].toLowerCase();
    } else if (arg === '--allow-node-mismatch') {
      options.allowNodeMismatch = true;
    } else if (arg.startsWith('--node-bin=')) {
      options.customNodeBin = arg.split('=')[1];
    } else if (arg.startsWith('--gitleaks-bin=')) {
      options.customGitleaksBin = arg.split('=')[1];
    } else if (arg.startsWith('--dsh-dir=')) {
      options.dshDir = arg.split('=')[1];
    } else if (arg.startsWith('--workers=')) {
      options.workers = arg.split('=')[1];
    }
  }

  return options;
}

function printHelp() {
  console.log(`
Nexar Local CI Orchestrator

Usage:
  node scripts/local-ci/runner.mjs [options]
  pnpm ci:local:quick
  pnpm ci:local:full
  pnpm ci:local:report

Options:
  --mode=quick|full|report   CI execution mode (default: quick)
  --profile=auto|windows|linux Target profile (default: auto)
  --allow-node-mismatch      Permit exploratory quick runs; cannot establish acceptance
  --node-bin=<path>          Explicit path to verified Node.js binary
  --gitleaks-bin=<path>      Explicit path to verified Gitleaks executable
  --dsh-dir=<path>           Target directory for pinned DSH runtime
  --help, -h                 Show this help message
`);
}

async function main() {
  const options = parseArgs();

  if (options.help) {
    printHelp();
    process.exit(0);
  }

  if (options.mode === 'report') {
    showLatestReport(REPO_ROOT);
    return;
  }

  if (!['quick', 'full'].includes(options.mode)) {
    console.error(`Invalid mode "${options.mode}". Valid modes: quick, full, report`);
    process.exit(1);
  }

  const startTime = Date.now();
  console.log('\n======================================================');
  console.log(`         NEXAR LOCAL CI — ${options.mode.toUpperCase()} VALIDATION`);
  console.log('======================================================\n');

  // Platform and environment inspection
  const platformInfo = getPlatformInfo({
    customNodeBin: options.customNodeBin,
    customGitleaksBin: options.customGitleaksBin,
  });

  // The orchestrator itself must use the selected runtime, not only its stage children.
  const sameExecutable = (a, b) =>
    process.platform === 'win32'
      ? resolve(a).toLowerCase() === resolve(b).toLowerCase()
      : resolve(a) === resolve(b);
  if (
    platformInfo.node.isMatched &&
    !sameExecutable(platformInfo.node.activeExec, process.execPath)
  ) {
    const env = normalizeWindowsEnv({
      ...process.env,
      PATH: `${dirname(platformInfo.node.activeExec)}${process.platform === 'win32' ? ';' : ':'}${process.env.PATH || ''}`,
    });
    const child = spawnSync(platformInfo.node.activeExec, process.argv.slice(1), {
      env,
      stdio: 'inherit',
      windowsHide: true,
    });
    process.exit(child.status ?? 1);
  }

  const gitSummary = platformInfo.git.summary;
  console.log(`Git Baseline:   ${gitSummary} [branch: ${platformInfo.git.branch}]`);
  console.log(
    `Active OS:      ${platformInfo.os.platform} (${platformInfo.os.release}) ${platformInfo.os.arch}`,
  );
  console.log(
    `Active Node:    ${platformInfo.node.activeVersion} (${platformInfo.node.activeExec})`,
  );
  console.log(`Active pnpm:    ${platformInfo.pnpm.installedVersion}`);
  console.log(`Target DSH:     ${platformInfo.dsh.package}@${platformInfo.dsh.pinnedVersion}\n`);

  // Environment Preflight
  console.log('--- PHASE 1: ENVIRONMENT PREFLIGHT ---');
  const preflightResult = await runPreflight(platformInfo, {
    mode: options.mode,
    allowNodeMismatch: options.allowNodeMismatch,
  });

  for (const c of preflightResult.checks) {
    const icon =
      c.status === 'PASS' ? '✓' : c.status === 'WARN' ? '⚠' : c.status === 'SKIPPED' ? '⏭' : '✗';
    console.log(`[${icon} ${c.status.padEnd(7)}] ${c.name}: ${c.message}`);
  }

  if (preflightResult.diagnostics.length > 0) {
    console.log('\nPreflight Diagnostics:');
    for (const d of preflightResult.diagnostics) {
      console.log(`  ${d}`);
    }
  }

  if (!preflightResult.ok) {
    console.error('\n❌ Preflight failed. Local CI stopping with fail-closed verdict.');
    const durationMs = Date.now() - startTime;
    generateReports({
      mode: options.mode,
      profile: options.profile,
      platformInfo,
      preflightResult,
      stageResults: [],
      startTime,
      endTime: Date.now(),
      durationMs,
    });
    process.exit(1);
  }

  console.log('\n--- PHASE 2: VALIDATION GATES ---');
  const abortController = new AbortController();
  const handleExitSignal = () => {
    console.log('\nCancellation received. Terminating running stages...');
    abortController.abort();
  };
  process.on('SIGINT', handleExitSignal);
  process.on('SIGTERM', handleExitSignal);

  const context = {
    repoRoot: REPO_ROOT,
    signal: abortController.signal,
    dshEntry: platformInfo.dsh.cachedEntry,
  };

  const stages = getStages(options.mode, platformInfo, {
    dshDir: options.dshDir,
    workers: options.workers,
  });

  const stageResults = [];
  let stopRemaining = false;

  for (let i = 0; i < stages.length; i++) {
    const stage = stages[i];

    if (stopRemaining) {
      stageResults.push({
        id: stage.id,
        name: stage.name,
        command: '',
        startTime: new Date().toISOString(),
        durationMs: 0,
        exitCode: null,
        status: 'SKIPPED',
        required: stage.required,
        failureCategory: 'SKIPPED_DUE_TO_PREVIOUS_FAILURE',
        logExcerpt: 'Skipped due to preceding mandatory stage failure.',
        vitestStats: null,
      });
      console.log(`[⏭ SKIPPED ] [${i + 1}/${stages.length}] ${stage.name}`);
      continue;
    }

    process.stdout.write(`[⏳ RUNNING ] [${i + 1}/${stages.length}] ${stage.name}... `);
    const result = await executeStage(stage, context);
    stageResults.push(result);

    const dur = `${(result.durationMs / 1000).toFixed(2)}s`;
    if (result.status === 'PASS') {
      console.log(`\r[✓ PASS    ] [${i + 1}/${stages.length}] ${stage.name} (${dur})`);
    } else if (result.status === 'BLOCKED') {
      console.log(`\r[⚠ BLOCKED ] [${i + 1}/${stages.length}] ${stage.name} (${dur})`);
      if (stage.required) stopRemaining = true;
    } else {
      console.log(`\r[✗ FAIL    ] [${i + 1}/${stages.length}] ${stage.name} (${dur})`);
      if (stage.required) {
        console.error(
          `\nMandatory stage "${stage.name}" failed with exit code ${result.exitCode}.`,
        );
        if (result.logExcerpt) {
          console.error('--- Failure Excerpt ---');
          console.error(result.logExcerpt);
          console.error('-----------------------');
        }
        stopRemaining = true;
      }
    }
  }

  process.removeListener('SIGINT', handleExitSignal);
  process.removeListener('SIGTERM', handleExitSignal);

  const durationMs = Date.now() - startTime;
  console.log('\n--- PHASE 3: REPORT GENERATION ---');
  const reportOutputs = generateReports({
    mode: options.mode,
    profile: options.profile,
    platformInfo,
    preflightResult,
    stageResults,
    startTime,
    endTime: Date.now(),
    durationMs,
    sourceEnd: getGitInfo(REPO_ROOT),
    interrupted: abortController.signal.aborted,
  });

  console.log(`Final Status:   ${reportOutputs.finalStatus}`);
  console.log(`Total Time:     ${(durationMs / 1000).toFixed(2)}s`);
  console.log(`JSON Report:    ${reportOutputs.latestJsonPath}`);
  console.log(`Markdown:       ${reportOutputs.latestMdPath}\n`);

  if (reportOutputs.finalStatus.includes('PASS')) {
    console.log(`🎉 ${reportOutputs.finalStatus}`);
    process.exit(0);
  } else if (reportOutputs.finalStatus.includes('BLOCKED')) {
    console.log(`⚠️ ${reportOutputs.finalStatus}`);
    process.exit(2);
  } else {
    console.error(`💥 ${reportOutputs.finalStatus}`);
    process.exit(1);
  }
}

main().catch((err) => {
  console.error('Unhandled Local CI error:', err);
  process.exit(1);
});
