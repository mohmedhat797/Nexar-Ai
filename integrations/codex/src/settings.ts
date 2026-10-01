import { isAbsolute, join, resolve } from 'node:path';
import { NexarError } from '@nexar/contracts';
import type { ResourceDescriptor } from '@nexar/contracts';

export type ReasoningEffort = 'low' | 'medium' | 'high';

/** Egress allowed to a sandboxed Codex when the resource does not say otherwise. */
export const DEFAULT_ALLOW_HOSTS: readonly string[] = [
  'chatgpt.com',
  'auth.openai.com',
  'api.openai.com',
];

/** Validated per-resource settings from `resource.runtime.options`. */
export interface CodexSettings {
  readonly binary?: string;
  readonly model?: string;
  readonly reasoningEffort?: ReasoningEffort;
  readonly timeoutMs?: number;
  /** Host path of the owner's Codex state/login directory; undefined means "use the default". */
  readonly codexHome?: string;
  readonly allowHosts: readonly string[];
}

const KNOWN_KEYS = new Set([
  'binary',
  'model',
  'reasoningEffort',
  'timeoutMs',
  'codexHome',
  'allowHosts',
]);
const EFFORTS: readonly ReasoningEffort[] = ['low', 'medium', 'high'];

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

/** Reads `runtime.options` strictly: unknown keys and wrong types are a CONFIGURATION_ERROR. */
export function readSettings(resource: ResourceDescriptor): CodexSettings {
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

  let binary: string | undefined;
  let model: string | undefined;
  let reasoningEffort: ReasoningEffort | undefined;
  let timeoutMs: number | undefined;
  let codexHome: string | undefined;
  let allowHosts: readonly string[] = DEFAULT_ALLOW_HOSTS;

  if (o['binary'] !== undefined) binary = nonEmptyString(resource, 'binary', o['binary']);
  if (o['model'] !== undefined) {
    model = nonEmptyString(resource, 'model', o['model']);
  } else if (resource.kind.type === 'agent') {
    model = resource.kind.underlying?.model;
  }
  if (o['reasoningEffort'] !== undefined) {
    if (!EFFORTS.includes(o['reasoningEffort'] as ReasoningEffort)) {
      throw bad(resource, 'reasoningEffort', `one of ${EFFORTS.join(', ')}`);
    }
    reasoningEffort = o['reasoningEffort'] as ReasoningEffort;
  }
  if (o['timeoutMs'] !== undefined) {
    const n = o['timeoutMs'];
    if (typeof n !== 'number' || !Number.isFinite(n) || n <= 0) {
      throw bad(resource, 'timeoutMs', 'a positive number');
    }
    timeoutMs = n;
  }
  if (o['codexHome'] !== undefined) {
    const p = nonEmptyString(resource, 'codexHome', o['codexHome']);
    if (!isAbsolute(p)) throw bad(resource, 'codexHome', 'an absolute path');
    codexHome = resolve(p);
  }
  if (o['allowHosts'] !== undefined) {
    const h = o['allowHosts'];
    if (!Array.isArray(h) || h.length === 0 || !h.every((x) => typeof x === 'string' && x !== '')) {
      throw bad(resource, 'allowHosts', 'a non-empty array of non-empty strings');
    }
    allowHosts = h as string[];
  }

  return {
    allowHosts,
    ...(binary !== undefined ? { binary } : {}),
    ...(model !== undefined ? { model } : {}),
    ...(reasoningEffort !== undefined ? { reasoningEffort } : {}),
    ...(timeoutMs !== undefined ? { timeoutMs } : {}),
    ...(codexHome !== undefined ? { codexHome } : {}),
  };
}

/**
 * Where the owner's Codex state lives: the setting, else `$CODEX_HOME` from the adapter's env,
 * else `~/.codex`. Nexar only ever passes this path on; it never opens anything inside it.
 */
export function resolveCodexHome(
  settings: CodexSettings,
  parentEnv: NodeJS.ProcessEnv,
  homeFallback: string,
): string {
  if (settings.codexHome !== undefined) return settings.codexHome;
  const fromEnv = parentEnv['CODEX_HOME'];
  if (fromEnv !== undefined && fromEnv !== '') return resolve(fromEnv);
  return join(parentEnv['HOME'] || homeFallback, '.codex');
}
