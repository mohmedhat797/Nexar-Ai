// Managed installation only: never reuse an unverified existing dependency tree.
import { randomUUID } from 'node:crypto';
import {
  closeSync,
  copyFileSync,
  existsSync,
  lstatSync,
  mkdirSync,
  openSync,
  readFileSync,
  readdirSync,
  realpathSync,
  renameSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs';
import { basename, dirname, extname, join, parse, relative, resolve, sep } from 'node:path';
import { performance } from 'node:perf_hooks';
import { spawnSubprocess } from '../local-ci/process-util.mjs';

const PACKAGE_NAME = /^(@[a-z0-9][a-z0-9._-]*\/)?[a-z0-9][a-z0-9._-]*$/;
const VERSION = /^\d+\.\d+\.\d+(-[0-9A-Za-z.-]+)?$/;
const INSTALL_TIMEOUT_MS = 180_000;
const VERSION_TIMEOUT_MS = 120_000;

function failure(category) {
  return Object.assign(new Error(`install-dsh-runtime: ${category}`), { category });
}

function readJson(file) {
  return JSON.parse(readFileSync(file, 'utf8'));
}

function assertOwnedTarget(target) {
  if (!existsSync(target)) return;
  const stat = lstatSync(target);
  if (!stat.isDirectory() || stat.isSymbolicLink()) throw failure('UNSAFE_TARGET');
  if (readdirSync(target).length === 0) return;
  try {
    if (readJson(join(target, 'package.json')).name === 'nexar-dsh-runtime') return;
  } catch {
    // Never move or remove a directory with unknown ownership.
  }
  throw failure('UNOWNED_TARGET');
}

function runtimeEntry(dir, pin) {
  const root = join(dir, 'node_modules', ...pin.package.split('/'));
  const manifest = readJson(join(root, 'package.json'));
  if (manifest.name !== pin.package || manifest.version !== pin.version) {
    throw failure('RUNTIME_IDENTITY_MISMATCH');
  }
  const bin = typeof manifest.bin === 'string' ? manifest.bin : manifest.bin?.dsh;
  if (typeof bin !== 'string') throw failure('INVALID_ENTRYPOINT');
  const entry = resolve(root, bin);
  const rel = relative(realpathSync(root), realpathSync(entry));
  if (!rel || rel === '..' || rel.startsWith(`..${sep}`) || resolve(root, rel) !== entry) {
    throw failure('INVALID_ENTRYPOINT');
  }
  const stat = lstatSync(entry);
  if (!stat.isFile() || stat.isSymbolicLink()) throw failure('INVALID_ENTRYPOINT');
  return entry;
}

// Internal test seams are not command-line options or renderer authority.
export async function installDshRuntime({
  target,
  pinDir,
  run = spawnSubprocess,
  rename = renameSync,
  report = (record) => process.stderr.write(`${JSON.stringify(record)}\n`),
}) {
  const started = performance.now();
  const generation = randomUUID();
  let pin;
  let phase = 'pin-validation';
  const emit = (event, fields = {}) =>
    report({
      schema: 'dsh-install@1',
      generation,
      parentPid: process.pid,
      timestampUtc: new Date().toISOString(),
      elapsedMs: Math.round(performance.now() - started),
      phase,
      event,
      packageVersion: pin?.version ?? null,
      cacheMode: process.env.npm_config_offline === 'true' ? 'offline-requested' : 'npm-configured',
      ...fields,
    });
  const step = async (name, action) => {
    phase = name;
    const before = performance.now();
    emit('start');
    const value = await action();
    emit('complete', { durationMs: Math.round(performance.now() - before) });
    return value;
  };
  let lockPath;
  let ownsLock = false;
  let stage;
  let published;
  let installationError;
  try {
    await step('pin-validation', () => {
      const candidate = readJson(join(pinDir, 'dsh-runtime.json'));
      if (!PACKAGE_NAME.test(candidate?.package ?? '') || !VERSION.test(candidate?.version ?? '')) {
        throw failure('INVALID_PIN');
      }
      pin = { package: candidate.package, version: candidate.version };
      const lock = readJson(join(pinDir, 'dsh-runtime.package-lock.json'));
      if (
        lock.lockfileVersion !== 3 ||
        lock.packages?.['']?.dependencies?.[pin.package] !== pin.version ||
        lock.packages?.[`node_modules/${pin.package}`]?.version !== pin.version
      ) {
        throw failure('PIN_LOCK_MISMATCH');
      }
    });
    const requested = resolve(target);
    if (requested === parse(requested).root) throw failure('UNSAFE_TARGET');
    mkdirSync(dirname(requested), { recursive: true });
    const dir = join(realpathSync(dirname(requested)), basename(requested));
    lockPath = `${dir}.install-lock`;
    await step('admission', () => {
      let fd;
      try {
        fd = openSync(lockPath, 'wx', 0o600);
        ownsLock = true;
        writeFileSync(fd, JSON.stringify({ generation, parentPid: process.pid }));
      } catch (error) {
        if (error.code === 'EEXIST') throw failure('INSTALLATION_LOCKED');
        throw error;
      } finally {
        if (fd !== undefined) closeSync(fd);
      }
      assertOwnedTarget(dir);
    });
    stage = `${dir}.stage-${generation}`;
    await step('staging', () => {
      mkdirSync(stage, { recursive: false, mode: 0o700 });
      writeFileSync(
        join(stage, 'package.json'),
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
      copyFileSync(join(pinDir, 'dsh-runtime.package-lock.json'), join(stage, 'package-lock.json'));
    });
    const invoke = async (command, args, cwd, limit) => {
      const remaining = INSTALL_TIMEOUT_MS - (performance.now() - started);
      if (remaining <= 0) throw failure('INSTALLATION_TIMEOUT');
      const result = await run(command, args, {
        cwd,
        timeoutMs: Math.max(1, Math.floor(Math.min(remaining, limit))),
        onSpawn: (childPid) => emit('child-created', { childPid }),
      });
      emit('child-settled', {
        exitCode: result.exitCode,
        timedOut: result.timedOut,
        settled: result.settled ?? true,
      });
      if (result.timedOut) throw failure('INSTALLATION_TIMEOUT');
      if (result.exitCode !== 0 || result.settled === false) throw failure('CHILD_FAILED');
      return result;
    };
    await step('npm-ci', async () => {
      // npm owns acquisition, lockfile integrity verification and materialization. Arbitrary
      // npm output stays bounded in the runner and is not published as diagnostics.
      const result = await invoke(
        process.platform === 'win32' ? 'npm.cmd' : 'npm',
        ['ci', '--no-audit', '--no-fund', '--omit=dev'],
        stage,
        INSTALL_TIMEOUT_MS,
      );
      const timing = /npm timing reify:unpack Completed in (\d+)ms/.exec(result.stderr);
      if (timing) emit('npm-timing', { unpackMs: Number(timing[1]) });
    });
    const entry = await step('entrypoint-validation', () => runtimeEntry(stage, pin));
    await step('version-verification', async () => {
      const script = ['.js', '.mjs', '.cjs'].includes(extname(entry).toLowerCase());
      const result = await invoke(
        script ? process.execPath : entry,
        [...(script ? [entry] : []), '--version'],
        stage,
        VERSION_TIMEOUT_MS,
      );
      if (result.stdout.trim() !== pin.version) throw failure('VERSION_PROBE_MISMATCH');
    });
    await step('publication', () => {
      if (performance.now() - started >= INSTALL_TIMEOUT_MS) throw failure('INSTALLATION_TIMEOUT');
      assertOwnedTarget(dir);
      const previous = `${dir}.previous-${generation}`;
      const hadPrevious = existsSync(dir);
      if (hadPrevious) rename(dir, previous);
      try {
        rename(stage, dir);
      } catch (error) {
        if (hadPrevious) {
          try {
            rename(previous, dir);
          } catch {
            throw failure('PUBLICATION_RECOVERY_REQUIRED');
          }
        }
        throw error;
      }
      // Recursive removal can outlive the installation deadline after a verified runtime
      // is already published. Retain the exact previous sibling for explicit maintenance
      // and recovery; readiness must not depend on unbounded dependency-tree deletion.
      if (hadPrevious) emit('previous-generation-retained');
    });
    published = runtimeEntry(dir, pin);
  } catch (error) {
    const category =
      typeof error.category === 'string' ? error.category : 'FILESYSTEM_OR_DATA_FAILURE';
    emit('failed', { category, partialStageRetained: stage !== undefined && existsSync(stage) });
    installationError = failure(category);
  } finally {
    // Hard termination retains the ownership file and fails closed on restart. Never
    // auto-delete a stale lock based only on a PID, which can be reused.
    if (ownsLock) {
      try {
        if (readJson(lockPath).generation === generation) unlinkSync(lockPath);
        else installationError = failure('LOCK_RECOVERY_REQUIRED');
      } catch {
        installationError = failure('LOCK_RECOVERY_REQUIRED');
      }
    }
  }
  if (installationError) throw installationError;
  emit('ready');
  return published;
}
