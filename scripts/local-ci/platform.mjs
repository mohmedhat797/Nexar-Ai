// Platform, toolchain, and Git environment inspection for Nexar Local CI.
import { execFileSync, spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, readFileSync, realpathSync, statSync } from 'node:fs';
import os from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { normalizeWindowsEnv } from './process-util.mjs';

const __dirname = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(__dirname, '..', '..');

/**
 * Resolves Git repository status and commit metadata.
 */
export function getGitInfo(cwd = REPO_ROOT) {
  try {
    const gitEnv = { ...process.env };
    const gitFilePath = join(cwd, '.git');
    if (process.platform === 'linux' && existsSync(gitFilePath) && statSync(gitFilePath).isFile()) {
      try {
        const content = readFileSync(gitFilePath, 'utf8');
        const match = content.match(/gitdir:\s*([A-Za-z]):[/\\](.+)/);
        if (match) {
          const drive = match[1].toLowerCase();
          const rest = match[2].replace(/\\/g, '/').trim();
          gitEnv.GIT_DIR = `/mnt/${drive}/${rest}`;
          gitEnv.GIT_WORK_TREE = cwd;
        }
      } catch {
        // ignore
      }
    }

    const commit = execFileSync('git', ['rev-parse', 'HEAD'], {
      cwd,
      env: gitEnv,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
    }).trim();

    const tree = execFileSync('git', ['rev-parse', 'HEAD^{tree}'], {
      cwd,
      env: gitEnv,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
    }).trim();

    let branch = 'unknown';
    try {
      branch = execFileSync('git', ['rev-parse', '--abbrev-ref', 'HEAD'], {
        cwd,
        env: gitEnv,
        encoding: 'utf8',
        stdio: ['ignore', 'pipe', 'ignore'],
      }).trim();
    } catch {
      // Detached head or tag
    }

    const porcelain = execFileSync(
      'git',
      ['status', '--porcelain=v1', '-z', '--untracked-files=all'],
      {
        cwd,
        env: gitEnv,
        encoding: 'utf8',
        stdio: ['ignore', 'pipe', 'ignore'],
      },
    );

    const isDirty = porcelain.trim().length > 0;
    let dirtyFingerprint = null;

    if (isDirty) {
      const diff = execFileSync('git', ['diff', '--binary', 'HEAD'], {
        cwd,
        env: gitEnv,
        encoding: 'utf8',
        stdio: ['ignore', 'pipe', 'ignore'],
      });
      const hasher = createHash('sha256');
      hasher.update(porcelain);
      hasher.update(diff);

      // NUL-delimited names preserve spaces, non-ASCII names and nested untracked files.
      // A failed read invalidates the identity rather than silently certifying partial input.
      const untracked = execFileSync('git', ['ls-files', '--others', '--exclude-standard', '-z'], {
        cwd,
        env: gitEnv,
        encoding: 'utf8',
        stdio: ['ignore', 'pipe', 'ignore'],
      });
      for (const name of untracked.split('\0').filter(Boolean).sort()) {
        const bytes = readFileSync(join(cwd, name));
        hasher.update(`${name}\0${bytes.length}\0`);
        hasher.update(bytes);
      }

      dirtyFingerprint = hasher.digest('hex');
    }

    return {
      commit,
      tree,
      branch,
      isDirty,
      dirtyFingerprint,
      summary: `${commit.substring(0, 7)}${isDirty ? ` (dirty:${dirtyFingerprint})` : ''}`,
    };
  } catch (err) {
    return {
      commit: 'unknown',
      tree: 'unknown',
      branch: 'unknown',
      isDirty: false,
      dirtyFingerprint: null,
      summary: 'git-unavailable',
      error: err.message,
    };
  }
}

/**
 * Resolves target Node.js version and finds verified Node installation.
 */
export function readPinnedNodeVersion(repoRoot = REPO_ROOT) {
  const version = readFileSync(join(repoRoot, '.nvmrc'), 'utf8').trim();
  if (!/^[1-9]\d*\.(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)$/.test(version)) {
    throw new Error('.nvmrc must contain one exact Node.js release version');
  }
  return version;
}

export function isSupportedNode(version, pinnedVersion = readPinnedNodeVersion()) {
  return typeof version === 'string' && version.replace(/^v/, '') === pinnedVersion;
}

