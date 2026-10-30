// Verified reuse of a managed DSH runtime: the seal binds a completed installation's identity and
// complete file tree, and a tree is only ever consumed by hashing the bytes actually copied.
// A path, a version string or a timestamp is never evidence of integrity.
import { createHash, randomUUID } from 'node:crypto';
import {
  closeSync,
  existsSync,
  lstatSync,
  mkdirSync,
  openSync,
  readFileSync,
  readSync,
  readdirSync,
  realpathSync,
  renameSync,
  rmSync,
  writeFileSync,
  writeSync,
} from 'node:fs';
import { dirname, join, relative, resolve, sep } from 'node:path';

export const INSTALL_RECEIPT = 'nexar-install-receipt.json';
export const ARTIFACT_SEAL = 'nexar-runtime-artifact.json';
// Per-generation metadata; everything else must match byte for byte, so two independent
// installations of one lock have the same digest. The seal itself records the receipt's generation.
const UNSEALED = new Set([ARTIFACT_SEAL, INSTALL_RECEIPT, 'runtime.json']);
const RECEIPT_SCHEMA = 'nexar-dsh-install-receipt@1';
const SEAL_SCHEMA = 'nexar-dsh-runtime-artifact@1';
const CHUNK_BYTES = 1 << 20;

function failure(category) {
  return Object.assign(new Error(`dsh-runtime-artifact: ${category}`), { category });
}

function sha256(bytes) {
  return createHash('sha256').update(bytes).digest('hex');
}

function readJson(file, category) {
  try {
    return JSON.parse(readFileSync(file, 'utf8'));
  } catch {
    throw failure(category);
  }
}

function readPin(pinDir) {
  const pin = readJson(join(pinDir, 'dsh-runtime.json'), 'INVALID_PIN');
  const lockBytes = readFileSync(join(pinDir, 'dsh-runtime.package-lock.json'));
  return { package: pin.package, version: pin.version, lockSha256: sha256(lockBytes), lockBytes };
}

export function installReceipt({ generation, pinDir }) {
  const pin = readPin(pinDir);
  return {
    schema: RECEIPT_SCHEMA,
    generation,
    package: pin.package,
    version: pin.version,
    lockSha256: pin.lockSha256,
  };
}

// Never enters a link: a reparse point anywhere in the tree refuses the whole artifact.
function listFiles(root) {
  const files = [];
  const walk = (dir) => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const path = join(dir, entry.name);
      const stat = lstatSync(path);
      if (stat.isSymbolicLink()) throw failure('ARTIFACT_LINK');
      if (stat.isDirectory()) walk(path);
      else if (stat.isFile()) {
        files.push({ path, rel: relative(root, path).split(sep).join('/'), mode: stat.mode });
      } else throw failure('ARTIFACT_NOT_REGULAR');
    }
  };
  walk(root);
  return files.filter((file) => !UNSEALED.has(file.rel));
}

function treeDigest(rows) {
  const hash = createHash('sha256');
  const sorted = [...rows].sort((a, b) => (a.rel < b.rel ? -1 : a.rel > b.rel ? 1 : 0));
  let bytes = 0;
  for (const row of sorted) {
    hash.update(`${row.rel}\0${row.size}\0${row.sha256}\n`);
    bytes += row.size;
  }
  return { treeSha256: hash.digest('hex'), files: sorted.length, bytes };
}

function hashFile(path, onChunk) {
  const hash = createHash('sha256');
  const buffer = Buffer.allocUnsafe(CHUNK_BYTES);
  const fd = openSync(path, 'r');
  let size = 0;
  try {
    for (;;) {
      const read = readSync(fd, buffer, 0, CHUNK_BYTES, null);
      if (read === 0) break;
      const chunk = buffer.subarray(0, read);
      hash.update(chunk);
      onChunk?.(chunk);
      size += read;
    }
  } finally {
    closeSync(fd);
  }
  return { size, sha256: hash.digest('hex') };
}

