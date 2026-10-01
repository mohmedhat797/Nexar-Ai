import type { WorkflowInput } from './definition.js';

/**
 * A tiny Nexar-owned template renderer: `{{variable}}` and `{{#if variable}}…{{/if}}`, nothing else
 * (no else, loops, filters, includes or evaluation). Variables are checked when a template is
 * parsed, so a typo is a load-time error, not a hole in a prompt. Rendering is a single pass over
 * the parsed template: substituted values are never scanned again, so an input cannot smuggle in a
 * tag of its own.
 */

export type TemplateContext = 'system' | 'prompt' | 'filename';

type Node =
  | { readonly kind: 'text'; readonly text: string }
  | { readonly kind: 'var'; readonly path: string }
  | { readonly kind: 'if'; readonly path: string; readonly body: readonly Node[] };

export interface Template {
  readonly context: TemplateContext;
  readonly nodes: readonly Node[];
}

/** A template that does not parse or validate; callers turn it into `CONFIGURATION_ERROR`. */
export class TemplateError extends Error {
  override readonly name = 'TemplateError';
}

const TAG = /\{\{([^{}]*)\}\}/g;
const PATH = /^[A-Za-z][A-Za-z0-9]*(\.[A-Za-z][A-Za-z0-9]*)*$/;

const COMMON = ['date', 'workflow.id', 'workflow.displayName', 'project.id', 'project.displayName'];

/** Why `path` may not be used in `context`, or undefined if it may. */
function variableProblem(
  path: string,
  context: TemplateContext,
  inputs: readonly WorkflowInput[],
  inIf: boolean,
): string | undefined {
  const byName = (name: string): WorkflowInput | undefined => inputs.find((i) => i.name === name);
  if (COMMON.includes(path)) return undefined;
  if (path === 'project.instructions' || path === 'outputs.markers') {
    if (context === 'filename') return `"${path}" cannot be used in a filename`;
    return undefined;
  }
  const [head, name, ...rest] = path.split('.');
  if ((head !== 'inputs' && head !== 'documents') || name === undefined || rest.length > 0) {
    return `unknown variable "${path}"`;
  }
  const input = byName(name);
  if (input === undefined) return `"${path}" refers to an undeclared input`;
  if (context === 'system') {
    return `"${path}": the system template is trusted and cannot contain input values`;
  }
  if (head === 'documents') {
    if (input.type !== 'document-set') return `"${path}": "${name}" is not a document-set input`;
    return context === 'filename' ? `"${path}" cannot be used in a filename` : undefined;
  }
  if (input.type === 'document-set') {
    return inIf ? undefined : `"${path}": use documents.${name} for a document-set input`;
  }
  if (context === 'filename' && input.type !== 'string') {
    return `"${path}": only string inputs can be used in a filename`;
  }
  return undefined;
}

/** Parses `source`; throws `TemplateError` (naming `origin`) for any syntax or variable problem. */
export function parseTemplate(
  source: string,
  context: TemplateContext,
  inputs: readonly WorkflowInput[],
  origin: string,
): Template {
  const fail = (message: string): never => {
    throw new TemplateError(`${origin}: ${message}`);
  };
  const root: Node[] = [];
  let open: { path: string; body: Node[] } | undefined;
  const target = (): Node[] => open?.body ?? root;
  let cursor = 0;

  const pushText = (text: string): void => {
    if (text === '') return;
    if (/\{\{|\}\}/.test(text)) fail('malformed tag (unbalanced "{{" or "}}")');
    target().push({ kind: 'text', text });
  };

  for (const match of source.matchAll(TAG)) {
    pushText(source.slice(cursor, match.index));
    cursor = match.index + match[0].length;
    const body = (match[1] ?? '').trim();
    if (body.startsWith('#if')) {
      const path = body.slice(3).trim();
      if (context === 'filename') fail('sections are not allowed in a filename template');
      if (open !== undefined) fail('nested {{#if}} sections are not supported');
      if (!PATH.test(path)) fail(`invalid {{#if}} condition "${path}"`);
      const isInput = path.startsWith('inputs.') || path === 'project.instructions';
      const problem = isInput ? variableProblem(path, context, inputs, true) : 'not a condition';
      if (problem !== undefined) {
        fail(`{{#if}} accepts only inputs.<name> and project.instructions (${problem})`);
      }
      open = { path, body: [] };
    } else if (body === '/if') {
      if (open === undefined) fail('{{/if}} without a matching {{#if}}');
      else {
        root.push({ kind: 'if', path: open.path, body: open.body });
        open = undefined;
      }
    } else if (body.startsWith('#') || body.startsWith('/') || body.startsWith('^')) {
      fail(`unsupported tag "{{${body}}}" (only {{#if}} sections exist)`);
    } else {
      if (!PATH.test(body)) fail(`invalid variable "${body}"`);
      const problem = variableProblem(body, context, inputs, false);
      if (problem !== undefined) fail(problem);
      target().push({ kind: 'var', path: body });
    }
  }
  pushText(source.slice(cursor));
  if (open !== undefined) fail('{{#if}} is never closed');
  return { context, nodes: root };
}

