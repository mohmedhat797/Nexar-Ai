/*
 * AI behavior settings (NXR-053, ADR-021 amendment). Settings compile into existing policy inputs
 * and only ever narrow permissions. Unsupported options are listed with a reason, never accepted.
 */

export const COWORK_PERMISSIONS = ['read-only', 'drafts-only', 'ask-before-write'] as const;
export type CoworkPermissionId = (typeof COWORK_PERMISSIONS)[number];
export const CODE_PERMISSIONS = ['plan', 'auto-edit'] as const;
export type CodePermissionId = (typeof CODE_PERMISSIONS)[number];

export const DEFAULT_COWORK_PERMISSION: CoworkPermissionId = 'drafts-only';
export const DEFAULT_CODE_PERMISSION: CodePermissionId = 'auto-edit';

/** An owner-preferred resource id (never a key or a path); same shape as a registry resource id. */
export const BEHAVIOR_RESOURCE_PATTERN = /^[a-z0-9][a-z0-9._:-]{0,127}$/;

export interface BehaviorSettings {
  readonly cowork: {
    readonly permission: CoworkPermissionId;
    readonly preferredResourceId?: string | undefined;
  };
  readonly code: {
    readonly permission: CodePermissionId;
    readonly preferredResourceId?: string | undefined;
  };
}

/** A patch: any subset; `null` clears a preferred resource (Nexar decides again). */
export interface BehaviorPatch {
  readonly cowork?:
    | {
        readonly permission?: CoworkPermissionId | undefined;
        readonly preferredResourceId?: string | null | undefined;
      }
    | undefined;
  readonly code?:
    | {
        readonly permission?: CodePermissionId | undefined;
        readonly preferredResourceId?: string | null | undefined;
      }
    | undefined;
}

export interface UnsupportedOption {
  readonly mode: 'cowork' | 'code';
  readonly id: string;
  readonly label: string;
  readonly reason: string;
}

export interface BehaviorView {
  readonly settings: BehaviorSettings;
  /** Fixed text: these rules cannot be changed through the bridge. */
  readonly lockedRules: readonly string[];
  readonly unsupported: readonly UnsupportedOption[];
  readonly reasoningEffort: string;
}

export const LOCKED_RULES: readonly string[] = [
  'Every write runs inside the sandbox.',
  'A different resource reviews every change before it is accepted.',
  'Agents never commit or push; Nexar commits only after your approval.',
  'No outward actions (email, calendar, uploads, pushes) are taken.',
  'Agent network is off for gates; agent egress stays your per-resource allowlist.',
];

export const UNSUPPORTED_OPTIONS: readonly UnsupportedOption[] = [
  {
    mode: 'code',
    id: 'ask-before-edits',
    label: 'Ask before edits',
    reason: 'Not supported yet: it needs per-edit approvals from the engineering plane.',
  },
  {
    mode: 'code',
    id: 'full-auto',
    label: 'Full auto in sandbox',
    reason: 'Not supported yet: it needs a network allowlist profile for the sandbox.',
  },
];

export const REASONING_EFFORT_NOTE =
  'Reasoning effort per mode: not supported yet (effort is a per-resource configuration option today).';
