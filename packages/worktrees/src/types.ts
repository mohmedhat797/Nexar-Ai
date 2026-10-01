/** A task's private clone layout (see `createTaskWorktree`). */
export interface TaskWorktree {
  readonly projectId: string;
  readonly taskId: string;
  /** Canonical `<baseDir>/<projectId>/<taskId>`. */
  readonly taskDir: string;
  /** The agent's clone; the only directory an agent sandbox may mount. */
  readonly workPath: string;
  /** Nexar's pristine bare clone. Never mounted read-write, never given to an agent. */
  readonly baseGitPath: string;
  readonly baseCommit: string;
  readonly baseBranch: string;
  /** Canonical worktrees root the task was created under (used to bound removal). */
  readonly baseDir: string;
}

/** One file touched by a patch. */
export interface PatchEntry {
  readonly path: string;
  readonly status: 'added' | 'modified' | 'deleted';
  readonly oldMode?: string;
  readonly newMode?: string;
  readonly binary: boolean;
}

/** Output of `parsePatch`: structure only, not yet policy-checked. */
export interface ParsedPatch {
  readonly entries: readonly PatchEntry[];
  readonly bytes: number;
  readonly sha256: string;
}

/** A broken rule. `index` is the entry index, or -1 for whole-patch rules. Never carries a path. */
export interface Violation {
  readonly rule: string;
  readonly index: number;
}

export interface PatchPolicy {
  readonly allowSymlinks?: boolean;
  readonly allowModeChanges?: boolean;
  /** Default 5 MiB. */
  readonly maxBytes?: number;
  /** Default 1000. */
  readonly maxFiles?: number;
  /** Simple globs (`*`, `**`, `?`) matched against the whole repository-relative path. */
  readonly denyGlobs?: readonly string[];
}

export type PatchValidation =
  | {
      readonly ok: true;
      readonly entries: readonly PatchEntry[];
      readonly bytes: number;
      readonly sha256: string;
    }
  | { readonly ok: false; readonly violations: readonly Violation[] };

export interface HarvestResult {
  /** Canonical path of the patch file under the task's `out/` directory (0600). */
  readonly patchPath: string;
  /** SHA-256 of the exact bytes in `patchPath`. */
  readonly sha256: string;
  readonly bytes: number;
  readonly entries: readonly PatchEntry[];
  readonly validation: PatchValidation;
}
