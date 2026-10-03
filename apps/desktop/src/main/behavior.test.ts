import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { behaviorProfile } from './behavior.js';
import { SettingsStore } from './settings-store.js';

let dir: string;
let path: string;
beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'nexar-behavior-'));
  path = join(dir, 'desktop-settings.json');
});
afterEach(async () => {
  await rm(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
});

describe('behaviorProfile', () => {
  it('uses the defaults and no preference when nothing is set', async () => {
    expect(await behaviorProfile(new SettingsStore(path), 'cowork')).toEqual({
      cowork: { permission: 'drafts-only' },
      code: { permission: 'auto-edit' },
    });
  });

  it("takes the preferred resource of the session's own mode and both permissions", async () => {
    const store = new SettingsStore(path);
    await store.setBehavior({
      cowork: { permission: 'read-only', preferredResourceId: 'res-cowork' },
      code: { permission: 'plan', preferredResourceId: 'res-code' },
    });
    const expected = {
      cowork: { permission: 'read-only' },
      code: { permission: 'plan' },
    };
    expect(await behaviorProfile(store, 'cowork')).toEqual({
      ...expected,
      preferredResourceIds: ['res-cowork'],
    });
    expect(await behaviorProfile(store, 'code')).toEqual({
      ...expected,
      preferredResourceIds: ['res-code'],
    });
  });

  it('throws a configuration error on a damaged section, so no turn starts on a guess', async () => {
    await writeFile(path, JSON.stringify({ behavior: { code: { permission: 'full-auto' } } }));
    await expect(behaviorProfile(new SettingsStore(path), 'code')).rejects.toMatchObject({
      code: 'CONFIGURATION_ERROR',
    });
  });
});
