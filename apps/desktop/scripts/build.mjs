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

// The Intelligence Bridge relay (ADR-027 section 9a): launched by DeepSeek Harness as a plain Node script
// (ELECTRON_RUN_AS_NODE), so it is one self-contained CommonJS file with nothing resolved at run time.
await build({
  entryPoints: [at('../../integrations/mcp/src/bridge-relay-main.ts')],
  outfile: at('dist/main/bridge-relay.cjs'),
  bundle: true,
  platform: 'node',
  format: 'cjs',
  target: 'node22',
  // Source modules read `import.meta.url`; in CommonJS it is this file's own URL.
  define: { 'import.meta.url': '__importMetaUrl' },
  banner: { js: "const __importMetaUrl = require('node:url').pathToFileURL(__filename).href;" },
  logLevel: 'info',
});

// The loopback Chat Completions translator (ADR-027 section 7A): a supervised child of the main process,
// launched the same way (ELECTRON_RUN_AS_NODE), so it is one self-contained CommonJS file too.
await build({
  entryPoints: [at('src/control-gateway/main.ts')],
  outfile: at('dist/main/control-gateway.cjs'),
  bundle: true,
  platform: 'node',
  format: 'cjs',
  target: 'node22',
  logLevel: 'info',
});

// The loopback redirect target of one ChatGPT sign-in: a short-lived child per sign-in (ADR-021: main
// opens no listener), launched the same way, so it is one self-contained CommonJS file too.
await build({
  entryPoints: [at('src/signin-callback/main.ts')],
  outfile: at('dist/main/signin-callback.cjs'),
  bundle: true,
  platform: 'node',
  format: 'cjs',
  target: 'node22',
  logLevel: 'info',
});

await viteBuild({ configFile: at('vite.config.ts'), logLevel: 'info' });
