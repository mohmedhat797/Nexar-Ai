import { describe, expect, it } from 'vitest';
import { globToRegExp, validatePatch } from './patch-policy.js';
import type { ParsedPatch, PatchEntry, PatchPolicy } from './types.js';

function patch(entries: PatchEntry[], bytes = 100): ParsedPatch {
  return { entries, bytes, sha256: 'f'.repeat(64) };
}

const file = (path: string, extra: Partial<PatchEntry> = {}): PatchEntry => ({
  path,
  status: 'modified',
  oldMode: '100644',
  newMode: '100644',
  binary: false,
  ...extra,
});

function rulesFor(entry: PatchEntry, policy: PatchPolicy = {}): string[] {
  const result = validatePatch(patch([entry]), policy);
  return result.ok ? [] : result.violations.map((v) => v.rule);
}

describe('validatePatch', () => {
  it('accepts an ordinary patch and reports bytes and hash', () => {
    const result = validatePatch(
      patch([file('src/a.ts'), file('b.md', { status: 'added', oldMode: '' })]),
    );
    expect(result.ok).toBe(true);
  });

  const added = (path: string, newMode = '100644'): PatchEntry => ({
    path,
    status: 'added',
    newMode,
    binary: false,
  });

  const table: [string, PatchEntry, PatchPolicy | undefined, string][] = [
    ['empty path', file(''), undefined, 'path-empty'],
    ['absolute', file('/etc/passwd'), undefined, 'path-absolute'],
    ['drive letter', file('C:/x'), undefined, 'path-absolute'],
    ['backslash', file('a\\b'), undefined, 'path-backslash'],
    ['NUL', file('a\0b'), undefined, 'path-control-char'],
    ['newline', file('a\nb'), undefined, 'path-control-char'],
    ['dot-dot', file('../x'), undefined, 'path-dot-segment'],
    ['nested dot-dot', file('a/../../x'), undefined, 'path-dot-segment'],
    ['dot', file('a/./b'), undefined, 'path-dot-segment'],
    ['double slash', file('a//b'), undefined, 'path-empty-segment'],
    ['.git', file('.git/config'), undefined, 'path-dot-git'],
    ['.GIT', file('.GIT/hooks/pre-commit'), undefined, 'path-dot-git'],
    ['.git.', file('.git./config'), undefined, 'path-dot-git'],
    ['.git space', file('.git /config'), undefined, 'path-dot-git'],
    ['nested .git', file('sub/.git/config'), undefined, 'path-dot-git'],
    ['git~1', file('GIT~1/config'), undefined, 'path-dot-git'],
    ['.gitmodules', file('.gitmodules'), undefined, 'path-gitmodules'],
    ['nested .GitModules', file('a/.GitModules'), undefined, 'path-gitmodules'],
    ['.gitattributes', file('sub/.gitattributes'), undefined, 'path-gitattributes'],
    ['workflow', file('.github/workflows/ci.yml'), undefined, 'path-github-workflows'],
    ['workflow case', file('.GitHub/Workflows/ci.yml'), undefined, 'path-github-workflows'],
    ['gitlink', added('vendor/lib', '160000'), undefined, 'gitlink'],
    [
      'gitlink even when symlinks allowed',
      added('vendor/lib', '160000'),
      { allowSymlinks: true },
      'gitlink',
    ],
    ['symlink', added('link', '120000'), undefined, 'symlink'],
    [
      'modified symlink',
      file('link', { oldMode: '120000', newMode: '120000' }),
      undefined,
      'symlink',
    ],
    ['mode change', file('run.sh', { newMode: '100755' }), undefined, 'mode-change'],
    ['odd new-file mode', added('x', '100664'), undefined, 'new-file-mode'],
    ['deny glob', file('config/prod.env'), { denyGlobs: ['**/*.env'] }, 'deny-glob'],
  ];
  for (const [name, entry, policy, rule] of table) {
    it(`flags ${name} as ${rule}`, () => {
      expect(rulesFor(entry, policy)).toContain(rule);
    });
  }

  it('allows symlinks and mode changes only when the policy says so', () => {
    expect(rulesFor(added('link', '120000'), { allowSymlinks: true })).toEqual([]);
    expect(rulesFor(file('run.sh', { newMode: '100755' }), { allowModeChanges: true })).toEqual([]);
    expect(rulesFor(added('run.sh', '100755'))).toEqual([]);
  });

  it('applies size, count and emptiness rules at patch level', () => {
    expect(validatePatch(patch([], 0))).toEqual({
      ok: false,
      violations: [{ rule: 'empty', index: -1 }],
    });
    const big = validatePatch(patch([file('a')], 6 * 1024 * 1024));
    expect(big).toEqual({ ok: false, violations: [{ rule: 'too-large', index: -1 }] });
    expect(validatePatch(patch([file('a')], 50), { maxBytes: 10 }).ok).toBe(false);
    const many = Array.from({ length: 1001 }, (_, i) => file(`f${i}`));
    expect(validatePatch(patch(many))).toEqual({
      ok: false,
      violations: [{ rule: 'too-many-files', index: -1 }],
    });
    expect(validatePatch(patch(many), { maxFiles: 2000 }).ok).toBe(true);
  });

  it('keeps unrelated names legal', () => {
    for (const path of [
      '.github/CODEOWNERS',
      '.gitignore',
      'gitmodules',
      'a.git/x',
      '.github/workflows',
    ]) {
      expect(rulesFor(file(path))).toEqual([]);
    }
  });

  it('reports entry indexes and never includes paths', () => {
    const result = validatePatch(patch([file('ok.txt'), file('../secret-name')]));
    expect(result).toEqual({ ok: false, violations: [{ rule: 'path-dot-segment', index: 1 }] });
    expect(JSON.stringify(result)).not.toContain('secret-name');
  });
});

describe('globToRegExp', () => {
  const matches = (glob: string, path: string) => globToRegExp(glob).test(path);
  it('supports *, ** and ?', () => {
    expect(matches('*.env', 'a.env')).toBe(true);
    expect(matches('*.env', 'dir/a.env')).toBe(false);
    expect(matches('**/*.env', 'a.env')).toBe(true);
    expect(matches('**/*.env', 'x/y/a.env')).toBe(true);
    expect(matches('secrets/**', 'secrets/a/b')).toBe(true);
    expect(matches('a?c', 'abc')).toBe(true);
    expect(matches('a?c', 'a/c')).toBe(false);
    expect(matches('src/*.ts', 'src/a.ts')).toBe(true);
    expect(matches('src/*.ts', 'src/x/a.ts')).toBe(false);
  });
  it('treats regex metacharacters literally', () => {
    expect(matches('a.b', 'axb')).toBe(false);
    expect(matches('a+(b)[c]', 'a+(b)[c]')).toBe(true);
  });
});
