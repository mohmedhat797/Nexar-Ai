// pnpm may skip Electron's postinstall (build-script approval state); fetch the binary if missing.
import { existsSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import { spawnSync } from 'node:child_process';

export function ensureElectron() {
  const require = createRequire(import.meta.url);
  const electronDir = dirname(require.resolve('electron/package.json'));
  if (existsSync(join(electronDir, 'path.txt'))) return;
  const install = spawnSync(process.execPath, [join(electronDir, 'install.js')], {
    stdio: 'inherit',
  });
  if (install.status !== 0) process.exit(install.status ?? 1);
}
