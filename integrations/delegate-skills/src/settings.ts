import { isAbsolute, join, resolve } from 'node:path';
import { NexarError } from '@nexar/contracts';
import type { ResourceDescriptor } from '@nexar/contracts';

export type ReasoningEffort = 'low' | 'medium' | 'high';

/** Egress allowed to the relayed Codex when the resource does not say otherwise. */
export const DEFAULT_ALLOW_HOSTS: readonly string[] = [
  'chatgpt.com',
  'auth.openai.com',
  'api.openai.com',
];

export const DEFAULT_TIMEOUT = '30m';
/** The relay rejects longer watchdogs ("about 24 days"); this also keeps `setTimeout` in range. */
const MAX_TIMEOUT_MS = 24 * 24 * 60 * 60 * 1000;

/** Validated per-resource settings from `resource.runtime.options`. */
export interface DelegateSkillsSettings {
  readonly relay: 'codex';
  /** Absolute host path of the owner-installed `relay.mjs`. */
  readonly relayPath: string;
  /** Lowercase hex sha256 the relay file must match before every run and probe. */
  readonly relaySha256: string;
  readonly nodePath: string;
  readonly model?: string;
  readonly effort?: ReasoningEffort;
  /** Relay duration string such as `30m` or `1h30m`. */
  readonly timeout: string;
  readonly timeoutMs: number;
  /** Host path of the owner's Codex directory; undefined means "use the default". */
  readonly codexHome?: string;
  readonly allowHosts: readonly string[];
}

const KNOWN_KEYS = new Set([
  'relay',
  'relayPath',
  'relaySha256',
  'nodePath',
  'model',
  'effort',
  'timeout',
  'codexHome',
  'allowHosts',
]);
const EFFORTS: readonly ReasoningEffort[] = ['low', 'medium', 'high'];
const SHA256 = /^[0-9a-fA-F]{64}$/;

function fail(resource: ResourceDescriptor, option: string, message: string): NexarError {
  return new NexarError('CONFIGURATION_ERROR', `Resource '${resource.id}': ${message}`, {
    details: { resourceId: resource.id, option },
  });
}

function bad(resource: ResourceDescriptor, key: string, expected: string): NexarError {
  return fail(resource, key, `runtime.options.${key} must be ${expected}`);
}

function nonEmptyString(resource: ResourceDescriptor, key: string, v: unknown): string {
  if (typeof v !== 'string' || v === '') throw bad(resource, key, 'a non-empty string');
  return v;
}

function absolutePath(resource: ResourceDescriptor, key: string, v: unknown): string {
  const p = nonEmptyString(resource, key, v);
  if (!isAbsolute(p)) throw bad(resource, key, 'an absolute path');
  return resolve(p);
}

/** Milliseconds of a relay duration (`1h30m`, `45s`), or undefined when invalid, zero or too long. */
export function parseRelayDuration(duration: string): number | undefined {
  const match = /^(?:(\d+)h)?(?:(\d+)m)?(?:(\d+)s)?$/.exec(duration);
  if (match === null || duration === '') return undefined;
  const seconds = Number(match[1] ?? 0) * 3600 + Number(match[2] ?? 0) * 60 + Number(match[3] ?? 0);
  const ms = seconds * 1000;
  return ms > 0 && ms <= MAX_TIMEOUT_MS ? ms : undefined;
}

function unsupportedRelay(resource: ResourceDescriptor, relay: unknown): NexarError {
  if (relay === 'claude') {
    return fail(
      resource,
      'relay',
      "relay 'claude' is not supported: the claude relay cannot run nested inside the Nexar " +
        'sandbox; use the native claude-code adapter instead',
    );
  }
  if (relay === 'agy') {
    return fail(
      resource,
      'relay',
      "relay 'agy' is not supported here; use the experimental antigravity adapter instead",
    );
  }
  return fail(
    resource,
    'relay',
    "runtime.options.relay must be 'codex'; other relays are unsupported in v0.3",
  );
}

/** Reads `runtime.options` strictly: unknown keys and wrong types are a CONFIGURATION_ERROR. */
export function readSettings(resource: ResourceDescriptor): DelegateSkillsSettings {
  const o = resource.runtime.options ?? {};
  for (const key of Object.keys(o)) {
    if (!KNOWN_KEYS.has(key)) {
      throw fail(resource, key, `unknown runtime.options key '${key}'`);
    }
  }

  if (o['relay'] === undefined) throw bad(resource, 'relay', "'codex'");
  if (o['relay'] !== 'codex') throw unsupportedRelay(resource, o['relay']);
  if (o['relayPath'] === undefined) throw bad(resource, 'relayPath', 'an absolute path');
  const relayPath = absolutePath(resource, 'relayPath', o['relayPath']);

  const sha = o['relaySha256'];
  if (typeof sha !== 'string' || !SHA256.test(sha)) {
    throw bad(resource, 'relaySha256', 'a 64-character hex sha256 of the relay script');
  }

  const nodePath =
    o['nodePath'] === undefined ? 'node' : nonEmptyString(resource, 'nodePath', o['nodePath']);

  let model: string | undefined;
  if (o['model'] !== undefined) {
    model = nonEmptyString(resource, 'model', o['model']);
  } else if (resource.kind.type === 'agent') {
    model = resource.kind.underlying?.model;
  }

  let effort: ReasoningEffort | undefined;
  if (o['effort'] !== undefined) {
    if (!EFFORTS.includes(o['effort'] as ReasoningEffort)) {
      throw bad(resource, 'effort', `one of ${EFFORTS.join(', ')}`);
    }
    effort = o['effort'] as ReasoningEffort;
  }

  const timeout =
    o['timeout'] === undefined
      ? DEFAULT_TIMEOUT
      : nonEmptyString(resource, 'timeout', o['timeout']);
  const timeoutMs = parseRelayDuration(timeout);
  if (timeoutMs === undefined) {
    throw bad(resource, 'timeout', "a positive duration such as '30m', '2h' or '1h30m'");
  }

  let codexHome: string | undefined;
  if (o['codexHome'] !== undefined) codexHome = absolutePath(resource, 'codexHome', o['codexHome']);

  let allowHosts: readonly string[] = DEFAULT_ALLOW_HOSTS;
  if (o['allowHosts'] !== undefined) {
    const h = o['allowHosts'];
    if (!Array.isArray(h) || h.length === 0 || !h.every((x) => typeof x === 'string' && x !== '')) {
      throw bad(resource, 'allowHosts', 'a non-empty array of non-empty strings');
    }
    allowHosts = h as string[];
  }

  return {
    relay: 'codex',
    relayPath,
    relaySha256: sha.toLowerCase(),
    nodePath,
    timeout,
    timeoutMs,
    allowHosts,
    ...(model !== undefined ? { model } : {}),
    ...(effort !== undefined ? { effort } : {}),
    ...(codexHome !== undefined ? { codexHome } : {}),
  };
}

/**
 * Where the owner's Codex state lives: the setting, else `$CODEX_HOME` from the adapter's env,
 * else `~/.codex`. Nexar only ever passes this path on; it never opens anything inside it.
 */
export function resolveCodexHome(
  settings: DelegateSkillsSettings,
  parentEnv: NodeJS.ProcessEnv,
  homeFallback: string,
): string {
  if (settings.codexHome !== undefined) return settings.codexHome;
  const fromEnv = parentEnv['CODEX_HOME'];
  if (fromEnv !== undefined && fromEnv !== '') return resolve(fromEnv);
  return join(parentEnv['HOME'] || homeFallback, '.codex');
}