/** Everything a template may draw on; built by the runner, never by a template. */
export interface RenderValues {
  readonly project: {
    readonly id: string;
    readonly displayName: string;
    readonly instructions: string;
  };
  readonly workflow: { readonly id: string; readonly displayName: string };
  /** ISO date (`YYYY-MM-DD`) from the injected clock. */
  readonly date: string;
  readonly markers: string;
  /** Validated input values; absent = not provided. A document-set input holds the set's name. */
  readonly inputs: Readonly<Record<string, string | readonly string[] | undefined>>;
  /** Display lines (label and relative path) per document-set input, never contents. */
  readonly documents: Readonly<Record<string, readonly string[]>>;
}

/** The boundary every untrusted value is rendered inside. */
export const UNTRUSTED_TAG = 'untrusted-input';

/** Breaks any attempt to close the untrusted wrapper early (case- and whitespace-tolerant). */
export function neutralize(value: string): string {
  return value.replace(/<(\s*)\/(\s*)untrusted-input/gi, '<$1/$2untrusted_input');
}

function wrapUntrusted(name: string, body: string): string {
  return `<${UNTRUSTED_TAG} name="${name}">\n${body}\n</${UNTRUSTED_TAG}>`;
}

function isProvided(value: string | readonly string[] | undefined): boolean {
  if (value === undefined) return false;
  return typeof value === 'string' ? value.trim() !== '' : value.length > 0;
}

function renderVariable(path: string, values: RenderValues, context: TemplateContext): string {
  switch (path) {
    case 'date':
      return values.date;
    case 'workflow.id':
      return values.workflow.id;
    case 'workflow.displayName':
      return values.workflow.displayName;
    case 'project.id':
      return values.project.id;
    case 'project.displayName':
      return values.project.displayName;
    case 'project.instructions':
      return values.project.instructions;
    case 'outputs.markers':
      return values.markers;
  }
  const [head, name = ''] = path.split('.');
  if (head === 'documents') {
    const lines = values.documents[name] ?? [];
    return wrapUntrusted(name, lines.length === 0 ? '(none)' : lines.map(neutralize).join('\n'));
  }
  const value = values.inputs[name];
  if (context === 'filename') return typeof value === 'string' ? value : '';
  if (!isProvided(value)) return '(not provided)';
  if (typeof value === 'string') return wrapUntrusted(name, neutralize(value));
  const items = (value as readonly string[]).map(
    (item) => `- ${neutralize(item).replace(/\s*[\r\n]+\s*/g, ' ')}`,
  );
  return wrapUntrusted(name, items.join('\n'));
}

function isTruthy(path: string, values: RenderValues): boolean {
  if (path === 'project.instructions') return values.project.instructions.trim() !== '';
  return isProvided(values.inputs[path.slice('inputs.'.length)]);
}

export function renderTemplate(template: Template, values: RenderValues): string {
  let out = '';
  const emit = (nodes: readonly Node[]): void => {
    for (const node of nodes) {
      if (node.kind === 'text') out += node.text;
      else if (node.kind === 'var') out += renderVariable(node.path, values, template.context);
      else if (isTruthy(node.path, values)) emit(node.body);
    }
  };
  emit(template.nodes);
  return out;
}
