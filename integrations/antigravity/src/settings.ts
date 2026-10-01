import { NexarError } from '@nexar/contracts';
import type { LaunchMount, ResourceDescriptor } from '@nexar/contracts';

export type AgyEffort = 'low' | 'medium' | 'high' | 'max';

/** Egress allowed to a sandboxed `agy` when the resource does not say otherwise. */
export const DEFAULT_ALLOW_HOSTS: readonly string[] = [
  'cloudcode-pa.googleapis.com',
  'oauth2.googleapis.com',
  'www.googleapis.com',
];

/** Validated per-resource settings from `resource.runtime.options`. */
export interface AntigravitySettings {
  /** Must be `true` for `execute`: the adapter is experimental and opt-in. */
  readonly acknowledgeExperimental: boolean;
  readonly binary?: string;
  readonly model?: string;
  readonly effort?: AgyEffort;
  readonly timeoutMs?: number;
  readonly allowHosts: readonly string[];
  /** Owner-declared narrow state/credential mounts, passed to the launcher; Nexar never reads them. */
  readonly mounts?: readonly LaunchMount[];
}

// `agyHome` is accepted and ignored: it only documents where `agy` keeps state (`~/.gemini/...`).
const KNOWN_KEYS = new Set([
  'acknowledgeExperimental',
  'binary',
  'model',
  'effort',
  'timeoutMs',
  'allowHosts',
  'sandbox',
  'agyHome',
]);
const EFFORTS: readonly AgyEffort[] = ['low', 'medium', 'high', 'max'];

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

function bad(resource: ResourceDescriptor, key: string, expected: string): NexarError {
  return new NexarError(
    'CONFIGURATION_ERROR',
    `Resource '${resource.id}': runtime.options.${key} must be ${expected}`,
    { details: { resourceId: resource.id, option: key } },
  );
}

function nonEmptyString(resource: ResourceDescriptor, key: string, v: unknown): string {
  if (typeof v !== 'string' || v === '') throw bad(resource, key, 'a non-empty string');
  return v;
}

function readMounts(resource: ResourceDescriptor, v: unknown): LaunchMount[] {
  if (!isRecord(v)) throw bad(resource, 'sandbox', 'an object');
  for (const key of Object.keys(v)) {
    if (key !== 'mounts') throw bad(resource, 'sandbox', 'an object with only a mounts key');
  }
  if (v['mounts'] === undefined) return [];
  const expected = 'an array of { hostPath, sandboxPath, access: read-only | read-write }';
  const m = v['mounts'];
  if (!Array.isArray(m)) throw bad(resource, 'sandbox.mounts', expected);
  return m.map((entry: unknown): LaunchMount => {
    if (
      !isRecord(entry) ||
      typeof entry['hostPath'] !== 'string' ||
      entry['hostPath'] === '' ||
      typeof entry['sandboxPath'] !== 'string' ||
      entry['sandboxPath'] === '' ||
      (entry['access'] !== 'read-only' && entry['access'] !== 'read-write')
    ) {
      throw bad(resource, 'sandbox.mounts', expected);
    }
    return {
      hostPath: entry['hostPath'],
      sandboxPath: entry['sandboxPath'],
      access: entry['access'],
    };
  });
}

/** Reads `runtime.options` strictly: unknown keys and wrong types are a CONFIGURATION_ERROR. */
export function readSettings(resource: ResourceDescriptor): AntigravitySettings {
  const o = resource.runtime.options ?? {};
  for (const key of Object.keys(o)) {
    if (!KNOWN_KEYS.has(key)) {
      throw new NexarError(
        'CONFIGURATION_ERROR',
        `Resource '${resource.id}': unknown runtime.options key '${key}'`,
        { details: { resourceId: resource.id, option: key } },
      );
    }
  }

  let acknowledgeExperimental = false;
  let binary: string | undefined;
  let model: string | undefined;
  let effort: AgyEffort | undefined;
  let timeoutMs: number | undefined;
  let allowHosts: readonly string[] = DEFAULT_ALLOW_HOSTS;
  let mounts: LaunchMount[] | undefined;

  if (o['acknowledgeExperimental'] !== undefined) {
    if (typeof o['acknowledgeExperimental'] !== 'boolean') {
      throw bad(resource, 'acknowledgeExperimental', 'a boolean');
    }
    acknowledgeExperimental = o['acknowledgeExperimental'];
  }
  if (o['binary'] !== undefined) binary = nonEmptyString(resource, 'binary', o['binary']);
  if (o['model'] !== undefined) {
    model = nonEmptyString(resource, 'model', o['model']);
  } else if (resource.kind.type === 'agent') {
    model = resource.kind.underlying?.model;
  }
  if (o['effort'] !== undefined) {
    if (!EFFORTS.includes(o['effort'] as AgyEffort)) {
      throw bad(resource, 'effort', `one of ${EFFORTS.join(', ')}`);
    }
    effort = o['effort'] as AgyEffort;
  }
  if (o['timeoutMs'] !== undefined) {
    const n = o['timeoutMs'];
    if (typeof n !== 'number' || !Number.isFinite(n) || n <= 0) {
      throw bad(resource, 'timeoutMs', 'a positive number');
    }
    timeoutMs = n;
  }
  if (o['allowHosts'] !== undefined) {
    const h = o['allowHosts'];
    if (!Array.isArray(h) || h.length === 0 || !h.every((x) => typeof x === 'string' && x !== '')) {
      throw bad(resource, 'allowHosts', 'a non-empty array of non-empty strings');
    }
    allowHosts = h as string[];
  }
  if (o['sandbox'] !== undefined) mounts = readMounts(resource, o['sandbox']);
  if (o['agyHome'] !== undefined) nonEmptyString(resource, 'agyHome', o['agyHome']);

  return {
    acknowledgeExperimental,
    allowHosts,
    ...(binary !== undefined ? { binary } : {}),
    ...(model !== undefined ? { model } : {}),
    ...(effort !== undefined ? { effort } : {}),
    ...(timeoutMs !== undefined ? { timeoutMs } : {}),
    ...(mounts !== undefined ? { mounts } : {}),
  };
}
