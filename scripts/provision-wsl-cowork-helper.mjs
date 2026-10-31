// Provision and verify the isolated Cowork Linux helper in WSL2 without elevated permissions.
import { spawn, spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, posix, resolve } from 'node:path';

const DEFAULT_DISTRO = 'nexar-plane';
const DEFAULT_REPO = '/home/nexar/src/Nexar-Ai';
const DEFAULT_COMMAND = '/usr/local/bin/nexar';
const EXPECTED_HELLO = {
  protocol: 'nexar-cowork@1',
  protocolVersion: 1,
  helperVersion: '0.1.0-sec02.1',
  version: '0.2.1-rc.5',
  isolation: 'WSL2_BUBBLEWRAP',
  capabilities: ['stdio-rpc', 'gateway-socket', 'bridge-socket', 'flat-scratch'],
};

function fail(message) {
  console.error(`cowork:wsl:provision failed: ${message}`);
  process.exit(1);
}

if (process.platform !== 'win32') {
  fail('WSL2 Cowork helper provisioning requires a Windows host.');
}

const distro = process.env.NEXAR_SEC02_WSL_DISTRO ?? DEFAULT_DISTRO;
const linuxRepo = process.env.NEXAR_SEC02_WSL_REPO ?? DEFAULT_REPO;
const command = process.env.NEXAR_SEC02_WSL_COMMAND ?? DEFAULT_COMMAND;
const allowDirty = process.argv.includes('--allow-dirty');
const probeOnly = process.argv.includes('--probe-only');

if (
  !/^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/.test(distro) ||
  !/^\/[A-Za-z0-9._/-]{1,255}$/.test(linuxRepo) ||
  linuxRepo.includes('..') ||
  !/^\/[A-Za-z0-9._/-]{1,255}$/.test(command) ||
  command.includes('..') ||
  posix.normalize(command) !== command
) {
  fail('Invalid WSL distro, repository path, or helper command.');
}

const wslExe = join(process.env.SystemRoot ?? 'C:\\Windows', 'System32', 'wsl.exe');

function runWsl(script, inputBuffer) {
  const res = spawnSync(wslExe, ['-d', distro, '--exec', '/bin/sh', '-e', '-c', script], {
    input: inputBuffer,
    maxBuffer: 32 * 1024 * 1024,
    stdio: [inputBuffer ? 'pipe' : 'ignore', 'pipe', 'pipe'],
    windowsHide: true,
  });
  if (res.status !== 0) {
    const stderr = (res.stderr ?? Buffer.alloc(0)).toString('utf8').trim();
    const stdout = (res.stdout ?? Buffer.alloc(0)).toString('utf8').trim();
    fail(stderr || stdout || `wsl.exe exited with status ${String(res.status)}`);
  }
  return (res.stdout ?? Buffer.alloc(0)).toString('utf8');
}

function runGit(args, encoding = 'utf8') {
  const res = spawnSync('git', args, {
    maxBuffer: 64 * 1024 * 1024,
    stdio: ['ignore', 'pipe', 'pipe'],
    windowsHide: true,
  });
  if (res.status !== 0) {
    fail(
      `git ${args.join(' ')} failed: ${(res.stderr ?? Buffer.alloc(0)).toString('utf8').trim()}`,
    );
  }
  return encoding === 'buffer' ? res.stdout : res.stdout.toString('utf8').trim();
}

async function probeHelper() {
  return new Promise((resolveProbe, rejectProbe) => {
    const child = spawn(wslExe, ['-d', distro, '--exec', command, 'cowork', 'serve', '--stdio'], {
      env: { SystemRoot: process.env.SystemRoot ?? 'C:\\Windows' },
      stdio: ['pipe', 'pipe', 'pipe'],
      shell: false,
      windowsHide: true,
    });
    let stdout = '';
    let stderr = '';
    let settled = false;
    const finish = (err, value) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      try {
        child.stdin.end();
        child.kill();
      } catch {
        // ignore
      }
      if (err) rejectProbe(err);
      else resolveProbe(value);
    };
    const timer = setTimeout(
      () => finish(new Error('Helper handshake timed out after 30s')),
      30_000,
    );
    child.stdout.setEncoding('utf8');
    child.stderr.setEncoding('utf8');
    child.stderr.on('data', (chunk) => {
      stderr += chunk;
    });
    child.stdout.on('data', (chunk) => {
      stdout += chunk;
      const newline = stdout.indexOf('\n');
      if (newline === -1) return;
      const line = stdout.slice(0, newline).trim();
      try {
        const msg = JSON.parse(line);
        finish(null, msg.result);
      } catch (err) {
        finish(err);
      }
    });
    child.once('error', (err) => finish(err));
    child.once('close', (code) => {
      if (!settled) {
        finish(
          new Error(`Helper exited with code ${String(code)}: ${stderr.trim() || 'no output'}`),
        );
      }
    });
    child.stdin.write(JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'cowork/hello' }) + '\n');
  });
}

