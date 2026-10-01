import { NexarError } from '@nexar/contracts';
import type { LaunchMount, ResourceDescriptor } from '@nexar/contracts';

export type PermissionMode = 'plan' | 'default' | 'acceptEdits';

/** Owner-declared sandbox options for engineering lanes (`runtime.options.sandbox`). */
export interface ClaudeCodeSandboxSettings {
  /** Egress allowlist; the adapter defaults it to {@link DEFAULT_ALLOW_HOSTS}. */
  readonly allowHosts?: readonly string[];
  /** Narrow credential mounts, passed to the launcher unchanged and never opened by Nexar. */
  readonly mounts?: readonly LaunchMount[];
}

/** Validated per-resource settings from `resource.runtime.options`. */
export interface ClaudeCodeSettings {
  readonly model?: string;
  readonly permissionMode: PermissionMode;
  readonly tools: readonly string[];
  readonly maxTurns?: number;
  readonly timeoutMs?: number;
  readonly sandbox?: ClaudeCodeSandboxSettings;
  /** Timeout for runs with an engineering workspace. */
  readonly engineeringTimeoutMs?: number;
}

const PERMISSION_MODES: readonly PermissionMode[] = ['plan', 'default', 'acceptEdits'];
/** Read-only tool surface. */
export const DEFAULT_TOOLS: readonly string[] = ['Read', 'Glob', 'Grep'];

/** Hosts Claude Code needs for API calls and OAuth refresh. */
export const DEFAULT_ALLOW_HOSTS: readonly string[] = [
  'api.anthropic.com',
  'claude.ai',
  'platform.claude.com',
];

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

function readSandbox(resource: ResourceDescriptor, v: unknown): ClaudeCodeSandboxSettings {
  if (!isRecord(v)) throw bad(resource, 'sandbox', 'an object');
  let allowHosts: string[] | undefined;
  let mounts: LaunchMount[] | undefined;

  if (v['allowHosts'] !== undefined) {
    const h = v['allowHosts'];
    if (!Array.isArray(h) || !h.every((x) => typeof x === 'string' && x !== '')) {
      throw bad(resource, 'sandbox.allowHosts', 'an array of non-empty strings');
    }
    allowHosts = h as string[];
  }

  if (v['mounts'] !== undefined) {
    const m = v['mounts'];
    const expected = 'an array of { hostPath, sandboxPath, access: read-only | read-write }';
    if (!Array.isArray(m)) throw bad(resource, 'sandbox.mounts', expected);
    mounts = m.map((entry: unknown): LaunchMount => {
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

  return {
    ...(allowHosts !== undefined ? { allowHosts } : {}),
    ...(mounts !== undefined ? { mounts } : {}),
  };
}

/** Reads the known option keys (unknown ones are ignored); wrong types are a CONFIGURATION_ERROR. */
export function readSettings(resource: ResourceDescriptor): ClaudeCodeSettings {
  const o = resource.runtime.options ?? {};
  let model: string | undefined;
  let permissionMode: PermissionMode = 'plan';
  let tools: readonly string[] = DEFAULT_TOOLS;
  let maxTurns: number | undefined;
  let timeoutMs: number | undefined;
  let sandbox: ClaudeCodeSandboxSettings | undefined;
  let engineeringTimeoutMs: number | undefined;

  if (o['model'] !== undefined) {
    if (typeof o['model'] !== 'string' || o['model'] === '') {
      throw bad(resource, 'model', 'a non-empty string');
    }
    model = o['model'];
  } else if (resource.kind.type === 'agent') {
    model = resource.kind.underlying?.model;
  }

  const mode = o['permissionMode'];
  if (mode !== undefined) {
    if (!PERMISSION_MODES.includes(mode as PermissionMode)) {
      throw bad(resource, 'permissionMode', `one of ${PERMISSION_MODES.join(', ')}`);
    }
    permissionMode = mode as PermissionMode;
  }

  const t = o['tools'];
  if (t !== undefined) {
    if (!Array.isArray(t) || !t.every((x) => typeof x === 'string' && x !== '')) {
      throw bad(resource, 'tools', 'an array of non-empty strings');
    }
    tools = t as string[];
  }

  if (o['maxTurns'] !== undefined) {
    const n = o['maxTurns'];
    if (typeof n !== 'number' || !Number.isInteger(n) || n < 1) {
      throw bad(resource, 'maxTurns', 'a positive integer');
    }
    maxTurns = n;
  }

  if (o['timeoutMs'] !== undefined) {
    const n = o['timeoutMs'];
    if (typeof n !== 'number' || !Number.isFinite(n) || n <= 0) {
      throw bad(resource, 'timeoutMs', 'a positive number');
    }
    timeoutMs = n;
  }

  if (o['sandbox'] !== undefined) sandbox = readSandbox(resource, o['sandbox']);

  if (o['engineeringTimeoutMs'] !== undefined) {
    const n = o['engineeringTimeoutMs'];
    if (typeof n !== 'number' || !Number.isFinite(n) || n <= 0) {
      throw bad(resource, 'engineeringTimeoutMs', 'a positive number');
    }
    engineeringTimeoutMs = n;
  }

  return {
    permissionMode,
    tools,
    ...(model !== undefined ? { model } : {}),
    ...(maxTurns !== undefined ? { maxTurns } : {}),
    ...(timeoutMs !== undefined ? { timeoutMs } : {}),
    ...(sandbox !== undefined ? { sandbox } : {}),
    ...(engineeringTimeoutMs !== undefined ? { engineeringTimeoutMs } : {}),
  };
}
