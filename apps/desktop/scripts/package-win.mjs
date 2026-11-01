// Builds an unsigned, per-user Windows installer from a deployed production dependency graph.
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { lstat, mkdir, open, readFile, readdir, realpath, rm, writeFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { dirname, isAbsolute, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  inspectRuntimeArtifact,
  promoteRuntimeArtifactAsync,
  sealRuntimeArtifact,
  verifyPackagedRuntimeAsync,
} from '../../../scripts/dsh-runtime/artifact.mjs';

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
  if (result.status !== 0) throw new Error(`Packaging step failed with exit ${result.status}`);
}

// A verified artifact is consumed by content, so its location carries no authority: the default is
// this checkout's managed runtime and local CI names the runtime its own install stage produced.
const argv = process.argv.slice(2);
const artifactFlag = '--runtime-artifact=';
const freshFlag = '--fresh-dsh-runtime';
for (const argument of argv) {
  if (argument !== freshFlag && !argument.startsWith(artifactFlag)) {
    throw new Error('Usage: package-win.mjs [--runtime-artifact=<dir>] [--fresh-dsh-runtime]');
  }
}
const freshRequested = argv.includes(freshFlag);
const artifactDir = resolve(
  argv.find((argument) => argument.startsWith(artifactFlag))?.slice(artifactFlag.length) ??
    join(root, '.nexar', 'dsh-runtime'),
);
const pinDir = join(root, 'integrations', 'deepseek-harness');

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

// Mode A consumes a sealed artifact by hashing every byte it copies; mode B runs the accepted
// installer. A seal that exists but does not verify stops here: replacing it needs the explicit flag.
async function materializeRuntime() {
  const inspected = freshRequested
    ? { status: 'fresh-requested' }
    : inspectRuntimeArtifact({ dir: artifactDir, pinDir });
  if (inspected.status === 'sealed') {
    return {
      mode: 'verified-artifact',
      seal: await promoteRuntimeArtifactAsync({ dir: artifactDir, target: runtimeDir, pinDir }),
    };
  }
  // `install-dsh-runtime.mjs` installs the pin from its lockfile (`npm ci`) and verifies
  // `--version`. Packaging fails unless that is the pinned version.
  const installed = spawnSync(
    process.execPath,
    [join(root, 'scripts', 'install-dsh-runtime.mjs'), runtimeDir],
    { cwd: root, encoding: 'utf8', stdio: ['ignore', 'pipe', 'inherit'], shell: false },
  );
  if (installed.error !== undefined) throw installed.error;
  if (installed.status !== 0) {
    throw new Error(`The runtime installer failed with exit ${installed.status}`);
  }
  return { mode: 'fresh-install', seal: sealRuntimeArtifact({ dir: runtimeDir, pinDir }) };
}

async function packageDesktop() {
  const started = Date.now();
  const mark = (phase) =>
    process.stdout.write(
      `${JSON.stringify({ event: 'package-phase', phase, elapsedMs: Date.now() - started })}\n`,
    );
  run([pnpmCli, 'build']);
  mark('build');
  await cleanOutput(staging);
  await cleanOutput(output);
  await cleanOutput(runtimeDir);
  mark('clean');

  const pin = JSON.parse(await readFile(join(pinDir, 'dsh-runtime.json'), 'utf8'));
  const { mode, seal } = await materializeRuntime();
  mark(`runtime-${mode}`);
  const packageDir = join(runtimeDir, 'node_modules', ...pin.package.split('/'));
  const packageManifest = JSON.parse(await readFile(join(packageDir, 'package.json'), 'utf8'));
  const bin =
    typeof packageManifest.bin === 'string' ? packageManifest.bin : packageManifest.bin?.dsh;
  const entry = typeof bin === 'string' ? resolve(packageDir, bin) : '';
  const entryFromPackage = relative(packageDir, entry).split(/[\\/]/).join('/');
  if (
    packageManifest.version !== pin.version ||
    !entry.toLowerCase().startsWith(`${packageDir.toLowerCase()}\\`) ||
    !entryFromPackage.endsWith('.js')
  ) {
    throw new Error('The installed DeepSeek Harness runtime is not the pinned version');
  }
  // Both modes prove the tree that will ship actually executes as the pinned version.
  const probe = spawnSync(process.execPath, [entry, '--version'], {
    cwd: runtimeDir,
    encoding: 'utf8',
    shell: false,
    timeout: 120_000,
  });
  if (probe.status !== 0 || probe.stdout.trim() !== pin.version) {
    throw new Error('The materialized DeepSeek Harness runtime failed its version probe');
  }
  await writeFile(
    join(runtimeDir, 'runtime.json'),
    `${JSON.stringify({ package: pin.package, version: pin.version, entry: entryFromPackage }, null, 2)}\n`,
  );

  // Keep the deploy target relative: pnpm's legacy deploy fails across Windows drive letters.
  run([pnpmCli, '--filter', '@nexar/desktop', 'deploy', '--prod', '--legacy', stagingRelative]);
  mark('deploy');
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
  mark('electron-builder');

  const packaged = await verifyPackagedRuntimeAsync({
    dir: join(output, 'win-unpacked', 'resources', 'dsh-runtime'),
    seal,
    reference: runtimeDir,
  });
  if (!packaged.matches) {
    const differences = {
      missing: packaged.missing,
      extra: packaged.extra,
      changed: packaged.changed,
    };
    process.stderr.write(`${JSON.stringify(differences).slice(0, 4000)}\n`);
    throw new Error('The packaged DeepSeek Harness runtime differs from its verified artifact');
  }
  mark('packaged-verification');

  const installers = (await readdir(output, { withFileTypes: true })).filter(
    (entry) => entry.isFile() && entry.name.endsWith('.exe'),
  );
  if (installers.length !== 1) throw new Error('Expected exactly one Windows installer');
  const installer = installers[0].name;
  const sha256 = createHash('sha256');
  for await (const chunk of createReadStream(join(output, installer))) sha256.update(chunk);
  const installerSha256 = sha256.digest('hex');
  await writeFile(join(output, `${installer}.sha256`), `${installerSha256}  ${installer}\n`);
  await writeFile(
    join(output, 'dsh-runtime-provenance.json'),
    `${JSON.stringify({ mode, seal, packagedTreeSha256: packaged.treeSha256, installerSha256 }, null, 2)}\n`,
  );
  process.stdout.write(`Installer, SHA256 and provenance saved in ${outputRelative} (${mode})\n`);
}

// One packaging run per checkout. A hard kill leaves the lock in place and the next run fails
// closed; as with the installer, it is never stolen based on a PID, which can be reused.
await mkdir(resolve(root, 'dist'), { recursive: true });
const packagingLock = await open(resolve(root, 'dist', '.package-win.lock'), 'wx').catch(
  (error) => {
    if (error.code === 'EEXIST') {
      throw new Error(
        'Another packaging run holds dist/.package-win.lock; review it before retrying',
      );
    }
    throw error;
  },
);
try {
  await packageDesktop();
} finally {
  await packagingLock.close();
  await rm(resolve(root, 'dist', '.package-win.lock'));
}
