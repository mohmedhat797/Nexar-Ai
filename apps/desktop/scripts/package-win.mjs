// Builds an unsigned, per-user Windows installer from a deployed production dependency graph.
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { lstat, readFile, readdir, realpath, rm, writeFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { dirname, isAbsolute, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

if (process.platform !== 'win32') throw new Error('Windows packaging requires a Windows host');

const root = await realpath(fileURLToPath(new URL('../../../', import.meta.url)));
const config = fileURLToPath(new URL('../electron-builder.json', import.meta.url));
const stagingRelative = 'dist/desktop-staging';
const outputRelative = 'release/desktop';
const staging = resolve(root, stagingRelative);
const output = resolve(root, outputRelative);
// The pinned DeepSeek Harness runtime (ADR-030): installed here at build time (never by the app),
// then shipped outside the asar as `resources/dsh-runtime` (see `extraResources`).
const runtimeRelative = 'dist/dsh-runtime';
const runtimeDir = resolve(root, runtimeRelative);
const require = createRequire(import.meta.url);
const desktop = JSON.parse(await readFile(new URL('../package.json', import.meta.url), 'utf8'));
const builderManifestPath = require.resolve('electron-builder/package.json');
const builder = JSON.parse(await readFile(builderManifestPath, 'utf8'));
if (builder.version !== '26.15.3' || desktop.devDependencies.electron !== '44.5.1') {
  throw new Error('Packaging requires electron-builder 26.15.3 and Electron 44.5.1');
}
const builderCli = resolve(dirname(builderManifestPath), builder.bin['electron-builder']);
const pnpmCli = process.env.npm_execpath;
if (pnpmCli === undefined) throw new Error('Run packaging with pnpm desktop:package:win');
const version = spawnSync(process.execPath, [pnpmCli, '--version'], {
  cwd: root,
  encoding: 'utf8',
  shell: false,
});
if (version.status !== 0 || version.stdout.trim() !== '10.33.0') {
  throw new Error('Packaging requires pnpm 10.33.0');
}

function run(args, env = process.env) {
  const result = spawnSync(process.execPath, args, {
    cwd: root,
    stdio: 'inherit',
    shell: false,
    env,
  });
  if (result.error !== undefined) throw result.error;
  if (result.status !== 0) process.exit(result.status ?? 1);
}

function contained(path) {
  const fromRoot = relative(root, path);
  return (
    fromRoot !== '..' &&
    !fromRoot.startsWith(`..${process.platform === 'win32' ? '\\' : '/'}`) &&
    !isAbsolute(fromRoot)
  );
}

async function cleanOutput(path) {
  // Only these fixed repository output directories may be removed; never application state.
  if (![staging, output, runtimeDir].includes(path) || !contained(path) || path === root) {
    throw new Error('Refusing to clean outside the packaging output directories');
  }
  for (let existing = path; existing !== root; existing = dirname(existing)) {
    try {
      if ((await lstat(existing)).isSymbolicLink()) {
        throw new Error('Packaging output must not contain symlink or junction ancestors');
      }
      const canonical = await realpath(existing);
      if (
        !contained(canonical) ||
        resolve(canonical).toLowerCase() !== resolve(existing).toLowerCase()
      ) {
        throw new Error('Packaging output must not alias another directory');
      }
    } catch (error) {
      if (error.code !== 'ENOENT') throw error;
    }
  }
  await rm(path, { recursive: true, force: true });
}

run([pnpmCli, 'build']);
await cleanOutput(staging);
await cleanOutput(output);
await cleanOutput(runtimeDir);

// `install-dsh-runtime.mjs` installs the pin from its lockfile (`npm ci`) and verifies `--version`;
// its last stdout line is the entry. Packaging fails unless that is the pinned version.
const pin = JSON.parse(
  await readFile(join(root, 'integrations', 'deepseek-harness', 'dsh-runtime.json'), 'utf8'),
);
const installed = spawnSync(
  process.execPath,
  [join(root, 'scripts', 'install-dsh-runtime.mjs'), runtimeDir],
  { cwd: root, encoding: 'utf8', stdio: ['ignore', 'pipe', 'inherit'], shell: false },
);
if (installed.error !== undefined) throw installed.error;
if (installed.status !== 0) process.exit(installed.status ?? 1);
const entry = installed.stdout.trim().split(/\r?\n/).at(-1) ?? '';
const packageDir = join(runtimeDir, 'node_modules', ...pin.package.split('/'));
const packageManifest = JSON.parse(await readFile(join(packageDir, 'package.json'), 'utf8'));
const entryFromPackage = relative(packageDir, entry).split(/[\\/]/).join('/');
if (
  packageManifest.version !== pin.version ||
  !entry.toLowerCase().startsWith(packageDir.toLowerCase()) ||
  !entryFromPackage.endsWith('.js')
) {
  throw new Error('The installed DeepSeek Harness runtime is not the pinned version');
}
await writeFile(
  join(runtimeDir, 'runtime.json'),
  `${JSON.stringify({ package: pin.package, version: pin.version, entry: entryFromPackage }, null, 2)}\n`,
);

// Keep the deploy target relative: pnpm's legacy deploy fails across Windows drive letters.
run([pnpmCli, '--filter', '@nexar/desktop', 'deploy', '--prod', '--legacy', stagingRelative]);
run(
  [
    builderCli,
    '--projectDir',
    root,
    '--config',
    config,
    '--win',
    'nsis',
    '--x64',
    '--publish',
    'never',
  ],
  { ...process.env, CSC_IDENTITY_AUTO_DISCOVERY: 'false' },
);

const installers = (await readdir(output, { withFileTypes: true })).filter(
  (entry) => entry.isFile() && entry.name.endsWith('.exe'),
);
if (installers.length !== 1) throw new Error('Expected exactly one Windows installer');
const installer = installers[0].name;
const sha256 = createHash('sha256');
for await (const chunk of createReadStream(join(output, installer))) sha256.update(chunk);
await writeFile(join(output, `${installer}.sha256`), `${sha256.digest('hex')}  ${installer}\n`);
process.stdout.write(`Installer and SHA256 saved in ${outputRelative}\n`);