export function getNodeInfo(customNodeBin = null) {
  const pinnedVersion = readPinnedNodeVersion();
  const pinnedMajor = pinnedVersion.split('.')[0];
  const currentVersion = process.version;
  const currentExec = process.execPath;
  const identity = { currentVersion, currentExec, pinnedMajor, pinnedVersion };
  const probeVersion = (executable) => {
    if (!existsSync(executable)) return null;
    const probe = spawnSync(executable, ['--version'], {
      encoding: 'utf8',
      timeout: 5_000,
      windowsHide: true,
      stdio: ['ignore', 'pipe', 'ignore'],
    });
    return probe.status === 0 ? probe.stdout.trim() : null;
  };

  // An explicit diagnostic override must never silently fall back to another executable.
  const override = customNodeBin ?? process.env.NEXAR_NODE_BIN;
  if (override !== undefined && override !== null) {
    const activeExec = resolve(override);
    const activeVersion = probeVersion(activeExec) ?? 'unavailable';
    const isMatched = isSupportedNode(activeVersion, pinnedVersion);
    return {
      ...identity,
      activeExec: isMatched ? realpathSync(activeExec) : activeExec,
      activeVersion,
      isMatched,
      source: customNodeBin !== null ? 'custom' : 'environment',
    };
  }

  if (isSupportedNode(currentVersion, pinnedVersion)) {
    return {
      ...identity,
      activeExec: currentExec,
      activeVersion: currentVersion,
      isMatched: true,
      source: 'current',
    };
  }

  // Probe candidates if current version does not match
  const distribution = `node-v${pinnedVersion}-${process.platform === 'win32' ? 'win' : 'linux'}-${process.arch}`;
  const candidates = [
    process.platform === 'win32'
      ? join('D:\\Nexar-Toolchains', distribution, 'node.exe')
      : join('/opt', distribution, 'bin', 'node'),
    join(
      REPO_ROOT,
      '.nexar',
      'toolchain',
      'node',
      process.platform === 'win32' ? 'node.exe' : 'bin/node',
    ),
    join(os.homedir(), '.nvm', 'versions', 'node', `v${pinnedVersion}`, 'bin', 'node'),
  ];

  for (const candidate of candidates) {
    const activeVersion = probeVersion(candidate);
    if (isSupportedNode(activeVersion, pinnedVersion)) {
      return {
        ...identity,
        activeExec: realpathSync(candidate),
        activeVersion,
        isMatched: true,
        source: 'candidate',
      };
    }
  }

  return {
    ...identity,
    activeExec: currentExec,
    activeVersion: currentVersion,
    isMatched: false,
    source: 'current-mismatch',
  };
}

/**
 * Resolves pnpm package manager info.
 */
export function getPnpmInfo(nodeExec = process.execPath) {
  let expectedVersion = '10.33.0';
  const pkgJsonPath = join(REPO_ROOT, 'package.json');
  if (existsSync(pkgJsonPath)) {
    try {
      const pkg = JSON.parse(readFileSync(pkgJsonPath, 'utf8'));
      if (pkg.packageManager && pkg.packageManager.startsWith('pnpm@')) {
        expectedVersion = pkg.packageManager.replace('pnpm@', '');
      }
    } catch {
      // fallback
    }
  }

  let installedVersion = null;
  const env = {
    ...process.env,
    PATH: `${dirname(nodeExec)}${process.platform === 'win32' ? ';' : ':'}${process.env.PATH || ''}`,
  };
  const probe =
    process.platform === 'win32'
      ? spawnSync('cmd.exe', ['/d', '/s', '/c', 'pnpm', '-v'], {
          encoding: 'utf8',
          shell: false,
          env: normalizeWindowsEnv(env),
          stdio: ['ignore', 'pipe', 'ignore'],
        })
      : spawnSync('pnpm', ['-v'], {
          encoding: 'utf8',
          shell: false,
          env,
          stdio: ['ignore', 'pipe', 'ignore'],
        });

  if (probe.status === 0) {
    installedVersion = probe.stdout.trim();
  }

  return {
    expectedVersion,
    installedVersion,
    isMatched: installedVersion === expectedVersion,
  };
}

/**
 * Resolves Gitleaks binary location and version.
 */
