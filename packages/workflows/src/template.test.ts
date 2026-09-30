import { describe, expect, it } from 'vitest';
import type { WorkflowInput } from './definition.js';
import { markerInstructions, splitOutputs } from './outputs.js';
import { neutralize, parseTemplate, renderTemplate, type RenderValues } from './template.js';

const INPUTS: WorkflowInput[] = [
  { name: 'title', type: 'string' },
  { name: 'body', type: 'text' },
  { name: 'items', type: 'list' },
  { name: 'refs', type: 'document-set' },
];

const VALUES: RenderValues = {
  project: { id: 'p1', displayName: 'Project One', instructions: '' },
  workflow: { id: 'w', displayName: 'Flow' },
  date: '2026-01-02',
  markers: '',
  inputs: { title: 'T', body: 'B', items: ['a', 'b'], refs: 'set' },
  documents: { refs: ['- x.md'] },
};

describe('template parsing', () => {
  const bad =
    (source: string, context: 'prompt' | 'system' | 'filename' = 'prompt'): (() => unknown) =>
    () =>
      parseTemplate(source, context, INPUTS, 'test');

  it.each([
    ['unknown variable', '{{nope}}'],
    ['undeclared input', '{{inputs.missing}}'],
    ['document-set through inputs', '{{inputs.refs}}'],
    ['documents for a non-document input', '{{documents.title}}'],
    ['nested path', '{{inputs.title.extra}}'],
    ['nested sections', '{{#if inputs.title}}{{#if inputs.body}}x{{/if}}{{/if}}'],
    ['stray close', '{{/if}}'],
    ['unclosed section', '{{#if inputs.title}}x'],
    ['section on a non-input', '{{#if date}}x{{/if}}'],
    ['else', '{{#if inputs.title}}a{{else}}b{{/if}}'],
    ['a dangling brace', 'text {{ inputs.title'],
    ['an unbalanced close', 'text }} more'],
    ['an empty tag', '{{}}'],
  ])('rejects %s', (_name, source) => {
    expect(bad(source)).toThrow(/test/);
  });

  it('keeps inputs out of system templates', () => {
    expect(bad('{{inputs.title}}', 'system')).toThrow(/trusted/);
    expect(bad('{{documents.refs}}', 'system')).toThrow(/trusted/);
    expect(() =>
      parseTemplate('{{project.displayName}} {{date}}', 'system', INPUTS, 't'),
    ).not.toThrow();
  });

  it('allows only a few variables in filenames', () => {
    expect(() =>
      parseTemplate(
        '{{project.id}}-{{date}}-{{workflow.id}}-{{inputs.title}}',
        'filename',
        INPUTS,
        't',
      ),
    ).not.toThrow();
    expect(bad('{{inputs.body}}', 'filename')).toThrow();
    expect(bad('{{inputs.items}}', 'filename')).toThrow();
    expect(bad('{{outputs.markers}}', 'filename')).toThrow();
    expect(bad('{{#if inputs.title}}x{{/if}}', 'filename')).toThrow();
  });
});

