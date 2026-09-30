import { createHash } from 'node:crypto';
import { NexarError } from '@nexar/contracts';
import type { OutwardAction } from './types.js';

export const ACTION_TYPE_PATTERN = /^[a-z][a-z0-9-]*(\.[a-z][a-z0-9-]*)+$/;
export const MAX_TARGET_LENGTH = 200;

function invalid(path: string, what: string): NexarError {
  return new NexarError('VALIDATION_ERROR', `Cannot canonicalize ${path}: ${what}`, {
    details: { path, what },
  });
}

function encode(value: unknown, path: string, ancestors: Set<object>): string {
  if (value === null) return 'null';
  switch (typeof value) {
    case 'string':
    case 'boolean':
      return JSON.stringify(value);
    case 'number':
      if (!Number.isFinite(value)) throw invalid(path, 'non-finite number');
      return JSON.stringify(value);
    case 'object':
      break;
    default:
      throw invalid(path, `unsupported ${typeof value}`);
  }
  const obj = value;
  if (ancestors.has(obj)) throw invalid(path, 'cycle');
  ancestors.add(obj);
  try {
    if (Array.isArray(obj)) {
      const items: string[] = [];
      for (let i = 0; i < obj.length; i++) {
        if (!(i in obj)) throw invalid(`${path}[${i}]`, 'sparse array hole');
        items.push(encode(obj[i], `${path}[${i}]`, ancestors));
      }
      return `[${items.join(',')}]`;
    }
    const proto = Object.getPrototypeOf(obj) as unknown;
    if (proto !== Object.prototype && proto !== null) throw invalid(path, 'non-plain object');
    const record = obj as Record<string, unknown>;
    const parts = Object.keys(record)
      .sort()
      .map((k) => `${JSON.stringify(k)}:${encode(record[k], `${path}.${k}`, ancestors)}`);
    return `{${parts.join(',')}}`;
  } finally {
    ancestors.delete(obj);
  }
}

/** Deterministic JSON (recursively sorted keys). Throws `VALIDATION_ERROR` for non-JSON values. */
export function canonicalJson(value: unknown): string {
  return encode(value, '$', new Set());
}

/** Validates the shape of an action (type pattern, target length). */
export function assertOutwardAction(action: OutwardAction): void {
  if (typeof action !== 'object' || action === null) {
    throw new NexarError('VALIDATION_ERROR', 'Outward action must be an object');
  }
  if (typeof action.type !== 'string' || !ACTION_TYPE_PATTERN.test(action.type)) {
    throw new NexarError(
      'VALIDATION_ERROR',
      `Invalid action type: must match ${String(ACTION_TYPE_PATTERN)}`,
    );
  }
  if (typeof action.target !== 'string' || action.target.length > MAX_TARGET_LENGTH) {
    throw new NexarError(
      'VALIDATION_ERROR',
      `Invalid action target: must be a string of at most ${MAX_TARGET_LENGTH} characters`,
    );
  }
}

/** sha256 hex of the canonical JSON of the whole action (type, target and parameters). */
export function fingerprintAction(action: OutwardAction): string {
  assertOutwardAction(action);
  return createHash('sha256').update(canonicalJson(action)).digest('hex');
}
