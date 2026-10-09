import path from 'node:path';
import type { PermissionDecisionInput } from './acp/permissions.js';

export type CoworkPermission = 'read-only' | 'drafts-only' | 'ask-before-write';

export type CoworkDecisionReason =
  | 'bridge-tool'
  | 'draft-in-scratch'
  | 'read-only'
  | 'owner-approval-required'
  | 'unsupported-tool'
  | 'invalid-path'
  | 'outside-scratch'
  | 'escalation-denied';

export interface CoworkDecision {
  readonly decision: 'allow' | 'reject' | 'ask-owner';
  readonly reason: CoworkDecisionReason;
}

export interface CoworkPolicyOptions {
  /** Absolute path of the turn's scratch directory. */
  readonly scratchRoot: string;
  readonly permission: CoworkPermission;
  /** Normalized names of the Intelligence Bridge tools; allowed without inspecting arguments. */
  readonly bridgeTools?: readonly string[] | undefined;
}

const WRITE_TOOLS: ReadonlySet<string> = new Set(['write', 'edit']);
const WIN_RESERVED_NAME = /^(con|prn|aux|nul|com[0-9]|lpt[0-9])(\..*)?$/i;

const reject = (reason: CoworkDecisionReason): CoworkDecision => ({ decision: 'reject', reason });

/**
 * Cowork's permission policy (pure; paths are checked lexically, never touching the filesystem).
 * Only `write`/`edit` of a file strictly inside the turn scratch, without sandbox escalation, can
 * be allowed; everything else is rejected. The reason is a closed enum and never carries a path.
 */
export function decideCoworkPermission(
  input: PermissionDecisionInput,
  options: CoworkPolicyOptions,
): CoworkDecision {
  if (options.bridgeTools?.includes(input.tool) === true) {
    return { decision: 'allow', reason: 'bridge-tool' };
  }
  if (!WRITE_TOOLS.has(input.tool)) return reject('unsupported-tool');

  const args = asRecord(input.rawInput);
  const target = args?.file_path;
  if (args === undefined || typeof target !== 'string') return reject('invalid-path');
  const escalation = args.sandbox_permissions;
  const verdict = containment(options.scratchRoot, target);
  if (verdict !== 'inside') return reject(verdict);
  if (escalation !== undefined && escalation !== 'workspace-write') {
    return reject('escalation-denied');
  }

  switch (options.permission) {
    case 'drafts-only':
      return { decision: 'allow', reason: 'draft-in-scratch' };
    case 'ask-before-write':
      return { decision: 'ask-owner', reason: 'owner-approval-required' };
    default:
      return reject('read-only');
  }
}

/** `drafts-only` lets DSH write inside scratch itself; every other mode makes every write ask. */
export function coworkPermissionMode(
  permission: CoworkPermission,
): 'workspace-write' | 'read-only' {
  return permission === 'drafts-only' ? 'workspace-write' : 'read-only';
}

function containment(
  scratchRoot: string,
  target: string,
): 'inside' | 'invalid-path' | 'outside-scratch' {
  const flavor = flavorOf(scratchRoot);
  if (flavor === undefined || target === '' || target.includes('\0')) return 'invalid-path';
  const windows = flavor === path.win32;
  if (windows && !safeWindowsPath(target)) return 'invalid-path';

  const root = flavor.resolve(scratchRoot);
  const resolved = flavor.resolve(root, target);
  const relative = flavor.relative(root, resolved);
  if (relative === '') return 'outside-scratch';
  if (relative === '..' || relative.startsWith(`..${flavor.sep}`) || flavor.isAbsolute(relative)) {
    return 'outside-scratch';
  }
  return 'inside';
}

/** The path flavor the scratch root is written in, so decisions do not depend on the host OS. */
function flavorOf(root: string): path.PlatformPath | undefined {
  if (/^[A-Za-z]:[\\/]/.test(root)) return path.win32;
  if (root.startsWith('\\\\')) return undefined;
  return root.startsWith('/') ? path.posix : undefined;
}

/** Refuses UNC/device/namespace paths, alternate streams, reserved device names and trailing dots/spaces. */
function safeWindowsPath(target: string): boolean {
  if (target.startsWith('\\\\') || target.startsWith('//')) return false;
  const afterDrive = /^[A-Za-z]:/.test(target) ? target.slice(2) : target;
  if (afterDrive.includes(':')) return false;
  for (const segment of target.split(/[\\/]/)) {
    if (segment === '' || segment === '.' || segment === '..') continue;
    if (/[. ]$/.test(segment) || WIN_RESERVED_NAME.test(segment)) return false;
  }
  return true;
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}
