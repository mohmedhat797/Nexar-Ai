import { createHash } from 'node:crypto';
import { constants } from 'node:fs';
import { lstat, open, readdir, realpath, writeFile } from 'node:fs/promises';
import { join, relative, isAbsolute, basename } from 'node:path';
import { NexarError } from '@nexar/contracts';

export interface CoworkFile {
  readonly name: string;
  readonly data: string;
  readonly sha256: string;
}
export const COWORK_FILE_LIMIT = 2 * 1024 * 1024;
export const COWORK_TOTAL_LIMIT = 4 * 1024 * 1024;
export const COWORK_HELPER_PROTOCOL = 'nexar-cowork@1';
export const COWORK_HELPER_PROTOCOL_VERSION = 1;
export const COWORK_HELPER_RELEASE = '0.1.0-sec02.1';
export const COWORK_HELPER_CAPABILITIES = [
  'stdio-rpc',
  'gateway-socket',
  'bridge-socket',
  'flat-scratch',
] as const;
const IGNORED_SCRATCH_DIRS: ReadonlySet<string> = new Set(['tool-output', 'workers']);
const NAME =
  /^(?!\.)(?!con(?:\.|$)|prn(?:\.|$)|aux(?:\.|$)|nul(?:\.|$)|com[0-9](?:\.|$)|lpt[0-9](?:\.|$))[A-Za-z0-9][A-Za-z0-9._-]{0,119}$/i;
const fail = (): never => {
  throw new NexarError('POLICY_REJECTED', 'Cowork file transfer rejected');
};

/** A content-only transfer: no remote host paths, links, directories or executable files. */
export function parseCoworkFiles(value: unknown): CoworkFile[] {
  if (!Array.isArray(value) || value.length > 32) return fail();
  const names = new Set<string>();
  let total = 0;
  return value.map((item: unknown) => {
    if (typeof item !== 'object' || item === null) return fail();
    const f = item as Record<string, unknown>;
    if (
      Object.keys(f).sort().join(',') !== 'data,name,sha256' ||
      typeof f.name !== 'string' ||
      !NAME.test(f.name) ||
      /[. ]$/.test(f.name) ||
      typeof f.data !== 'string' ||
      f.data.length > Math.ceil(COWORK_FILE_LIMIT / 3) * 4 ||
      typeof f.sha256 !== 'string' ||
      !/^[a-f0-9]{64}$/.test(f.sha256)
    )
      return fail();
    const bytes = Buffer.from(f.data, 'base64');
    total += bytes.length;
    const name = f.name.toLowerCase();
    if (
      bytes.toString('base64') !== f.data ||
      bytes.length > COWORK_FILE_LIMIT ||
      total > COWORK_TOTAL_LIMIT ||
      names.has(name) ||
      createHash('sha256').update(bytes).digest('hex') !== f.sha256
    )
      return fail();
    names.add(name);
    return { name: f.name, data: f.data, sha256: f.sha256 };
  });
}

/** Opens only an explicitly selected, contained, unchanged single-link regular file. */
export async function readCoworkFile(
  root: string,
  name: string,
  transferName = name,
): Promise<CoworkFile> {
  if (
    !NAME.test(transferName) ||
    name !== basename(name) ||
    /[\\/\0:]/.test(name) ||
    name === '.' ||
    name === '..'
  )
    return fail();
  const canonicalRoot = await realpath(root);
  const target = join(canonicalRoot, name);
  const before = await lstat(target);
  if (
    !before.isFile() ||
    before.isSymbolicLink() ||
    before.nlink !== 1 ||
    before.size > COWORK_FILE_LIMIT
  )
    return fail();
  const canonical = await realpath(target);
  const rel = relative(canonicalRoot, canonical);
  if (rel === '' || rel.startsWith('..') || isAbsolute(rel)) return fail();
  const handle = await open(target, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
  try {
    const current = await handle.stat();
    if (
      current.dev !== before.dev ||
      current.ino !== before.ino ||
      current.nlink !== 1 ||
      current.size !== before.size ||
      current.mtimeMs !== before.mtimeMs
    )
      return fail();
    const bytes = Buffer.alloc(COWORK_FILE_LIMIT + 1);
    const { bytesRead } = await handle.read(bytes, 0, bytes.length, 0);
    const after = await handle.stat();
    if (
      bytesRead !== before.size ||
      bytesRead > COWORK_FILE_LIMIT ||
      after.mtimeMs !== before.mtimeMs ||
      after.size !== before.size ||
      after.nlink !== 1 ||
      (await realpath(target)) !== canonical
    )
      return fail();
    const content = bytes.subarray(0, bytesRead);
    return {
      name: transferName,
      data: content.toString('base64'),
      sha256: createHash('sha256').update(content).digest('hex'),
    };
  } finally {
    await handle.close();
  }
}

/** Destination must be a newly-created private per-turn directory; sources are copied, never mounted. */
export async function stageCoworkFiles(dir: string, files: unknown): Promise<void> {
  for (const file of parseCoworkFiles(files)) {
    await writeFile(join(dir, file.name), Buffer.from(file.data, 'base64'), {
      flag: 'wx',
      mode: 0o600,
    });
  }
}

/**
 * Extracts flat top-level draft outputs from `/work` (`scratch`). Nested user directories are
 * rejected explicitly with a clear diagnostic rather than silently ignored (SEC02-F04).
 */
export async function collectCoworkOutputs(
  scratch: string,
  logger?: { warn(msg: string, fields?: Record<string, unknown>): void },
): Promise<CoworkFile[]> {
  const files: CoworkFile[] = [];
  for (const name of (await readdir(scratch)).sort()) {
    if (IGNORED_SCRATCH_DIRS.has(name)) continue;
    const entryInfo = await lstat(join(scratch, name)).catch(() => undefined);
    if (entryInfo?.isDirectory() === true && !entryInfo.isSymbolicLink()) {
      logger?.warn('cowork nested scratch directory rejected', { entry: name });
      throw new NexarError(
        'POLICY_REJECTED',
        'Cowork outputs must be flat top-level files in /work',
      );
    }
    if (!/\.(md|txt|json|csv)$/i.test(name)) continue;
    try {
      files.push(await readCoworkFile(scratch, name));
    } catch {
      /* Untrusted outputs (links, hard links, oversized files) are never followed. */
    }
  }
  return parseCoworkFiles(files);
}
