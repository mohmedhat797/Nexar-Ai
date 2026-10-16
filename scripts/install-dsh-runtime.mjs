// Installs the pinned DeepSeek Harness runtime into a private directory (ADR-030).
//
//   node scripts/install-dsh-runtime.mjs <dir>
//
// The package name and version come from integrations/deepseek-harness/dsh-runtime.json (the only
// pin). The dependency graph comes from the committed lockfile
// integrations/deepseek-harness/dsh-runtime.package-lock.json and is installed with `npm ci`, which
// fails on any mismatch between the pin, the lockfile and the registry's integrity hashes (threat
// model T12). Bumping the pin means regenerating that lockfile. The installed entry is verified with
// `--version` against the pin; its absolute path is the last line on stdout (npm's own output goes
// to stderr).
import { spawnSync } from 'node:child_process';
import { copyFileSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, extname, isAbsolute, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const PACKAGE_NAME = /^(@[a-z0-9][a-z0-9._-]*\/)?[a-z0-9][a-z0-9._-]*$/;
const VERSION = /^\d+\.\d+\.\d+(-[0-9A-Za-z.-]+)?$/;
const VERSION_TIMEOUT_MS = 120_000;

function fail(message) {
  console.error(`install-dsh-runtime: ${message}`);
  process.exit(1);
}

const target = process.argv[2];
if (target === undefined || process.argv.length > 3) fail('usage: install-dsh-runtime.mjs <dir>');
const dir = resolve(target);

const pinDir = join(
  dirname(fileURLToPath(import.meta.url)),
  '..',
  'integrations',
  'deepseek-harness',
);
const pinPath = join(pinDir, 'dsh-runtime.json');
const lockPath = join(pinDir, 'dsh-runtime.package-lock.json');
const pin = JSON.parse(readFileSync(pinPath, 'utf8'));
if (typeof pin.package !== 'string' || !PACKAGE_NAME.test(pin.package)) fail('invalid package pin');
if (typeof pin.version !== 'string' || !VERSION.test(pin.version)) fail('invalid version pin');

// The lockfile must be for exactly this pin: its root names the same package and version.
const lock = JSON.parse(readFileSync(lockPath, 'utf8'));
if (
  lock.lockfileVersion !== 3 ||
  lock.packages?.['']?.dependencies?.[pin.package] !== pin.version
) {
  fail('the lockfile does not match the pin; regenerate dsh-runtime.package-lock.json');
}

mkdirSync(dir, { recursive: true });
writeFileSync(
  join(dir, 'package.json'),
  `${JSON.stringify(
    {
      name: 'nexar-dsh-runtime',
      version: '0.0.0',
      private: true,
      dependencies: { [pin.package]: pin.version },
    },
    null,
    2,
  )}\n`,
);
copyFileSync(lockPath, join(dir, 'package-lock.json'));

// `npm ci` installs exactly the lockfile and fails when it and package.json disagree. The argument
// list is fixed (nothing validated above reaches the shell).
const windows = process.platform === 'win32';
const install = spawnSync(
  windows ? 'npm.cmd' : 'npm',
  ['ci', '--no-audit', '--no-fund', '--omit=dev'],
  { cwd: dir, stdio: ['ignore', 2, 2], shell: windows },
);
if (install.status !== 0) fail('npm ci failed');

const manifest = JSON.parse(
  readFileSync(join(dir, 'node_modules', ...pin.package.split('/'), 'package.json'), 'utf8'),
);
if (manifest.version !== pin.version) fail('installed version does not match the pin');
const bin = typeof manifest.bin === 'string' ? manifest.bin : (manifest.bin?.dsh ?? undefined);
if (typeof bin !== 'string') fail('the package declares no dsh bin entry');
const entry = resolve(dir, 'node_modules', ...pin.package.split('/'), bin);
if (!isAbsolute(entry)) fail('could not resolve the entry');

const isNodeScript = ['.js', '.mjs', '.cjs'].includes(extname(entry).toLowerCase());
const probe = spawnSync(
  isNodeScript ? process.execPath : entry,
  [...(isNodeScript ? [entry] : []), '--version'],
  { encoding: 'utf8', timeout: VERSION_TIMEOUT_MS, windowsHide: true },
);
if (probe.status !== 0) fail('the installed runtime failed to report its version');
if (probe.stdout.trim() !== pin.version) fail('the installed runtime reports a different version');

console.log(entry);
