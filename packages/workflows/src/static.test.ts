import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const SRC = fileURLToPath(new URL('.', import.meta.url));
const PACKAGE = join(SRC, '..');

const sources = readdirSync(SRC)
  .filter((f) => f.endsWith('.ts') && !f.endsWith('.test.ts'))
  .map((f) => ({ file: f, text: readFileSync(join(SRC, f), 'utf8') }));

describe('@nexar/workflows has no way to act outward', () => {
  it('has source files to check', () => {
    expect(sources.map((s) => s.file)).toContain('runner.ts');
  });

  it('never references performOutwardAction or the approvals package', () => {
    for (const { file, text } of sources) {
      expect(text, file).not.toContain('performOutwardAction');
      expect(text, file).not.toMatch(/@nexar\/approvals/);
    }
  });

  it('imports no network, mail or process modules', () => {
    const forbidden =
      /from\s+['"](?:node:)?(?:net|http|https|http2|dgram|tls|dns|child_process|worker_threads)['"]|import\s*\(\s*['"](?:node:)?(?:net|http|https|child_process)['"]/;
    for (const { file, text } of sources) {
      expect(text, file).not.toMatch(forbidden);
      expect(text, file).not.toMatch(/\bfetch\s*\(/);
      expect(text, file).not.toMatch(/\bXMLHttpRequest\b|\bWebSocket\b/);
    }
  });

  it('depends on no mail, calendar or HTTP client package', () => {
    const manifest = JSON.parse(readFileSync(join(PACKAGE, 'package.json'), 'utf8')) as {
      dependencies: Record<string, string>;
    };
    expect(Object.keys(manifest.dependencies).sort()).toEqual([
      '@nexar/artifacts',
      '@nexar/contracts',
      '@nexar/core',
      '@nexar/projects',
      'zod',
    ]);
  });
});
