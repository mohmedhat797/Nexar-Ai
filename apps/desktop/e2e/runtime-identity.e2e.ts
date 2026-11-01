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
  expect(identity.nodeVersion).toBe('24.22.1');
  expect(identity.chromeVersion).toMatch(/^152\./);
  expect(identity.v8Version).toMatch(/^15\./);
  expect(identity.executable).toBeTruthy();
  process.stdout.write(`Verified Desktop runtime ${JSON.stringify(identity)}\n`);
  await harness.close(app);
}, 120_000);
