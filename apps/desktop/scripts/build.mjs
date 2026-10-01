// Bundles the Electron main process (ESM) and preload (CJS), then builds the renderer with Vite.
import { rm } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { build } from 'esbuild';
import { build as viteBuild } from 'vite';

const at = (path) => fileURLToPath(new URL(`../${path}`, import.meta.url));

await rm(at('dist'), { recursive: true, force: true });

await build({
  entryPoints: [at('src/main/main.ts')],
  outfile: at('dist/main/main.js'),
  bundle: true,
  platform: 'node',
  format: 'esm',
  target: 'node22',
  sourcemap: true,
  // electron, zod and every @nexar/* workspace package are resolved at run time.
  packages: 'external',
  logLevel: 'info',
});

await build({
  entryPoints: [at('src/preload/preload.ts')],
  outfile: at('dist/preload/preload.cjs'),
  bundle: true,
  platform: 'node',
  format: 'cjs',
  target: 'node22',
  sourcemap: true,
  external: ['electron'],
  logLevel: 'info',
});

await viteBuild({ configFile: at('vite.config.ts'), logLevel: 'info' });
