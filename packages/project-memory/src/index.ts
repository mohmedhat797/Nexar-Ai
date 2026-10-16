/**
 * `@nexar/project-memory`: Nexar-owned durable project knowledge (ADR-030 decision 7).
 *
 * Owner-confirmed constraints, decisions, requirements, review obligations and pending work, kept in
 * one hardened JSON file per project. Only owner actions write it; the Operating Layer reads it into
 * `context@2` so no truncation or compaction can drop it silently.
 */
export {
  MAX_MEMORY_ENTRIES,
  MAX_MEMORY_FILE_BYTES,
  MAX_MEMORY_TEXT_CHARS,
  MEMORY_ID_PATTERN,
  PROJECT_MEMORY_KINDS,
} from './types.js';
export type {
  ProjectMemoryEntry,
  ProjectMemoryInput,
  ProjectMemoryKind,
  ProjectMemoryRecord,
} from './types.js';
export { isValidMemoryText } from './record.js';
export { MAX_REQUIRED_CONTEXT_CHARS, renderProjectMemory } from './render.js';
export { FileProjectMemoryStore } from './store.js';
export type { FileProjectMemoryStoreOptions } from './store.js';
