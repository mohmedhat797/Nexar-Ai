import type { Capability, ProjectId, ResourceId, ReviewDimensions } from '@nexar/contracts';

/** Task requirement defaults a project contributes; see `mergeRequirements` for the rules. */
export interface ProjectDefaults {
  readonly capabilities?: readonly Capability[];
  readonly privacy?: 'standard' | 'local-only';
  readonly preferredResourceIds?: readonly ResourceId[];
  readonly excludedResourceIds?: readonly ResourceId[];
  readonly minContextTokens?: number;
  readonly maxCostUsd?: number;
}

/** Per-project workflow customization; paths are absolute and validated against the roots on use. */
export interface ProjectWorkflowSettings {
  /** Extra workflow directories inside the project roots; a same-id workflow overrides a built-in. */
  readonly directories?: readonly string[];
  /** Workflow id → Markdown file (inside the project) of owner-written, trusted instructions. */
  readonly instructions?: Readonly<Record<string, string>>;
}

/** Lane roles of an engineering plan (ADR-019). `debugging` is the built-in rework lane. */
export type EngineeringLaneRole =
  'architecture' | 'feature' | 'tests' | 'debugging' | 'review' | 'report';

/** A setup step or gate: an argv array (never a shell string) run in the sandbox. */
export interface EngineeringCommand {
  readonly name: string;
  readonly command: readonly string[];
  readonly timeoutMs: number;
}

/** Patch validation policy for a project (see `@nexar/worktrees`). */
export interface EngineeringPatchPolicy {
  readonly denyGlobs: readonly string[];
  readonly allowSymlinks: boolean;
  readonly allowModeChanges: boolean;
  readonly maxBytes: number;
}

/** Engineering settings of a project, with every default applied (ADR-019). */
export interface ProjectEngineeringSettings {
  /** Absolute; resolved against the first root. Containment is enforced on use. */
  readonly repository: string;
  readonly baseBranch: string;
  readonly setup: readonly EngineeringCommand[];
  /** Egress for setup only; empty = no network. */
  readonly setupAllowHosts: readonly string[];
  readonly gates: readonly EngineeringCommand[];
  readonly laneTimeoutMs: number;
  /** 0..3 */
  readonly maxReworkRounds: number;
  readonly reviewDiversity: 'preferred' | 'required';
  readonly reviewDimensions?: ReviewDimensions | undefined;
  readonly ownerApproval: 'always' | 'never';
  readonly lanePreferences: Readonly<Partial<Record<EngineeringLaneRole, readonly ResourceId[]>>>;
  readonly patchPolicy: EngineeringPatchPolicy;
}

/** What configuration supplies; all paths are already absolute. */
export interface ProjectDefinition {
  readonly id: ProjectId;
  readonly displayName: string;
  /** At least one. Everything a project may touch lives under these. */
  readonly roots: readonly string[];
  /** Directories tasks may run in; default = `roots`. Each must be inside a root. */
  readonly workingDirectories?: readonly string[];
  /** Name → files/directories (absolute), resolved to attachments on demand. */
  /**
   * Where artifacts are stored, relative to the first root; must stay inside a root.
   * Default: `.nexar/artifacts`.
   */
  readonly artifactsDirectory?: string;
  readonly documentSets?: Readonly<Record<string, readonly string[]>>;
  readonly defaults?: ProjectDefaults;
  readonly workflows?: ProjectWorkflowSettings;
  readonly engineering?: ProjectEngineeringSettings;
  readonly metadata?: Readonly<Record<string, string | number | boolean>>;
}

/** A definition with canonical (realpath) directories, produced by `ProjectRegistry.create`. */
export interface Project extends ProjectDefinition {
  readonly realRoots: readonly string[];
  readonly realWorkingDirectories: readonly string[];
}
