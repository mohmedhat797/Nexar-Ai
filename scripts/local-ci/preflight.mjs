// Environment preflight verifier for Nexar Local CI.
import { existsSync, writeFileSync, unlinkSync } from 'node:fs';
import os from 'node:os';
import { join } from 'node:path';

/**
 * Runs all mandatory preflight checks before CI stages execute.
 */
export async function runPreflight(platformInfo, options = {}) {
  const { mode = 'quick', allowNodeMismatch = false } = options;

  const checks = [];
  const diagnostics = [];
  let allPassed = true;

  if (mode === 'full') {
    const git = platformInfo.git;
    const clean = Boolean(
      git &&
      /^[a-f0-9]{40}$/.test(git.commit) &&
      /^[a-f0-9]{40}$/.test(git.tree || '') &&
      !git.isDirty &&
      !git.error,
    );
    checks.push({
      name: 'git-clean',
      status: clean ? 'PASS' : 'FAIL',
      message: clean
        ? 'Full acceptance starts from a clean, identified commit and tree'
        : 'Full acceptance requires a clean checkout with a verified commit and tree',
    });
    if (!clean) allPassed = false;
  }

  // 1. Node.js version check
  const nodeInfo = platformInfo.node;
  if (nodeInfo.isMatched) {
    checks.push({
      name: 'node-version',
      status: 'PASS',
      message: `Node.js version matches pinned major: ${nodeInfo.activeVersion} (binary: ${nodeInfo.activeExec})`,
    });
  } else if (allowNodeMismatch && mode !== 'full') {
    checks.push({
      name: 'node-version',
      status: 'WARN',
      message: `Running with non-pinned Node.js: ${nodeInfo.activeVersion} (required: v${nodeInfo.pinnedMajor}.x from .nvmrc). Permitted by --allow-node-mismatch.`,
    });
    diagnostics.push(
      'WARNING: Node.js 24 is associated with native worker 0xC0000409 crashes. Use Node 22 for full acceptance.',
    );
  } else {
    allPassed = false;
    checks.push({
      name: 'node-version',
      status: 'FAIL',
      message: `Node.js mismatch: active ${nodeInfo.activeVersion}, required v${nodeInfo.pinnedMajor}.x (from .nvmrc).`,
    });
    diagnostics.push(
      `Node.js version mismatch: active is ${nodeInfo.activeVersion}, required is v${nodeInfo.pinnedMajor}.x from .nvmrc.\n` +
        `To resolve:\n` +
        `  1. Install or activate Node.js 22.23.3 via nvm/fnm: nvm use 22\n` +
        `  2. Or provide --node-bin=<path-to-node22-exe>\n` +
        `  3. Or set NEXAR_NODE_BIN in your environment.`,
    );
  }

  // 2. pnpm version check
  const pnpmInfo = platformInfo.pnpm;
  if (pnpmInfo.isMatched) {
    checks.push({
      name: 'pnpm-version',
      status: 'PASS',
      message: `pnpm version matches declared manifest: ${pnpmInfo.installedVersion}`,
    });
  } else {
    allPassed = false;
    checks.push({
      name: 'pnpm-version',
      status: 'FAIL',
      message: `pnpm version mismatch: installed ${pnpmInfo.installedVersion ?? 'none'}, expected ${pnpmInfo.expectedVersion}`,
    });
    diagnostics.push(
      `pnpm version ${pnpmInfo.expectedVersion} required. Please run: npm install -g pnpm@${pnpmInfo.expectedVersion}`,
    );
  }

  // 3. Workspace lockfile check
  const lockfilePath = join(platformInfo.repoRoot, 'pnpm-lock.yaml');
  if (existsSync(lockfilePath)) {
    checks.push({
      name: 'workspace-lockfile',
      status: 'PASS',
      message: 'pnpm-lock.yaml is present',
    });
  } else {
    allPassed = false;
    checks.push({
      name: 'workspace-lockfile',
      status: 'FAIL',
      message: 'pnpm-lock.yaml is missing from repository root',
    });
  }

  // 4. DSH runtime pin and lockfile check
  const dshInfo = platformInfo.dsh;
  if (dshInfo.lockMatches) {
    checks.push({
      name: 'dsh-pin-lock',
      status: 'PASS',
      message: `Pinned DSH ${dshInfo.package}@${dshInfo.pinnedVersion} matches lockfile`,
    });
  } else {
    allPassed = false;
    checks.push({
      name: 'dsh-pin-lock',
      status: 'FAIL',
      message: `integrations/deepseek-harness/dsh-runtime.package-lock.json does not match pin ${dshInfo.pinnedVersion}`,
    });
  }

  // 5. Gitleaks check
  const gitleaksInfo = platformInfo.gitleaks;
  if (gitleaksInfo.available && gitleaksInfo.isMatched) {
    checks.push({
      name: 'gitleaks-binary',
      status: 'PASS',
      message: `Gitleaks binary verified: ${gitleaksInfo.installedVersion} (${gitleaksInfo.execPath})`,
    });
  } else if (mode === 'full') {
    allPassed = false;
    checks.push({
      name: 'gitleaks-binary',
      status: 'FAIL',
      message: `Gitleaks 8.28.0 binary not found or version mismatch (${gitleaksInfo.installedVersion ?? 'not found'}). Required for full mode.`,
    });
    diagnostics.push(
      'Gitleaks 8.28.0 is required for full acceptance. Place gitleaks.exe in PATH, .nexar/gitleaks-8.28.0/, or specify --gitleaks-bin.',
    );
  } else {
    checks.push({
      name: 'gitleaks-binary',
      status: 'SKIPPED',
      message: 'Gitleaks scan optional in quick mode',
    });
  }

  // 6. Isolated temporary directory check
  try {
    const testFile = join(os.tmpdir(), `nexar-ci-preflight-${Date.now()}.tmp`);
    writeFileSync(testFile, 'nexar-local-ci-ok', 'utf8');
    unlinkSync(testFile);
    checks.push({
      name: 'temp-directory',
      status: 'PASS',
      message: `Temporary directory is writable (${os.tmpdir()})`,
    });
  } catch (err) {
    allPassed = false;
    checks.push({
      name: 'temp-directory',
      status: 'FAIL',
      message: `Temporary directory write error: ${err.message}`,
    });
  }

  return {
    ok: allPassed,
    checks,
    diagnostics,
  };
}
