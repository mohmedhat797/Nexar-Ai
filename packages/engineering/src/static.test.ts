import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const SRC = fileURLToPath(new URL('.', import.meta.url));

const sources = readdirSync(SRC)
  .filter((f) => f.endsWith('.ts') && !f.endsWith('.test.ts') && !f.endsWith('.testkit.ts'))
  .map((f) => ({ file: f, text: readFileSync(join(SRC, f), 'utf8') }));

describe('@nexar/engineering has no way to reach the network or publish', () => {
  it('has source files to check', () => {
    expect(sources.map((s) => s.file)).toEqual(
      expect.arrayContaining(['runner.ts', 'execution.ts', 'commands.ts']),
    );
  });

  it('imports no network or mail module', () => {
    const forbidden =
      /from\s+['"](?:node:)?(?:net|http|https|http2|dgram|tls|dns|nodemailer|smtp[\w-]*|imap[\w-]*)['"]|import\s*\(\s*['"](?:node:)?(?:net|http|https|dgram|nodemailer)['"]/;
    for (const { file, text } of sources) {
      expect(text, file).not.toMatch(forbidden);
      expect(text, file).not.toMatch(/\bfetch\s*\(/);
      expect(text, file).not.toMatch(/\bXMLHttpRequest\b|\bWebSocket\b/);
    }
  });

  it('never invokes git push', () => {
    for (const { file, text } of sources) {
      expect(text, file).not.toMatch(/git\s+push/i);
      expect(text, file).not.toMatch(/['"`]push['"`]/);
      expect(text, file).not.toMatch(/\bgit\b.*['"]send-pack['"]/);
    }
  });

  it('does not run host git itself (only through @nexar/worktrees and the launcher)', () => {
    for (const { file, text } of sources) {
      expect(text, file).not.toMatch(/execFile|execSync|spawnSync/);
      expect(text, file).not.toMatch(/['"]git['"]/);
    }
  });

  it('only spawns what a launcher prepared', () => {
    const spawners = sources.filter((s) => /\bspawn\s*\(/.test(s.text));
    expect(spawners.map((s) => s.file)).toEqual(['commands.ts']);
    expect(spawners[0]?.text).toMatch(/spawn\(prepared\.command/);
  });
});
