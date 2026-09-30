import type { WorkflowOutput } from './definition.js';

const MARKER = /^<!--\s*nexar:output\s+([a-z][a-z0-9-]*)\s*-->\s*$/;

/** The exact marker line for an output id. */
export function markerLine(id: string): string {
  return `<!-- nexar:output ${id} -->`;
}

/** Instruction text for `{{outputs.markers}}`; empty when there is a single output. */
export function markerInstructions(outputs: readonly WorkflowOutput[]): string {
  if (outputs.length < 2) return '';
  return [
    `Produce ${String(outputs.length)} separate documents, in this order. Start each one with its marker ` +
      'line, alone on its own line and exactly as written:',
    '',
    ...outputs.map((o) => markerLine(o.id)),
    '',
    'Put nothing before the first marker line.',
  ].join('\n');
}

export interface SplitOutputs {
  /** Output id → content (trimmed, with a trailing newline). Only outputs with content appear. */
  readonly sections: ReadonlyMap<string, string>;
  /** False when the markers were not all found; everything then belongs to the first output. */
  readonly split: boolean;
}

const finish = (text: string): string => `${text.trim()}\n`;

/**
 * Splits model text on `<!-- nexar:output <id> -->` lines. Text before the first marker goes to the
 * first output. If any declared output has no (non-empty) section the text is NOT split: all of it,
 * markers included, goes to the first output, so nothing is ever dropped.
 */
export function splitOutputs(text: string, outputs: readonly WorkflowOutput[]): SplitOutputs {
  const first = outputs[0];
  if (first === undefined) return { sections: new Map(), split: true };
  if (outputs.length === 1) return { sections: new Map([[first.id, finish(text)]]), split: true };

  const declared = new Set(outputs.map((o) => o.id));
  const chunks = new Map<string, string[]>();
  let current = first.id;
  for (const line of text.split(/\r?\n/)) {
    const id = MARKER.exec(line)?.[1];
    if (id !== undefined && declared.has(id)) {
      current = id;
      if (!chunks.has(id)) chunks.set(id, []);
      continue;
    }
    const lines = chunks.get(current) ?? [];
    lines.push(line);
    chunks.set(current, lines);
  }

  const sections = new Map<string, string>();
  for (const output of outputs) {
    const body = (chunks.get(output.id) ?? []).join('\n');
    if (body.trim() !== '') sections.set(output.id, finish(body));
  }
  const complete = outputs.every((o) => sections.has(o.id));
  return complete
    ? { sections, split: true }
    : { sections: new Map([[first.id, finish(text)]]), split: false };
}