describe('template rendering', () => {
  const render = (source: string, values: Partial<RenderValues> = {}): string =>
    renderTemplate(parseTemplate(source, 'prompt', INPUTS, 't'), { ...VALUES, ...values });

  it('substitutes trusted variables plainly', () => {
    expect(render('{{project.id}}/{{project.displayName}}/{{workflow.displayName}}/{{date}}')).toBe(
      'p1/Project One/Flow/2026-01-02',
    );
  });

  it('wraps inputs, and lists become bullets', () => {
    expect(render('{{inputs.title}}')).toBe(
      '<untrusted-input name="title">\nT\n</untrusted-input>',
    );
    expect(render('{{inputs.items}}')).toBe(
      '<untrusted-input name="items">\n- a\n- b\n</untrusted-input>',
    );
    expect(render('{{documents.refs}}')).toBe(
      '<untrusted-input name="refs">\n- x.md\n</untrusted-input>',
    );
  });

  it('flattens multi-line list items so they stay one bullet each', () => {
    expect(render('{{inputs.items}}', { inputs: { items: ['a\n- injected'] } })).toContain(
      '- a - injected',
    );
  });

  it('says so when an optional input is absent', () => {
    expect(render('{{inputs.body}}', { inputs: {} })).toBe('(not provided)');
    expect(render('{{documents.refs}}', { documents: {} })).toContain('(none)');
  });

  it('renders sections only when the input is provided and non-empty', () => {
    const source = '[{{#if inputs.body}}yes{{/if}}]';
    expect(render(source)).toBe('[yes]');
    expect(render(source, { inputs: {} })).toBe('[]');
    expect(render(source, { inputs: { body: '  ' } })).toBe('[]');
    expect(render(source, { inputs: { body: [] } })).toBe('[]');
    expect(render('{{#if project.instructions}}I{{/if}}')).toBe('');
    expect(
      render('{{#if project.instructions}}I{{/if}}', {
        project: { ...VALUES.project, instructions: 'x' },
      }),
    ).toBe('I');
  });

  it('never re-scans substituted values', () => {
    expect(render('{{inputs.body}}', { inputs: { body: '{{project.id}}' } })).toContain(
      '{{project.id}}',
    );
  });

  it('neutralizes closing tags case- and whitespace-insensitively', () => {
    expect(neutralize('</untrusted-input> </ Untrusted-Input >')).toBe(
      '</untrusted_input> </ untrusted_input >',
    );
    expect(neutralize('<untrusted-input name="x">')).toBe('<untrusted-input name="x">');
  });

  it('renders filenames raw (the store sanitizes)', () => {
    const t = parseTemplate('{{project.id}}-{{inputs.title}}-{{date}}.md', 'filename', INPUTS, 't');
    expect(renderTemplate(t, VALUES)).toBe('p1-T-2026-01-02.md');
  });
});

describe('output splitting', () => {
  const outputs = [
    { id: 'one', filename: 'a.md', mediaType: 'text/markdown' as const },
    { id: 'two', filename: 'b.md', mediaType: 'text/markdown' as const },
  ];

  it('returns the whole text for a single output', () => {
    const only = [outputs[0] ?? { id: 'x', filename: 'x', mediaType: 'text/markdown' as const }];
    expect(splitOutputs('abc\n\n', only)).toEqual({
      sections: new Map([['one', 'abc\n']]),
      split: true,
    });
  });

  it('splits on marker lines and sends a preamble to the first output', () => {
    const result = splitOutputs(
      'intro\n<!-- nexar:output one -->\nA\n<!--nexar:output two-->\nB\n',
      outputs,
    );
    expect(result.split).toBe(true);
    expect(result.sections.get('one')).toBe('intro\nA\n');
    expect(result.sections.get('two')).toBe('B\n');
  });

  it('ignores markers for undeclared ids and inline mentions', () => {
    const result = splitOutputs(
      '<!-- nexar:output one -->\nA <!-- nexar:output two --> inline\n<!-- nexar:output zzz -->\n<!-- nexar:output two -->\nB',
      outputs,
    );
    expect(result.sections.get('one')).toContain('inline');
    expect(result.sections.get('one')).toContain('zzz');
    expect(result.sections.get('two')).toBe('B\n');
  });

  it('falls back to one output when a marker is missing or its section is empty', () => {
    for (const text of [
      'plain',
      '<!-- nexar:output one -->\nA',
      '<!-- nexar:output one -->\nA\n<!-- nexar:output two -->\n',
    ]) {
      const result = splitOutputs(text, outputs);
      expect(result.split).toBe(false);
      expect([...result.sections.keys()]).toEqual(['one']);
      expect(result.sections.get('one')).toBe(`${text.trim()}\n`);
    }
  });

  it('writes marker instructions only for several outputs', () => {
    expect(markerInstructions(outputs.slice(0, 1))).toBe('');
    const text = markerInstructions(outputs);
    expect(text).toContain('<!-- nexar:output one -->\n<!-- nexar:output two -->');
  });
});