const headCommit = runGit(['rev-parse', 'HEAD']);
const headTree = runGit(['rev-parse', 'HEAD^{tree}']);

if (!probeOnly) {
  const uidCheck = runWsl('id -u').trim();
  if (uidCheck === '0') {
    fail('Refusing to run provisioning as root inside WSL2.');
  }

  const remoteDirty = runWsl(`git -C '${linuxRepo}' status --porcelain`).trim();
  if (remoteDirty !== '' && !allowDirty) {
    fail(
      `Target WSL repository ${linuxRepo} has uncommitted changes. Re-run with --allow-dirty only if intended.`,
    );
  }

  const tempDir = mkdtempSync(join(tmpdir(), 'nexar-wsl-bundle-'));
  try {
    const bundlePath = join(tempDir, 'head.bundle');
    runGit(['bundle', 'create', bundlePath, 'HEAD']);
    const bundleBytes = readFileSync(bundlePath);

    runWsl(
      `
      tmp_bundle="$(mktemp /tmp/nexar-head-XXXXXX.bundle)"
      trap 'rm -f "$tmp_bundle"' EXIT
      cat > "$tmp_bundle"
      git -C '${linuxRepo}' reset --hard -q
      git -C '${linuxRepo}' clean -fd -q
      git -C '${linuxRepo}' fetch -q "$tmp_bundle" HEAD
      git -C '${linuxRepo}' checkout -q --detach FETCH_HEAD
      `,
      bundleBytes,
    );

    const diffBytes = runGit(['diff', 'HEAD', '--binary', '--no-ext-diff', '--no-color'], 'buffer');
    if (diffBytes.length > 0) {
      runWsl(`git -C '${linuxRepo}' apply --binary --whitespace=nowarn`, diffBytes);
    }

    runWsl(
      `
      export PATH="/opt/node/bin:/usr/local/bin:/usr/bin:/bin"
      cd '${linuxRepo}'
      pnpm install --frozen-lockfile --offline || pnpm install --frozen-lockfile --prefer-offline
      pnpm build
      chmod 0755 apps/cli/dist/main.js
      test -f apps/cli/dist/bridge-relay.cjs
      `,
    );
  } finally {
    rmSync(tempDir, { recursive: true, force: true });
  }
}

const hello = await probeHelper();
if (
  typeof hello !== 'object' ||
  hello === null ||
  hello.protocol !== EXPECTED_HELLO.protocol ||
  hello.protocolVersion !== EXPECTED_HELLO.protocolVersion ||
  hello.helperVersion !== EXPECTED_HELLO.helperVersion ||
  hello.version !== EXPECTED_HELLO.version ||
  hello.isolation !== EXPECTED_HELLO.isolation ||
  !Array.isArray(hello.capabilities) ||
  EXPECTED_HELLO.capabilities.some((cap) => !hello.capabilities.includes(cap))
) {
  fail(`Unexpected cowork/hello response: ${JSON.stringify(hello)}`);
}

const wslHead = runWsl(`git -C '${linuxRepo}' rev-parse HEAD`).trim();
const report = {
  ok: true,
  timestamp: new Date().toISOString(),
  distro,
  linuxRepo,
  command,
  windowsHeadCommit: headCommit,
  windowsHeadTree: headTree,
  wslHeadCommit: wslHead,
  hello,
};

mkdirSync(resolve('.nexar/ci'), { recursive: true });
writeFileSync(resolve('.nexar/ci/cowork-helper-provision.json'), JSON.stringify(report, null, 2));
console.log(JSON.stringify(report, null, 2));
