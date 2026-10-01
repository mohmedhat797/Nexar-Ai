import { describe, expect, it } from 'vitest';
import { parseReviewVerdict } from './verdict.js';

const approve = {
  verdict: 'approve',
  summary: 'Looks good',
  findings: [{ severity: 'nit', file: 'a.txt', message: 'spacing' }],
};

describe('parseReviewVerdict', () => {
  it('parses plain JSON', () => {
    const v = parseReviewVerdict(JSON.stringify(approve));
    expect(v).toMatchObject({ verdict: 'approve', valid: true, summary: 'Looks good' });
    expect(v.findings).toEqual(approve.findings);
  });

  it('parses a fenced JSON block followed by prose', () => {
    const text = `Review done.\n\n\`\`\`json\n${JSON.stringify(approve, null, 2)}\n\`\`\`\n\nThanks!`;
    expect(parseReviewVerdict(text)).toMatchObject({ verdict: 'approve', valid: true });
  });

  it('parses an object with trailing prose containing braces', () => {
    const text = `${JSON.stringify(approve)} (see {the notes} above)`;
    expect(parseReviewVerdict(text)).toMatchObject({ verdict: 'approve', valid: true });
  });

  it('uses the last object when there are several', () => {
    const first = { verdict: 'approve', summary: 'first', findings: [] };
    const last = {
      verdict: 'request-changes',
      summary: 'second',
      findings: [{ severity: 'blocker', message: 'broken' }],
    };
    const v = parseReviewVerdict(
      `${JSON.stringify(first)}\nOn reflection:\n${JSON.stringify(last)}`,
    );
    expect(v).toMatchObject({ verdict: 'request-changes', summary: 'second', valid: true });
    expect(v.findings).toEqual(last.findings);
  });

  it('ignores braces inside strings', () => {
    const v = parseReviewVerdict(
      JSON.stringify({ verdict: 'approve', summary: 'a } b { c', findings: [] }),
    );
    expect(v).toMatchObject({ verdict: 'approve', valid: true, summary: 'a } b { c' });
  });

  it.each([
    ['no JSON at all', 'I think it is fine.'],
    ['an empty string', ''],
    ['an unknown verdict', JSON.stringify({ verdict: 'maybe', findings: [] })],
    ['a missing verdict', JSON.stringify({ summary: 'x', findings: [] })],
    [
      'a bad severity',
      JSON.stringify({ verdict: 'approve', findings: [{ severity: 'huge', message: 'x' }] }),
    ],
    [
      'a finding without a message',
      JSON.stringify({ verdict: 'approve', findings: [{ severity: 'nit' }] }),
    ],
    ['findings that are not a list', JSON.stringify({ verdict: 'approve', findings: 'none' })],
    ['an array without a verdict object', JSON.stringify([1, 2, 3])],
    ['a truncated object', '{"verdict":"approve","summary":'],
  ])('fails closed on %s', (_name, text) => {
    const v = parseReviewVerdict(text);
    expect(v.verdict).toBe('request-changes');
    expect(v.valid).toBe(false);
    expect(v.findings).toEqual([{ severity: 'major', message: 'review.unparseable' }]);
  });

  it('does not accept an approval that lists blocker or major findings', () => {
    const v = parseReviewVerdict(
      JSON.stringify({
        verdict: 'approve',
        summary: 'ok',
        findings: [{ severity: 'major', message: 'data loss' }],
      }),
    );
    expect(v).toMatchObject({ verdict: 'request-changes', valid: false });
    expect(v.findings.map((f) => f.message)).toContain('data loss');
  });

  it('bounds finding text', () => {
    const v = parseReviewVerdict(
      JSON.stringify({
        verdict: 'request-changes',
        findings: [{ severity: 'major', message: 'x'.repeat(10_000) }],
      }),
    );
    expect(v.findings[0]?.message).toHaveLength(2000);
  });
});
