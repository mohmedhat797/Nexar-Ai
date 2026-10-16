// Runs the Electron end-to-end spec (not part of `pnpm check`; build first).
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { ensureElectron } from './ensure-electron.mjs';

ensureElectron();
const config = fileURLToPath(new URL('../e2e/vitest.e2e.config.ts', import.meta.url));
// The Cowork scenarios drive the real DeepSeek Harness runtime (ADR-030); without an entry they skip.
// A packaged executable gets no entry at all: it must find its own bundled runtime.
const env = { ...process.env };
if (env.NEXAR_DESKTOP_EXECUTABLE) {
  delete env.NEXAR_DESKTOP_TEST_DSH_ENTRY;
  delete env.NEXAR_DSH_ENTRY;
} else if (env.NEXAR_DSH_ENTRY) env.NEXAR_DESKTOP_TEST_DSH_ENTRY = env.NEXAR_DSH_ENTRY;
const configArg = process.platform === 'win32' && config.includes(' ') ? `"${config}"` : config;
const result = spawnSync('pnpm', ['exec', 'vitest', 'run', '--config', configArg], {
  stdio: 'inherit',
  shell: process.platform === 'win32',
  env,
});
process.exit(result.status ?? 1);
