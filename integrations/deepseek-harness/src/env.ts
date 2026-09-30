import { join } from 'node:path';
import type { ResourceDescriptor } from '@nexar/contracts';
import type { PiAiProviders } from './overlay.js';

const BASE_ENV_NAMES = ['PATH', 'HOME', 'USER', 'LANG', 'LC_ALL', 'TMPDIR', 'TERM', 'NODE_OPTIONS'];

export interface DshEnvOptions {
  readonly stateDir: string;
  readonly piAiProviders?: PiAiProviders | undefined;
}

/** The env var named by the resource's credential reference, if it is an env reference. */
export function credentialEnvName(resource: Pick<ResourceDescriptor, 'auth'>): string | undefined {
  const { auth } = resource;
  if (auth.mode === 'none') return undefined;
  return auth.credential.source === 'env' ? auth.credential.name : undefined;
}

/** Only the allowlisted names, each copied only when present in the parent env. */
function pick(parentEnv: NodeJS.ProcessEnv, names: readonly string[]): Record<string, string> {
  const out: Record<string, string> = {};
  for (const name of names) {
    const value = parentEnv[name];
    if (value !== undefined) out[name] = value;
  }
  return out;
}

/** The home directory DSH keeps its own state in, isolated from the user's real `~/.dsh`. */
export function dshHome(stateDir: string): string {
  return join(stateDir, 'home');
}

/** Minimal env for runs that never need credentials (e.g. `--version`). */
export function buildBaseEnv(
  parentEnv: NodeJS.ProcessEnv,
  stateDir: string,
): Record<string, string> {
  return { ...pick(parentEnv, BASE_ENV_NAMES), DSH_HOME: dshHome(stateDir) };
}

/**
 * Builds the explicit, minimal environment for a `dsh` runtime: an allowlist plus the
 * resource's own credential variable and any `piAiProviders` key variables.
 */
export function buildDshEnv(
  parentEnv: NodeJS.ProcessEnv,
  resource: Pick<ResourceDescriptor, 'auth'>,
  options: DshEnvOptions,
): Record<string, string> {
  const credentialNames: string[] = [];
  const own = credentialEnvName(resource);
  if (own !== undefined) credentialNames.push(own);
  for (const entry of Object.values(options.piAiProviders ?? {})) {
    credentialNames.push(entry.apiKeyEnv);
  }
  return { ...buildBaseEnv(parentEnv, options.stateDir), ...pick(parentEnv, credentialNames) };
}
