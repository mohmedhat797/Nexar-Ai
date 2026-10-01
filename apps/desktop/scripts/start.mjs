// Starts the built app (run `pnpm build` first). Extra arguments are passed to Electron.
import { spawnSync } from 'node:child_process';
import { createRequire } from 'node:module';
import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { ensureElectron } from './ensure-electron.mjs';

const main = fileURLToPath(new URL('../dist/main/main.js', import.meta.url));
if (!existsSync(main)) {
  process.stderr.write('nexar-desktop: not built yet; run `pnpm build` at the repository root\n');
  process.exit(1);
}
ensureElectron();
const require = createRequire(import.meta.url);
/** The `electron` package's main export is the path of the Electron binary. */
const electron = require('electron');
const result = spawnSync(electron, [main, ...process.argv.slice(2)], { stdio: 'inherit' });
process.exit(result.status ?? 1);
