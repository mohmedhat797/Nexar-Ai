import { UNTRUSTED_TAG, neutralize } from '@nexar/workflows';

/** Variables a lane brief may use. Every one is untrusted data and is wrapped when rendered. */
export const LANE_VARIABLES = ['goal', 'plan', 'findings', 'patch', 'gates', 'round'] as const;
export type LaneVariable = (typeof LANE_VARIABLES)[number];

/** A brief template parsed once at load time, so a typo is a load error and not a hole in a prompt. */
export interface LaneTemplate {
  readonly nodes: readonly (
    | { readonly kind: 'text'; readonly text: string }
    | { readonly kind: 'var'; readonly name: LaneVariable }
  )[];
}

/** A template that does not parse; callers turn it into `CONFIGURATION_ERROR`. */
export class LaneTemplateError extends Error {
  override readonly name = 'LaneTemplateError';
}

/** The patch is truncated to this many bytes before it reaches the review lane. */
export const MAX_PATCH_PROMPT_BYTES = 200 * 1024;

const TAG = /\{\{([^{}]*)\}\}/g;

/** System templates are trusted: they may not contain any variable. */
export function assertSystemTemplate(source: string, origin: string): void {
  if (/\{\{|\}\}/.test(source)) {
    throw new LaneTemplateError(
      `${origin}: a system template is trusted and cannot contain variables`,
    );
  }
}

export function parseLaneTemplate(source: string, origin: string): LaneTemplate {
  const nodes: LaneTemplate['nodes'][number][] = [];
  let cursor = 0;
  const text = (value: string): void => {
    if (value === '') return;
    if (/\{\{|\}\}/.test(value)) throw new LaneTemplateError(`${origin}: malformed tag`);
    nodes.push({ kind: 'text', text: value });
  };
  for (const match of source.matchAll(TAG)) {
    text(source.slice(cursor, match.index));
    cursor = match.index + match[0].length;
    const name = (match[1] ?? '').trim();
    if (!(LANE_VARIABLES as readonly string[]).includes(name)) {
      throw new LaneTemplateError(`${origin}: unknown variable "${name}"`);
    }
    nodes.push({ kind: 'var', name: name as LaneVariable });
  }
  text(source.slice(cursor));
  return { nodes };
}

/** Values for one lane; absent or blank values render as "(not provided)". */
export interface LaneValues {
  readonly goal: string;
  readonly plan?: string;
  readonly findings?: string;
  readonly patch?: string;
  readonly gates?: string;
  readonly round: number;
}

/** Truncates to `maxBytes` of UTF-8 and says so, so a reviewer knows the patch is incomplete. */
export function boundPatch(patch: string, maxBytes: number = MAX_PATCH_PROMPT_BYTES): string {
  const bytes = Buffer.from(patch, 'utf8');
  if (bytes.length <= maxBytes) return patch;
  const kept = bytes.subarray(0, maxBytes).toString('utf8').replace(/�+$/, '');
  return `${kept}\n[patch truncated: ${String(maxBytes)} of ${String(bytes.length)} bytes shown]`;
}

function wrap(name: string, body: string): string {
  return `<${UNTRUSTED_TAG} name="${name}">\n${body}\n</${UNTRUSTED_TAG}>`;
}

export function renderLaneTemplate(template: LaneTemplate, values: LaneValues): string {
  let out = '';
  for (const node of template.nodes) {
    if (node.kind === 'text') {
      out += node.text;
      continue;
    }
    const raw = node.name === 'round' ? String(values.round) : values[node.name];
    const value = node.name === 'patch' && raw !== undefined ? boundPatch(raw) : raw;
    out += wrap(
      node.name,
      value === undefined || value.trim() === '' ? '(not provided)' : neutralize(value),
    );
  }
  return out;
}