export function hashRuntimeTree(root) {
  return listFiles(root).map((file) => ({ rel: file.rel, ...hashFile(file.path) }));
}

// npm writes the hidden lockfile last, so it distinguishes a complete tree from a partial one.
// Every materialized package must be exactly what the pin's lock names, with its integrity.
function assertCompleteDependencyTree(dir, pin) {
  const pinned = JSON.parse(pin.lockBytes.toString('utf8')).packages ?? {};
  const hidden = readJson(join(dir, 'node_modules', '.package-lock.json'), 'ARTIFACT_INCOMPLETE');
  const installed = hidden.packages ?? {};
  for (const [path, record] of Object.entries(installed)) {
    const expected = pinned[path];
    if (
      expected === undefined ||
      expected.version !== record.version ||
      expected.integrity !== record.integrity
    ) {
      throw failure('ARTIFACT_LOCK_MISMATCH');
    }
    if (!existsSync(join(dir, ...path.split('/'), 'package.json'))) {
      throw failure('ARTIFACT_INCOMPLETE');
    }
  }
  for (const [path, record] of Object.entries(pinned)) {
    if (path === '' || record.dev === true || record.optional === true) continue;
    if (installed[path] === undefined) throw failure('ARTIFACT_INCOMPLETE');
  }
}

function assertIdentity(dir, pin, record) {
  if (record.package !== pin.package || record.version !== pin.version) {
    throw failure('ARTIFACT_IDENTITY_MISMATCH');
  }
  if (record.lockSha256 !== pin.lockSha256) throw failure('ARTIFACT_LOCK_MISMATCH');
  if (sha256(readFileSync(join(dir, 'package-lock.json'))) !== pin.lockSha256) {
    throw failure('ARTIFACT_LOCK_MISMATCH');
  }
}

function assertNoInstallation(dir) {
  if (existsSync(`${dir}.install-lock`)) throw failure('ARTIFACT_INSTALLATION_ACTIVE');
}

function plainDirectory(path) {
  const requested = resolve(path);
  const stat = lstatSync(requested, { throwIfNoEntry: false });
  if (stat === undefined) return undefined;
  if (stat.isSymbolicLink() || !stat.isDirectory()) throw failure('ARTIFACT_UNSAFE_PATH');
  // A linked ancestor would make the path alias a tree outside the expected location.
  const canonical = realpathSync(requested);
  const same =
    process.platform === 'win32'
      ? canonical.toLowerCase() === requested.toLowerCase()
      : canonical === requested;
  if (!same) throw failure('ARTIFACT_UNSAFE_PATH');
  return canonical;
}

// Only a tree the accepted installer completed can be sealed: its receipt is written after the
// entrypoint and CLI version checks passed, immediately before publication.
export function sealRuntimeArtifact({ dir, pinDir, now = () => new Date(), id = randomUUID }) {
  const root = plainDirectory(dir);
  if (root === undefined) throw failure('ARTIFACT_MISSING');
  assertNoInstallation(root);
  if (existsSync(join(root, ARTIFACT_SEAL))) throw failure('ARTIFACT_ALREADY_SEALED');
  const pin = readPin(pinDir);
  const receipt = readJson(join(root, INSTALL_RECEIPT), 'ARTIFACT_NOT_INSTALLED');
  if (receipt.schema !== RECEIPT_SCHEMA) throw failure('ARTIFACT_NOT_INSTALLED');
  assertIdentity(root, pin, receipt);
  assertCompleteDependencyTree(root, pin);
  const seal = {
    schema: SEAL_SCHEMA,
    package: pin.package,
    version: pin.version,
    lockSha256: pin.lockSha256,
    platform: process.platform,
    arch: process.arch,
    installGeneration: receipt.generation,
    sealGeneration: id(),
    sealedAt: now().toISOString(),
    ...treeDigest(hashRuntimeTree(root)),
  };
  writeFileSync(join(root, ARTIFACT_SEAL), `${JSON.stringify(seal, null, 2)}\n`, { flag: 'wx' });
  return seal;
}

