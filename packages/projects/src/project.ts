import type { Capability, ProjectId, ResourceId } from '@nexar/contracts';

/** Task requirement defaults a project contributes; see `mergeRequirements` for the rules. */
export interface ProjectDefaults {
  readonly capabilities?: readonly Capability[];
  readonly privacy?: 'standard' | 'local-only';
  readonly preferredResourceIds?: readonly ResourceId[];
  readonly excludedResourceIds?: readonly ResourceId[];
  readonly minContextTokens?: number;
  readonly maxCostUsd?: number;
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
  readonly metadata?: Readonly<Record<string, string | number | boolean>>;
}

/** A definition with canonical (realpath) directories, produced by `ProjectRegistry.create`. */
export interface Project extends ProjectDefinition {
  readonly realRoots: readonly string[];
  readonly realWorkingDirectories: readonly string[];
}
