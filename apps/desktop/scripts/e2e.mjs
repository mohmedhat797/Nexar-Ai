// Runs the Electron end-to-end spec (not part of `pnpm check`; build first).
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { ensureElectron } from './ensure-electron.mjs';

ensureElectron();
const config = fileURLToPath(new URL('../e2e/vitest.e2e.config.ts', import.meta.url));
// The Cowork scenarios drive the real DeepSeek Harness runtime (ADR-030); without an entry they skip.
const env = { ...process.env };
if (env.NEXAR_DSH_ENTRY) env.NEXAR_DESKTOP_TEST_DSH_ENTRY = env.NEXAR_DSH_ENTRY;
else delete env.NEXAR_DESKTOP_TEST_DSH_ENTRY;
const result = spawnSync('pnpm', ['exec', 'vitest', 'run', '--config', config], {
  stdio: 'inherit',
  shell: process.platform === 'win32',
  env,
});
process.exit(result.status ?? 1);
