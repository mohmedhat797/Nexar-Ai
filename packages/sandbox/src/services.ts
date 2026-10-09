import { lstat, realpath, stat } from 'node:fs/promises';
import { isAbsolute, posix } from 'node:path';
import { NexarError, type LaunchServices } from '@nexar/contracts';

/** Errors name the rule, never the rejected path. */
function reject(rule: string): NexarError {
  return new NexarError('VALIDATION_ERROR', `Sandbox services rejected: ${rule}`, {
    details: { rule },
  });
}

/**
 * Validates the Nexar services mount (ADR-027 section 9b) and returns it with canonical host paths.
 * Nothing is created or spawned here: a bad spec fails before any per-launch state exists.
 */
export async function validateServices(services: LaunchServices): Promise<LaunchServices> {
  if (!services.gateway && !services.bridge) {
    throw reject('at least one of gateway and bridge is required');
  }
  const { dir } = services;
  if (typeof dir !== 'string' || !isAbsolute(dir) || dir.includes('\0')) {
    throw reject('dir must be absolute');
  }
  const info = await lstat(dir).catch(() => undefined);
  if (info === undefined || info.isSymbolicLink() || !info.isDirectory()) {
    throw reject('dir must be a real directory');
  }
  if ((await realpath(dir)) !== posix.normalize(dir)) {
    throw reject('dir must be canonical');
  }
  if ((info.mode & 0o077) !== 0) {
    throw reject('dir must not be accessible to group or others');
  }
  const uid = process.getuid?.();
  if (uid !== undefined && info.uid !== uid) {
    throw reject('dir must be owned by the current user');
  }

  let relayScript: string | undefined;
  if (services.relayScript !== undefined) {
    const script = services.relayScript;
    if (typeof script !== 'string' || !isAbsolute(script) || script.includes('\0')) {
      throw reject('relayScript must be absolute');
    }
    const canonical = await realpath(script).catch(() => undefined);
    const file = canonical === undefined ? undefined : await stat(canonical).catch(() => undefined);
    if (canonical === undefined || file === undefined || !file.isFile()) {
      throw reject('relayScript must be a regular file');
    }
    relayScript = canonical;
  }
  return {
    dir,
    gateway: services.gateway,
    bridge: services.bridge,
    ...(relayScript === undefined ? {} : { relayScript }),
  };
}
