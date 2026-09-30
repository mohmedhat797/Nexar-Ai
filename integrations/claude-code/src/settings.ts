import { NexarError } from '@nexar/contracts';
import type { ResourceDescriptor } from '@nexar/contracts';

export type PermissionMode = 'plan' | 'default' | 'acceptEdits';

/** Validated per-resource settings from `resource.runtime.options`. */
export interface ClaudeCodeSettings {
  readonly model?: string;
  readonly permissionMode: PermissionMode;
  readonly tools: readonly string[];
  readonly maxTurns?: number;
  readonly timeoutMs?: number;
}

const PERMISSION_MODES: readonly PermissionMode[] = ['plan', 'default', 'acceptEdits'];
/** Read-only tool surface. */
export const DEFAULT_TOOLS: readonly string[] = ['Read', 'Glob', 'Grep'];

function bad(resource: ResourceDescriptor, key: string, expected: string): NexarError {
  return new NexarError(
    'CONFIGURATION_ERROR',
    `Resource '${resource.id}': runtime.options.${key} must be ${expected}`,
    { details: { resourceId: resource.id, option: key } },
  );
}

/** Reads the known option keys (unknown ones are ignored); wrong types are a CONFIGURATION_ERROR. */
export function readSettings(resource: ResourceDescriptor): ClaudeCodeSettings {
  const o = resource.runtime.options ?? {};
  let model: string | undefined;
  let permissionMode: PermissionMode = 'plan';
  let tools: readonly string[] = DEFAULT_TOOLS;
  let maxTurns: number | undefined;
  let timeoutMs: number | undefined;

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

  return {
    permissionMode,
    tools,
    ...(model !== undefined ? { model } : {}),
    ...(maxTurns !== undefined ? { maxTurns } : {}),
    ...(timeoutMs !== undefined ? { timeoutMs } : {}),
  };
}
