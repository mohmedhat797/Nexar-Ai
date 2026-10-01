import { NexarError } from '@nexar/contracts';

export type PermissionMode = 'ask' | 'allow-listed' | 'deny';

export interface PermissionPolicy {
  readonly mode: PermissionMode;
  readonly allowTools: readonly string[];
  readonly ttlMs: number;
}

/** Validated `runtime.options.acp` for engineering lanes. */
export interface AcpOptions {
  readonly permissions: PermissionPolicy;
  /** Exact egress hosts for the sandbox proxy. */
  readonly allowHosts: readonly string[];
}

export const DEFAULT_APPROVAL_TTL_MS = 10 * 60_000;
export const DEFAULT_ALLOW_HOSTS: readonly string[] = ['api.deepseek.com'];

const PERMISSION_MODES: readonly PermissionMode[] = ['ask', 'allow-listed', 'deny'];

function bad(message: string): NexarError {
  return new NexarError('CONFIGURATION_ERROR', `deepseek-harness runtime.options.acp: ${message}`);
}

function asObject(value: unknown, what: string): Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw bad(`'${what}' must be an object`);
  }
  return value as Record<string, unknown>;
}

function rejectUnknownKeys(
  raw: Record<string, unknown>,
  allowed: readonly string[],
  prefix: string,
): void {
  for (const key of Object.keys(raw)) {
    if (!allowed.includes(key)) throw bad(`unknown setting '${prefix}${key}'`);
  }
}

function stringList(value: unknown, what: string): string[] {
  if (
    !Array.isArray(value) ||
    !value.every((v): v is string => typeof v === 'string' && v.length > 0)
  ) {
    throw bad(`'${what}' must be an array of non-empty strings`);
  }
  return [...value];
}

/** Strictly validates the `acp` settings object; unknown keys and wrong types are `CONFIGURATION_ERROR`. */
export function parseAcpOptions(value: unknown): AcpOptions {
  const raw = value === undefined ? {} : asObject(value, 'acp');
  rejectUnknownKeys(raw, ['permissions', 'allowHosts'], '');

  const permRaw = raw.permissions === undefined ? {} : asObject(raw.permissions, 'permissions');
  rejectUnknownKeys(permRaw, ['mode', 'allowTools', 'ttlMs'], 'permissions.');

  const mode = permRaw.mode ?? 'ask';
  if (typeof mode !== 'string' || !PERMISSION_MODES.includes(mode as PermissionMode)) {
    throw bad(`'permissions.mode' must be one of ${PERMISSION_MODES.join(', ')}`);
  }
  const allowTools =
    permRaw.allowTools === undefined
      ? []
      : stringList(permRaw.allowTools, 'permissions.allowTools');
  if (allowTools.length > 0 && mode !== 'allow-listed') {
    throw bad(`'permissions.allowTools' is only valid with mode 'allow-listed'`);
  }
  const ttl = permRaw.ttlMs ?? DEFAULT_APPROVAL_TTL_MS;
  if (typeof ttl !== 'number' || !Number.isInteger(ttl) || ttl <= 0) {
    throw bad(`'permissions.ttlMs' must be a positive integer`);
  }

  const allowHosts =
    raw.allowHosts === undefined
      ? [...DEFAULT_ALLOW_HOSTS]
      : stringList(raw.allowHosts, 'allowHosts');

  return {
    permissions: { mode: mode as PermissionMode, allowTools, ttlMs: ttl },
    allowHosts,
  };
}
