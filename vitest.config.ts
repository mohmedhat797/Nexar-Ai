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
      const { name, exports } = JSON.parse(readFileSync(manifest, 'utf8')) as {
        name?: string;
        exports?: Record<string, { default?: string }>;
      };
      if (!name?.startsWith('@nexar/')) continue;
      // Subpath exports (e.g. `@nexar/engine-gateway/testing`) first: the first matching alias wins.
      for (const [subpath, target] of Object.entries(exports ?? {})) {
        const built = /^\.\/dist\/(.+)\.js$/.exec(target.default ?? '');
        const source =
          built === null ? undefined : join(groupDir, entry.name, 'src', `${built[1]}.ts`);
        if (subpath !== '.' && source !== undefined && existsSync(source)) {
          aliases[`${name}/${subpath.slice(2)}`] = source;
        }
      }
      aliases[name] = entryPoint;
    }
  }
  return aliases;
}

// Live/paid-provider tests are opt-in: wrap them in
// `describe.skipIf(!process.env.NEXAR_LIVE_TESTS)`.
export default defineConfig({
  resolve: { alias: workspaceAliases() },
  test: {
    // Bound concurrent fake subprocesses and filesystem contention on Windows; run every suite.
    ...(process.platform === 'win32' ? { maxWorkers: 4 } : {}),
    // GitHub's Windows runners stall all workers at once for seconds at a time: run 37117682132
    // timed out six unrelated suites within three seconds of each other. A Windows-only budget
    // absorbs those pauses; Linux keeps the 5 s default so real slowdowns still surface there.
    ...(process.platform === 'win32' ? { testTimeout: 15_000, hookTimeout: 30_000 } : {}),
    include: ['{apps,packages,integrations}/*/src/**/*.test.ts', 'tests/**/*.test.ts'],
  },
});
