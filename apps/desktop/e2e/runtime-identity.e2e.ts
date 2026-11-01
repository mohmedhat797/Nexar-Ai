import { readFile } from 'node:fs/promises';
import { afterAll, beforeAll, expect, it } from 'vitest';
import { createHarness, mainProcessIdentity, type Harness } from './harness.js';

let harness: Harness;
beforeAll(async () => {
  harness = await createHarness();
});
afterAll(async () => {
  await harness.dispose();
});

it('runs the reviewed Electron and embedded Node in the actual main process', async () => {
  const manifest = JSON.parse(
    await readFile(new URL('../package.json', import.meta.url), 'utf8'),
  ) as {
    devDependencies: { electron: string };
  };
  const { app } = await harness.launch(harness.newUserData('runtime-identity'));
  const identity = await mainProcessIdentity(app);
  expect(identity.electronVersion).toBe(manifest.devDependencies.electron);
  // Electron security modernization is blocked by rc.5's loader fingerprint support.
  // Verify the explicitly retained baseline; do not imply development Node is embedded here.
  expect(identity.nodeVersion).toBe('24.21.0');
  expect(identity.chromeVersion).toBe('152.0.7977.130');
  expect(identity.v8Version).toBe('15.2.124.28-electron.0');
  expect(identity.executable).toBeTruthy();
  process.stdout.write(`Verified Desktop runtime ${JSON.stringify(identity)}\n`);
  await harness.close(app);
}, 120_000);
