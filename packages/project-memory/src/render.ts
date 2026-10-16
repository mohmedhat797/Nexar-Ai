import { NexarError } from '@nexar/contracts';
import { PROJECT_MEMORY_KINDS } from './types.js';
import type { ProjectMemoryEntry } from './types.js';

/** The required block is never truncated: over this size a turn fails and the store refuses the add. */
export const MAX_REQUIRED_CONTEXT_CHARS = 16_000;
const REQUIRED_HEADER = 'Project memory (owner-confirmed; binding for this turn):';

/** Same rule as `neutralize` in `@nexar/workflows`: an embedded value cannot close the wrapper. */
function neutralize(value: string): string {
  return value.replace(/<(\s*)\/(\s*)untrusted-input/gi, '<$1/$2untrusted_input');
}

/** One line per entry: newlines become `\n` escapes, so text cannot start another entry or header. */
function singleLine(text: string): string {
  return neutralize(text)
    .replace(/\r\n|\r|\n/g, '\\n')
    .replace(/[\u2028\u2029]/g, '\\n');
}

/** Renders the required context block in kind, then creation, then id order. */
export function renderProjectMemory(entries: readonly ProjectMemoryEntry[]): {
  readonly block: string;
  readonly ids: readonly string[];
} {
  if (entries.length === 0) return { block: '', ids: [] };
  const rank = (e: ProjectMemoryEntry): number => PROJECT_MEMORY_KINDS.indexOf(e.kind);
  const ordered = [...entries].sort(
    (a, b) =>
      rank(a) - rank(b) ||
      (a.createdAt < b.createdAt ? -1 : a.createdAt > b.createdAt ? 1 : 0) ||
      (a.id < b.id ? -1 : a.id > b.id ? 1 : 0),
  );
  const block = [
    REQUIRED_HEADER,
    ...ordered.map((e) => `- [${e.kind}] ${singleLine(e.text)}`),
  ].join('\n');
  if (block.length > MAX_REQUIRED_CONTEXT_CHARS) {
    throw new NexarError('VALIDATION_ERROR', 'Project memory is too large to include in a turn', {
      details: { reason: 'required-context-overflow' },
    });
  }
  return { block, ids: ordered.map((e) => e.id) };
}
