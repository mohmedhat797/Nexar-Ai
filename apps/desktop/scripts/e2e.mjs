// Runs the Electron end-to-end spec (not part of `pnpm check`; build first).
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { ensureElectron } from './ensure-electron.mjs';

ensureElectron();
const config = fileURLToPath(new URL('../e2e/vitest.e2e.config.ts', import.meta.url));
const result = spawnSync('pnpm', ['exec', 'vitest', 'run', '--config', config], {
  stdio: 'inherit',
  shell: process.platform === 'win32',
});
process.exit(result.status ?? 1);
