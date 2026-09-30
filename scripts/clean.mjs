import { existsSync, readdirSync, rmSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(fileURLToPath(new URL('.', import.meta.url)), '..');

for (const group of ['apps', 'packages', 'integrations']) {
  const groupDir = join(root, group);
  if (!existsSync(groupDir)) continue;
  for (const entry of readdirSync(groupDir, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue;
    const pkgDir = join(groupDir, entry.name);
    rmSync(join(pkgDir, 'dist'), { recursive: true, force: true });
    for (const file of readdirSync(pkgDir)) {
      if (file.endsWith('.tsbuildinfo')) rmSync(join(pkgDir, file), { force: true });
    }
  }
}

for (const file of readdirSync(root)) {
  if (file.endsWith('.tsbuildinfo')) rmSync(join(root, file), { force: true });
}
