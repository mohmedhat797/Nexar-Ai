import { join } from 'node:path';
import { NexarError } from '@nexar/contracts';
import type { ResourceDescriptor, SecretResolver } from '@nexar/contracts';
import { piAiProviderVariable } from './overlay.js';
import type { CredentialVariable, PiAiProviders } from './overlay.js';

const BASE_ENV_NAMES = ['PATH', 'HOME', 'USER', 'LANG', 'LC_ALL', 'TMPDIR', 'TERM', 'NODE_OPTIONS'];
/** Variables Nexar sets itself; a key store entry may never overwrite them. */
const RESERVED_ENV_NAMES: ReadonlySet<string> = new Set([...BASE_ENV_NAMES, 'DSH_HOME']);

export interface DshEnvOptions {
  readonly stateDir: string;
  readonly piAiProviders?: PiAiProviders | undefined;
  /** Resolves `keystore` credentials. Without it a keystore credential is simply not stored. */
  readonly resolveSecret?: SecretResolver | undefined;
}

/** Where credential values come from: the adapter environment and the (optional) key store. */
export interface CredentialSources {
  readonly env: NodeJS.ProcessEnv;
  readonly resolveSecret?: SecretResolver | undefined;
}

/**
 * The variable (name and source) the resource's credential reference supplies: the env var of an
 * `env` reference or the key store name of a `keystore` reference. Runtime-managed credentials
 * supply no variable.
 */
export function credentialVariable(
  resource: Pick<ResourceDescriptor, 'auth'>,
): CredentialVariable | undefined {
  const { auth } = resource;
  if (auth.mode === 'none') return undefined;
  const { credential } = auth;
  return credential.source === 'env' || credential.source === 'keystore'
    ? { source: credential.source, name: credential.name }
    : undefined;
}

/** The value for one credential variable; empty or absent keystore values count as not stored. */
function resolveVariable(
  variable: CredentialVariable,
  sources: CredentialSources,
): string | undefined {
  if (variable.source === 'env') return sources.env[variable.name];
  const value = sources.resolveSecret?.(variable.name);
  return value === undefined || value === '' ? undefined : value;
}

/** The resource's own credential value (`undefined` when absent). */
export function resolveOwnCredential(
  resource: Pick<ResourceDescriptor, 'auth'>,
  sources: CredentialSources,
): string | undefined {
  const variable = credentialVariable(resource);
  return variable === undefined ? undefined : resolveVariable(variable, sources);
}

/**
 * Throws `AUTH_REQUIRED` when the resource's credential is a `keystore` reference that holds no
 * value. Never reads the environment for it and never mentions or returns a value.
 */
export function assertKeystoreCredentialStored(
  resource: Pick<ResourceDescriptor, 'auth'>,
  sources: CredentialSources,
): void {
  const variable = credentialVariable(resource);
  if (variable?.source !== 'keystore') return;
  if (resolveVariable(variable, sources) === undefined) {
    throw new NexarError(
      'AUTH_REQUIRED',
      `Credential ${variable.name} is not stored in the Nexar key store`,
      { details: { keystore: variable.name } },
    );
  }
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
 * Builds the explicit, minimal environment for a `dsh` runtime: an allowlist plus exactly the
 * variables the resource's own credential and any `piAiProviders` entries name. Env-sourced
 * variables come from the parent env; keystore-sourced ones only from the resolver (never from the
 * parent env). The same name requested from both sources is ambiguous and rejected.
 */
export function buildDshEnv(
  parentEnv: NodeJS.ProcessEnv,
  resource: Pick<ResourceDescriptor, 'auth'>,
  options: DshEnvOptions,
): Record<string, string> {
  const variables: CredentialVariable[] = [];
  const own = credentialVariable(resource);
  if (own !== undefined) variables.push(own);
  for (const entry of Object.values(options.piAiProviders ?? {})) {
    variables.push(piAiProviderVariable(entry));
  }

  const sources: CredentialSources = { env: parentEnv, resolveSecret: options.resolveSecret };
  const credentials: Record<string, string> = {};
  const seen = new Map<string, CredentialVariable['source']>();
  for (const variable of variables) {
    const previous = seen.get(variable.name);
    if (previous !== undefined && previous !== variable.source) {
      throw new NexarError(
        'CONFIGURATION_ERROR',
        `credential variable ${variable.name} is requested from both the environment and the key store`,
      );
    }
    seen.set(variable.name, variable.source);
    if (variable.source === 'keystore' && RESERVED_ENV_NAMES.has(variable.name)) {
      throw new NexarError(
        'CONFIGURATION_ERROR',
        `key store name ${variable.name} collides with a variable Nexar sets for the runtime`,
      );
    }
    const value = resolveVariable(variable, sources);
    if (value !== undefined) credentials[variable.name] = value;
  }
  return { ...buildBaseEnv(parentEnv, options.stateDir), ...credentials };
}
