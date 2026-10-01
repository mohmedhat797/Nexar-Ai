import { realpath } from 'node:fs/promises';
import { homedir } from 'node:os';
import { isAbsolute, posix } from 'node:path';
import { NexarError, type LaunchMount } from '@nexar/contracts';

const DENIED_SEGMENTS: ReadonlySet<string> = new Set([
  '.ssh',
  '.gnupg',
  '.aws',
  '.azure',
  '.kube',
  '.docker',
  '.netrc',
  '.git-credentials',
  'docker.sock',
  'containerd.sock',
]);
const DENIED_HOST_PREFIXES = ['/proc', '/sys', '/dev', '/run', '/var/run', '/etc'] as const;
/**
 * Locations the profile owns. A mount may not be one of them, sit inside one, or contain one.
 * `/home/agent` itself is the tmpfs home: mounts may go inside it, never replace it or an ancestor.
 */
const RESERVED_SANDBOX_PATHS = [
  '/work',
  '/run',
  '/tmp',
  '/proc',
  '/dev',
  '/sys',
  '/usr',
  '/etc',
  '/bin',
  '/sbin',
  '/lib',
  '/lib64',
  '/var',
  '/boot',
] as const;
const SANDBOX_HOME_PATH = '/home/agent';

export interface MountValidationOptions {
  /** Default `os.homedir()`. */
  readonly homeDir?: string;
}

/** A mount whose host path is canonical and whose sandbox path passed the policy. */
export type ValidatedMount = LaunchMount;

/** Errors never echo the rejected path; they name the rule that failed. */
function reject(what: string, rule: string): NexarError {
  return new NexarError('CONFIGURATION_ERROR', `${what} rejected: ${rule}`, {
    details: { rule },
  });
}

function isSameOrUnder(path: string, base: string): boolean {
  return path === base || path.startsWith(base === '/' ? '/' : `${base}/`);
}

async function canonicalHome(homeDir: string): Promise<string> {
  try {
    return await realpath(homeDir);
  } catch {
    return posix.normalize(homeDir);
  }
}

/**
 * Validates one host path and returns its canonical form (the only form that may be used afterwards).
 * `what` labels the error (e.g. `mount[1]`, `toolchain[0]`, `workspace`).
 */
export async function validateHostPath(
  hostPath: string,
  what: string,
  options: MountValidationOptions = {},
): Promise<string> {
  if (typeof hostPath !== 'string' || !isAbsolute(hostPath) || hostPath.includes('\0')) {
    throw reject(what, 'host path must be absolute');
  }
  let canonical: string;
  try {
    canonical = await realpath(hostPath);
  } catch {
    throw reject(what, 'host path must exist');
  }
  const home = await canonicalHome(options.homeDir ?? homedir());
  if (canonical === '/') {
    throw reject(what, 'host path must not be the filesystem root');
  }
  if (isSameOrUnder(home, canonical)) {
    throw reject(what, 'host path must not be the home directory or one of its ancestors');
  }
  for (const segment of [...canonical.split('/'), ...hostPath.split('/')]) {
    if (DENIED_SEGMENTS.has(segment)) {
      throw reject(what, 'host path contains a denied credential segment');
    }
  }
  if (DENIED_HOST_PREFIXES.some((prefix) => isSameOrUnder(canonical, prefix))) {
    throw reject(what, 'host path is under a denied system location');
  }
  return canonical;
}

function validateSandboxPath(path: string, what: string): void {
  if (typeof path !== 'string' || !isAbsolute(path) || path.includes('\0')) {
    throw reject(what, 'sandbox path must be absolute');
  }
  if (posix.normalize(path) !== path || path.endsWith('/') || path.split('/').includes('..')) {
    throw reject(what, 'sandbox path must be normalized');
  }
  if (
    RESERVED_SANDBOX_PATHS.some(
      (reserved) => isSameOrUnder(path, reserved) || isSameOrUnder(reserved, path),
    )
  ) {
    throw reject(what, 'sandbox path overlaps a reserved location');
  }
  if (isSameOrUnder(SANDBOX_HOME_PATH, path)) {
    throw reject(what, 'sandbox path must not replace the sandbox home or an ancestor of it');
  }
  if (path.split('/').length < 3) {
    throw reject(what, 'sandbox path must be at least two levels deep');
  }
}

/** Validates extra mounts. Returns them with canonical host paths. Fails closed. */
export async function validateMounts(
  mounts: readonly LaunchMount[],
  options: MountValidationOptions = {},
): Promise<ValidatedMount[]> {
  const seen = new Set<string>();
  const result: ValidatedMount[] = [];
  for (const [index, mount] of mounts.entries()) {
    const what = `mount[${index}]`;
    if (mount.access !== 'read-only' && mount.access !== 'read-write') {
      throw reject(what, 'access must be read-only or read-write');
    }
    validateSandboxPath(mount.sandboxPath, what);
    if (seen.has(mount.sandboxPath)) {
      throw reject(what, 'duplicate sandbox path');
    }
    seen.add(mount.sandboxPath);
    const hostPath = await validateHostPath(mount.hostPath, what, options);
    result.push({ hostPath, sandboxPath: mount.sandboxPath, access: mount.access });
  }
  return result;
}

/** Validates toolchain paths (bound read-only at the same path). Returns canonical, de-duplicated paths. */
export async function validateToolchainPaths(
  paths: readonly string[],
  options: MountValidationOptions = {},
): Promise<string[]> {
  const result = new Set<string>();
  for (const [index, path] of paths.entries()) {
    result.add(await validateHostPath(path, `toolchain[${index}]`, options));
  }
  return [...result];
}
