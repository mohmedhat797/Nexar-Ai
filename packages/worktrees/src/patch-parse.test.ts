import { describe, expect, it } from 'vitest';
import { isNexarError } from '@nexar/contracts';
import { parsePatch } from './patch-parse.js';

const H40 = 'a'.repeat(40);
const Z40 = '0'.repeat(40);

function added(path: string, quoted = false): string {
  const p = quoted ? `"${path}"` : path;
  return [
    `diff --git ${quoted ? `"a/${path}" "b/${path}"` : `a/${p} b/${p}`}`,
    'new file mode 100644',
    `index ${Z40}..${H40}`,
    '--- /dev/null',
    `+++ ${quoted ? `"b/${path}"` : `b/${p}`}`,
    '@@ -0,0 +1 @@',
    '+x',
    '',
  ].join('\n');
}

describe('parsePatch', () => {
  it('parses added, modified, deleted, mode and binary entries', () => {
    const text = [
      added('new.txt').slice(0, -1),
      `diff --git a/m.txt b/m.txt`,
      `index ${H40}..${'b'.repeat(40)} 100644`,
      '--- a/m.txt',
      '+++ b/m.txt',
      '@@ -1,2 +1,2 @@',
      ' keep',
      '-old',
      '+new',
      '\\ No newline at end of file',
      `diff --git a/d.txt b/d.txt`,
      'deleted file mode 100644',
      `index ${H40}..${Z40}`,
      '--- a/d.txt',
      '+++ /dev/null',
      '@@ -1 +0,0 @@',
      '-gone',
      `diff --git a/run.sh b/run.sh`,
      'old mode 100644',
      'new mode 100755',
      `diff --git a/bin.dat b/bin.dat`,
      'new file mode 100644',
      `index ${Z40}..${H40}`,
      'GIT binary patch',
      'literal 6',
      'Hc$@<O00001',
      '',
      'literal 0',
      'Hc$@<O00001',
      '',
      '',
    ].join('\n');
    const parsed = parsePatch(text);
    expect(parsed.entries).toEqual([
      { path: 'new.txt', status: 'added', newMode: '100644', binary: false },
      { path: 'm.txt', status: 'modified', oldMode: '100644', newMode: '100644', binary: false },
      { path: 'd.txt', status: 'deleted', oldMode: '100644', binary: false },
      { path: 'run.sh', status: 'modified', oldMode: '100644', newMode: '100755', binary: false },
      { path: 'bin.dat', status: 'added', newMode: '100644', binary: true },
    ]);
    expect(parsed.bytes).toBe(Buffer.byteLength(text));
    expect(parsed.sha256).toMatch(/^[0-9a-f]{64}$/);
  });

  it('accepts unquoted paths with spaces and C-quoted escapes decoded as UTF-8', () => {
    expect(parsePatch(added('dir/with space.txt')).entries[0]?.path).toBe('dir/with space.txt');
    expect(parsePatch(added('caf\\303\\251\\t\\"q\\"\\\\.txt', true)).entries[0]?.path).toBe(
      'café\t"q"\\.txt',
    );
  });

  it('treats empty input as zero entries', () => {
    expect(parsePatch('').entries).toEqual([]);
  });

  it('hashes the exact bytes it was given', () => {
    const bytes = new TextEncoder().encode(added('f.txt'));
    expect(parsePatch(bytes).bytes).toBe(bytes.length);
  });

  const rejects: Record<string, string> = {
    'text before the first header': `junk\n${added('f')}`,
    'missing trailing newline': added('f').slice(0, -1),
    rename: `diff --git a/x b/x\nsimilarity index 100%\nrename from x\nrename to y\n`,
    'rename from': `diff --git a/x b/x\nrename from x\n`,
    'copy from': `diff --git a/x b/x\ncopy from x\n`,
    'unknown header': `diff --git a/x b/x\nweird header\n`,
    'a/b mismatch': `diff --git a/x b/y\nnew file mode 100644\n`,
    'missing a/ prefix': `diff --git x y\n`,
    'binary without --binary': `diff --git a/x b/x\nindex ${H40}..${H40}\nBinary files a/x and b/x differ\n`,
    'file header mismatch': `diff --git a/x b/x\n--- a/other\n+++ b/x\n@@ -1 +1 @@\n-a\n+b\n`,
    'added with a source': `diff --git a/x b/x\nnew file mode 100644\n--- a/x\n+++ b/x\n@@ -1 +1 @@\n-a\n+b\n`,
    'truncated hunk': `diff --git a/x b/x\n--- a/x\n+++ b/x\n@@ -1,3 +1,3 @@\n a\n`,
    'bad hunk line': `diff --git a/x b/x\n--- a/x\n+++ b/x\n@@ -1 +1 @@\nxbad\n`,
    'trailing junk after hunk': `diff --git a/x b/x\n--- a/x\n+++ b/x\n@@ -1 +1 @@\n-a\n+b\nzzz\n`,
    'no hunks': `diff --git a/x b/x\n--- a/x\n+++ b/x\n`,
    'missing +++': `diff --git a/x b/x\n--- a/x\n`,
    'bad mode': `diff --git a/x b/x\nnew file mode 12\n`,
    'duplicate index': `diff --git a/x b/x\nindex ${H40}..${H40}\nindex ${H40}..${H40}\n`,
    'old mode alone': `diff --git a/x b/x\nold mode 100644\n`,
    'bad binary data': `diff --git a/x b/x\nGIT binary patch\nliteral 1\nnot base85 here\n`,
    'truncated binary': `diff --git a/x b/x\nGIT binary patch\nliteral 1\nHc$@<O00001\n`,
    'bad quoted escape': `diff --git "a/\\q" "b/\\q"\n`,
    'invalid utf8 in quoted path': `diff --git "a/\\377" "b/\\377"\n`,
    'unterminated quote': `diff --git "a/x "b/x\n`,
  };
  for (const [name, text] of Object.entries(rejects)) {
    it(`rejects: ${name}`, () => {
      expect(() => parsePatch(text)).toThrowError(
        expect.objectContaining({ code: 'VALIDATION_ERROR' }) as Error,
      );
    });
  }

  it('never echoes the offending path in the error', () => {
    try {
      parsePatch(`diff --git a/secret-path b/other-path\n`);
      expect.unreachable();
    } catch (error) {
      expect(isNexarError(error)).toBe(true);
      expect((error as Error).message).not.toContain('secret-path');
      expect((error as Error).message).not.toContain('other-path');
    }
    try {
      parsePatch(`diff --git a/secret-path b/secret-path\nrename from secret-path\n`);
      expect.unreachable();
    } catch (error) {
      expect((error as Error).message).not.toContain('secret-path');
    }
  });
});