function readSeal(root, pin) {
  const seal = readJson(join(root, ARTIFACT_SEAL), 'ARTIFACT_SEAL_INVALID');
  if (seal.schema !== SEAL_SCHEMA || typeof seal.treeSha256 !== 'string') {
    throw failure('ARTIFACT_SEAL_INVALID');
  }
  assertIdentity(root, pin, seal);
  if (seal.platform !== process.platform || seal.arch !== process.arch) {
    throw failure('ARTIFACT_PLATFORM_MISMATCH');
  }
  return seal;
}

// absent/unsealed mean "no verified artifact". A seal that exists must be valid: a bad one is
// reported, never treated as if it were simply missing.
export function inspectRuntimeArtifact({ dir, pinDir }) {
  const root = plainDirectory(dir);
  if (root === undefined) return { status: 'absent' };
  if (!existsSync(join(root, ARTIFACT_SEAL))) return { status: 'unsealed' };
  assertNoInstallation(root);
  const pin = readPin(pinDir);
  const seal = readSeal(root, pin);
  assertCompleteDependencyTree(root, pin);
  return { status: 'sealed', seal };
}

// Each byte written to the stage was hashed in the same read, so a file altered after the seal
// or during the copy cannot publish. The stage is only renamed into place after a full match; an
// interrupted copy remains an unreferenced, uniquely named stage for inspection.
export function promoteRuntimeArtifact({ dir, target, pinDir, id = randomUUID, onCopied }) {
  const inspected = inspectRuntimeArtifact({ dir, pinDir });
  if (inspected.status !== 'sealed') throw failure('ARTIFACT_NOT_SEALED');
  const source = plainDirectory(dir);
  const destination = resolve(target);
  if (existsSync(destination)) throw failure('ARTIFACT_TARGET_EXISTS');
  const stage = `${destination}.promote-${id()}`;
  mkdirSync(stage, { recursive: false, mode: 0o700 });
  const rows = [];
  for (const file of listFiles(source)) {
    const out = join(stage, ...file.rel.split('/'));
    mkdirSync(dirname(out), { recursive: true });
    const fd = openSync(out, 'wx', file.mode & 0o777);
    try {
      const copied = hashFile(file.path, (chunk) => writeSync(fd, chunk));
      rows.push({ rel: file.rel, ...copied });
    } finally {
      closeSync(fd);
    }
    onCopied?.();
  }
  if (treeDigest(rows).treeSha256 !== inspected.seal.treeSha256) {
    rmSync(stage, { recursive: true, force: true });
    throw failure('ARTIFACT_TREE_MISMATCH');
  }
  writeFileSync(join(stage, ARTIFACT_SEAL), `${JSON.stringify(inspected.seal, null, 2)}\n`, {
    flag: 'wx',
  });
  renameSync(stage, destination);
  return inspected.seal;
}

// Compares a packaged copy against its seal. Runtime-relative names only; no contents.
export function verifyPackagedRuntime({ dir, seal, reference }) {
  const actual = hashRuntimeTree(dir);
  const digest = treeDigest(actual);
  const expected = new Map(hashRuntimeTree(reference).map((row) => [row.rel, row]));
  const seen = new Set();
  const changed = [];
  const extra = [];
  for (const row of actual) {
    const original = expected.get(row.rel);
    seen.add(row.rel);
    if (original === undefined) extra.push(row.rel);
    else if (original.sha256 !== row.sha256 || original.size !== row.size) changed.push(row.rel);
  }
  const missing = [...expected.keys()].filter((rel) => !seen.has(rel));
  return {
    matches: digest.treeSha256 === seal.treeSha256,
    ...digest,
    missing: missing.sort(),
    extra: extra.sort(),
    changed: changed.sort(),
  };
}
