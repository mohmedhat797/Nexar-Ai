import { describe, expect, it } from 'vitest';
import { sanitizeFilename, type ArtifactMediaType } from './sanitize.js';

describe('sanitizeFilename', () => {
  const md = 'text/markdown' as const;
  const cases: readonly [string, string, ArtifactMediaType, string][] = [
    ['traversal', '../../etc/passwd', md, 'passwd.md'],
    ['absolute', '/etc/shadow', 'text/plain', 'shadow.txt'],
    ['windows absolute', 'C:\\Windows\\system32\\evil', md, 'evil.md'],
    ['backslashes', '..\\..\\x\\notes.md', md, 'notes.md'],
    ['trailing separator', 'dir/', md, 'artifact.md'],
    ['dot-dot only', '..', md, 'artifact.md'],
    ['single dot', '.', md, 'artifact.md'],
    ['fullwidth lookalikes', 'ｎｏｔｅｓ.md', md, 'notes.md'],
    ['fullwidth slash', '..／..／x', md, 'x.md'],
    ['control chars', 'a\u0000b\u001bc\nd.md', md, 'abcd.md'],
    ['spaces and symbols', 'My Plan: Q3 <draft>!.md', md, 'My-Plan-Q3-draft.md'],
    ['reserved CON', 'CON', md, '_CON.md'],
    ['reserved lower with ext', 'nul.txt', 'text/plain', '_nul.txt'],
    ['reserved COM1', 'com1.json', 'application/json', '_com1.json'],
    ['not reserved', 'console', md, 'console.md'],
    ['dotfile', '.bashrc', 'text/plain', 'bashrc.txt'],
    ['leading dashes', '--rf', md, 'rf.md'],
    ['script extension replaced', 'run.sh', md, 'run.md'],
    ['html extension replaced', 'page.HTML', 'text/plain', 'page.txt'],
    ['double extension', 'evil.sh.md', md, 'evil.sh.md'],
    ['upper-case own extension', 'NOTES.MD', md, 'NOTES.md'],
    ['no extension', 'report', 'text/csv', 'report.csv'],
    ['empty', '', md, 'artifact.md'],
    ['only symbols', '***', md, 'artifact.md'],
    ['repeated dots', 'a...b', md, 'a.md'],
  ];

  it.each(cases)('%s', (_name, input, mediaType, expected) => {
    expect(sanitizeFilename(input, mediaType)).toBe(expected);
  });

  it('caps the length at 100 and keeps the extension', () => {
    const out = sanitizeFilename(`${'a'.repeat(300)}.md`, md);
    expect(out).toHaveLength(100);
    expect(out.endsWith('.md')).toBe(true);
  });

  it('only ever yields safe characters', () => {
    for (const input of ['a/b', '\u202e.exe', '日本語', '%2e%2e%2f', 'a\tb', '~/x', '$(id)']) {
      expect(sanitizeFilename(input, md)).toMatch(/^[A-Za-z0-9_][A-Za-z0-9._-]*\.md$/);
    }
  });
});
