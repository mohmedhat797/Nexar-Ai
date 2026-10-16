/** Kinds in rendering order (ADR-030 decision 7). */
export const PROJECT_MEMORY_KINDS = [
  'constraint',
  'decision',
  'requirement',
  'review-obligation',
  'pending-work',
] as const;

export type ProjectMemoryKind = (typeof PROJECT_MEMORY_KINDS)[number];

export const MAX_MEMORY_ENTRIES = 256;
export const MAX_MEMORY_TEXT_CHARS = 1_000;
/** One record file never exceeds this; reads and writes are bounded by it. */
export const MAX_MEMORY_FILE_BYTES = 1024 * 1024;

export const MEMORY_ID_PATTERN = /^mem_[0-9a-f]{32}$/;
/** Same shape as `PROJECT_ID_PATTERN` in `@nexar/sessions` and `projectId()` in `@nexar/contracts`. */
export const MEMORY_PROJECT_ID_PATTERN = /^[a-z0-9][a-z0-9._:-]{0,127}$/;

export interface ProjectMemoryEntry {
  readonly id: string;
  readonly kind: ProjectMemoryKind;
  readonly text: string;
  readonly createdAt: string;
  /** Only owner actions create entries; no model or tool path writes project memory. */
  readonly source: 'owner';
  /** Provenance only. */
  readonly sessionId?: string;
  /** Provenance only. */
  readonly turnId?: string;
}

export interface ProjectMemoryRecord {
  readonly schemaVersion: 1;
  readonly projectId: string;
  readonly revision: number;
  readonly entries: readonly ProjectMemoryEntry[];
}

export interface ProjectMemoryInput {
  readonly kind: ProjectMemoryKind;
  readonly text: string;
  readonly sessionId?: string;
  readonly turnId?: string;
}
