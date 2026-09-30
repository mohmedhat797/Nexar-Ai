import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vitest/config';

const root = fileURLToPath(new URL('.', import.meta.url));

// Resolve `@nexar/<name>` to each workspace package's `src/index.ts` so tests need no build.
function workspaceAliases(): Record<string, string> {
  const aliases: Record<string, string> = {};
  for (const group of ['apps', 'packages', 'integrations']) {
    const groupDir = join(root, group);
    if (!existsSync(groupDir)) continue;
    for (const entry of readdirSync(groupDir, { withFileTypes: true })) {
      const manifest = join(groupDir, entry.name, 'package.json');
      const entryPoint = join(groupDir, entry.name, 'src', 'index.ts');
      if (!entry.isDirectory() || !existsSync(manifest) || !existsSync(entryPoint)) continue;
      const { name } = JSON.parse(readFileSync(manifest, 'utf8')) as { name?: string };
      if (name?.startsWith('@nexar/')) aliases[name] = entryPoint;
    }
  }
  return aliases;
}

// Live/paid-provider tests are opt-in: wrap them in
// `describe.skipIf(!process.env.NEXAR_LIVE_TESTS)`.
export default defineConfig({
  resolve: { alias: workspaceAliases() },
  test: {
    include: ['{apps,packages,integrations}/*/src/**/*.test.ts', 'tests/**/*.test.ts'],
  },
});
