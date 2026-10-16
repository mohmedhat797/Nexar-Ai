// Mandatory Windows acceptance gate: never report PASS for skipped real-isolation tests.
import { spawnSync } from 'node:child_process';
import { readFileSync, writeFileSync, mkdtempSync, mkdirSync, rmSync } from 'node:fs';
import { resolve, join } from 'node:path';
import { tmpdir } from 'node:os';

if (process.platform === 'linux' && process.argv.includes('--linux')) {
  const report = resolve('.nexar/ci/cowork-kernel.json');
  mkdirSync(resolve('.nexar/ci'), { recursive: true });
  rmSync(report, { force: true });
  const result = spawnSync(
    process.execPath,
    [
      'node_modules/vitest/vitest.mjs',
      'run',
      'integrations/deepseek-harness/src/acp/sandboxed.real.test.ts',
      'integrations/deepseek-harness/src/acp/real.test.ts',
      'packages/sandbox/src/launcher.integration.test.ts',
      '--maxWorkers=1',
      '--reporter=default',
      '--reporter=json',
      `--outputFile=${report}`,
    ],
    {
      stdio: 'inherit',
      env: {
        ...process.env,
        NEXAR_DSH_BIN: '/opt/dsh/lib/node_modules/@deepseek-ai/dsh/lib/bin.js',
        NEXAR_DSH_TOOLCHAIN: '/opt/node:/opt/dsh/lib/node_modules',
      },
    },
  );
  if (result.status !== 0) process.exit(result.status ?? 1);
  const tests = JSON.parse(readFileSync(report, 'utf8')).testResults.flatMap(
    (file) => file.assertionResults,
  );
  if (tests.length < 3 || tests.some((test) => test.status !== 'passed')) process.exit(1);
  process.exit(0);
}

const linuxRepo = process.env.NEXAR_SEC02_WSL_REPO ?? '/home/nexar/src/Nexar-Ai';
if (
  process.platform !== 'win32' ||
  !/^\/[A-Za-z0-9._/-]+$/.test(linuxRepo) ||
  !process.env.NEXAR_DSH_ENTRY
) {
  console.error(
    'Isolated Cowork acceptance needs Windows, a valid WSL repo path and pinned NEXAR_DSH_ENTRY.',
  );
  process.exit(1);
}
const report = resolve('.nexar/ci/cowork-wsl.json');
mkdirSync(resolve('.nexar/ci'), { recursive: true });
rmSync(report, { force: true });
const result = spawnSync(
  process.execPath,
  [
    'node_modules/vitest/vitest.mjs',
    'run',
    'apps/desktop/src/main/wsl-cowork.real.test.ts',
    'apps/desktop/src/main/dsh-cowork.context.real.test.ts',
    '--maxWorkers=1',
    '--reporter=default',
    '--reporter=json',
    `--outputFile=${report}`,
  ],
  { stdio: 'inherit', env: { ...process.env, NEXAR_SEC02_CONTEXT_WSL: '1' } },
);
if (result.status !== 0) process.exit(result.status ?? 1);
const data = JSON.parse(readFileSync(report, 'utf8'));
const tests = data.testResults.flatMap((file) => file.assertionResults);
if (tests.length < 8 || tests.some((test) => test.status !== 'passed')) {
  console.error('Real isolated Cowork acceptance is incomplete: failed or skipped assertions.');
  process.exit(1);
}
// The Windows fixture is owned by this invocation. It is intentionally never mounted into WSL.
const fixture = mkdtempSync(join(tmpdir(), 'nexar-sec02-kernel-'));
try {
  const file = join(fixture, 'outside-windows.txt');
  const marker = 'SEC02-WINDOWS-HOST-PRIVATE';
  writeFileSync(file, marker);
  const windowsPath = file
    .replace(/^([A-Za-z]):/, (_, drive) => `/mnt/${drive.toLowerCase()}`)
    .replaceAll('\\', '/');
  const result = spawnSync(
    join(process.env.SystemRoot ?? 'C:/Windows', 'System32', 'wsl.exe'),
    [
      '-d',
      process.env.NEXAR_SEC02_WSL_DISTRO ?? 'nexar-plane',
      '--cd',
      linuxRepo,
      '--exec',
      'env',
      `NEXAR_SEC02_WINDOWS_FIXTURE=${windowsPath}`,
      '/opt/node/bin/node',
      `${linuxRepo}/scripts/verify-cowork-wsl.mjs`,
      '--linux',
    ],
    { stdio: 'inherit' },
  );
  if (readFileSync(file, 'utf8') !== marker)
    throw new Error('Synthetic Windows host fixture changed');
  process.exitCode = result.status ?? 1;
} finally {
  rmSync(fixture, { recursive: true, force: true });
}
