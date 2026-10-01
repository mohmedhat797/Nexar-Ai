// Runs the Electron end-to-end spec (not part of `pnpm check`; build first).
import { existsSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

// pnpm may skip Electron's postinstall (build-script approval state); fetch the binary if missing.
const require = createRequire(import.meta.url);
const electronDir = dirname(require.resolve('electron/package.json'));
if (!existsSync(join(electronDir, 'path.txt'))) {
  const install = spawnSync(process.execPath, [join(electronDir, 'install.js')], {
    stdio: 'inherit',
  });
  if (install.status !== 0) process.exit(install.status ?? 1);
}

const config = fileURLToPath(new URL('../e2e/vitest.e2e.config.ts', import.meta.url));
const result = spawnSync('pnpm', ['exec', 'vitest', 'run', '--config', config], {
  stdio: 'inherit',
  shell: process.platform === 'win32',
});
process.exit(result.status ?? 1);
