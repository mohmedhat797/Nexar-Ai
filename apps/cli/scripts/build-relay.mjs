// Bundles the Intelligence Bridge stdio relay (ADR-027 sections 9a and 9b) into one self-contained
// CommonJS file beside the CLI build output. The engineering plane mounts it read-only into a lane's
// sandbox (`LaunchServices.relayScript`) and the sandbox's Node runs it, so nothing is resolved at
// run time. Usage: `node scripts/build-relay.mjs [outfile]` (default `dist/bridge-relay.cjs`).
import { fileURLToPath } from 'node:url';
import { build } from 'esbuild';

const at = (path) => fileURLToPath(new URL(`../${path}`, import.meta.url));

await build({
  entryPoints: [at('../../integrations/mcp/src/bridge-relay-main.ts')],
  outfile: process.argv[2] ?? at('dist/bridge-relay.cjs'),
  bundle: true,
  platform: 'node',
  format: 'cjs',
  target: 'node22',
  // Source modules read `import.meta.url`; in CommonJS it is this file's own URL.
  define: { 'import.meta.url': '__importMetaUrl' },
  banner: { js: "const __importMetaUrl = require('node:url').pathToFileURL(__filename).href;" },
  logLevel: 'info',
});