export function getGitleaksInfo(customGitleaksBin = null) {
  const expectedVersion = '8.28.0';

  const candidates = [
    customGitleaksBin,
    process.env.GITLEAKS_BIN,
    join(
      REPO_ROOT,
      '.nexar',
      'gitleaks',
      process.platform === 'win32' ? 'gitleaks.exe' : 'gitleaks',
    ),
    join(
      REPO_ROOT,
      '.nexar',
      `gitleaks-${expectedVersion}`,
      process.platform === 'win32' ? 'gitleaks.exe' : 'gitleaks',
    ),
    'D:\\Nexar-Toolchains\\gitleaks-8.28.0\\gitleaks.exe',
    'D:\\Nexar-Ai-main\\.nexar\\gitleaks-8.28.0\\gitleaks.exe',
    'gitleaks',
  ].filter(Boolean);

  for (const candidate of candidates) {
    try {
      const probe =
        process.platform === 'win32' && candidate === 'gitleaks'
          ? spawnSync('cmd.exe', ['/d', '/s', '/c', 'gitleaks', 'version'], {
              encoding: 'utf8',
              shell: false,
              stdio: ['ignore', 'pipe', 'ignore'],
            })
          : spawnSync(candidate, ['version'], {
              encoding: 'utf8',
              shell: false,
              stdio: ['ignore', 'pipe', 'ignore'],
            });

      if (probe.status === 0) {
        const ver = probe.stdout.trim();
        return {
          execPath: candidate === 'gitleaks' ? 'gitleaks' : resolve(candidate),
          installedVersion: ver,
          expectedVersion,
          isMatched: ver.includes(expectedVersion),
          available: true,
        };
      }
    } catch {
      // not found or not executable
    }
  }

  return {
    execPath: null,
    installedVersion: null,
    expectedVersion,
    isMatched: false,
    available: false,
  };
}

/**
 * Resolves DeepSeek Harness pinned runtime metadata and existing installations.
 */
export function getDshInfo() {
  const pinPath = join(REPO_ROOT, 'integrations', 'deepseek-harness', 'dsh-runtime.json');
  const lockPath = join(
    REPO_ROOT,
    'integrations',
    'deepseek-harness',
    'dsh-runtime.package-lock.json',
  );

  let pin = { package: '@deepseek-ai/dsh', version: '0.2.1-rc.5' };
  if (existsSync(pinPath)) {
    try {
      pin = JSON.parse(readFileSync(pinPath, 'utf8'));
    } catch {
      // fallback
    }
  }

  let lockMatches = false;
  if (existsSync(lockPath)) {
    try {
      const lock = JSON.parse(readFileSync(lockPath, 'utf8'));
      lockMatches =
        lock.lockfileVersion === 3 &&
        lock.packages?.['']?.dependencies?.[pin.package] === pin.version;
    } catch {
      // invalid lock
    }
  }

  // Check possible cached entries
  const defaultDir = join(REPO_ROOT, '.nexar', 'dsh-runtime');
  let cachedEntry = null;

  if (process.env.NEXAR_DSH_ENTRY && existsSync(process.env.NEXAR_DSH_ENTRY)) {
    cachedEntry = resolve(process.env.NEXAR_DSH_ENTRY);
  } else if (existsSync(defaultDir)) {
    try {
      const pkgPath = join(defaultDir, 'node_modules', ...pin.package.split('/'), 'package.json');
      if (existsSync(pkgPath)) {
        const manifest = JSON.parse(readFileSync(pkgPath, 'utf8'));
        if (manifest.version === pin.version) {
          const bin = typeof manifest.bin === 'string' ? manifest.bin : manifest.bin?.dsh;
          if (bin) {
            const entry = resolve(defaultDir, 'node_modules', ...pin.package.split('/'), bin);
            if (existsSync(entry)) {
              cachedEntry = entry;
            }
          }
        }
      }
    } catch {
      // ignore
    }
  }

  return {
    package: pin.package,
    pinnedVersion: pin.version,
    lockMatches,
    defaultInstallDir: defaultDir,
    cachedEntry,
  };
}

/**
 * Gathers complete platform inspection object.
 */
export function getPlatformInfo(options = {}) {
  const git = getGitInfo();
  const node = getNodeInfo(options.customNodeBin);
  const pnpm = getPnpmInfo(node.activeExec);
  const gitleaks = getGitleaksInfo(options.customGitleaksBin);
  const dsh = getDshInfo();

  const isWsl =
    process.platform === 'linux' &&
    (os.release().toLowerCase().includes('microsoft') ||
      os.release().toLowerCase().includes('wsl'));

  return {
    os: {
      platform: process.platform,
      release: os.release(),
      arch: os.arch(),
      cpus: os.cpus().length,
      totalMemGb: (os.totalmem() / (1024 * 1024 * 1024)).toFixed(2),
      isWsl,
    },
    git,
    node,
    pnpm,
    gitleaks,
    dsh,
    repoRoot: REPO_ROOT,
  };
}
