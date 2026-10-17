// Audit-only synthetic I/O failures, restricted to this suite's disposable paths.
import * as fs from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, dirname, resolve } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { writeFileAtomic } from './atomic-write.js';
import { SettingsStore } from './settings-store.js';
const fault = vi.hoisted(() => ({ target: '', phase: '' }));
vi.mock('node:fs/promises', async (original) => {
  const real = await original<typeof fs>();
  const matches = (path: unknown) =>
    fault.target !== '' &&
    String(path).startsWith(fault.target + '.') &&
    String(path).endsWith('.tmp');
  return {
    ...real,
    writeFile: async (...args: Parameters<typeof real.writeFile>) => {
      if (matches(args[0]) && fault.phase === 'before-temp') throw Error('AUDIT before temp');
      if (matches(args[0]) && fault.phase === 'during-temp') {
        await real.writeFile(args[0], 'AUDIT partial', args[2]);
        throw Error('AUDIT during temp');
      }
      return real.writeFile(...args);
    },
    rename: async (...args: Parameters<typeof real.rename>) => {
      if (String(args[1]) === fault.target && fault.phase === 'before-rename')
        throw Error('AUDIT before rename');
      await real.rename(...args);
      if (String(args[1]) === fault.target && fault.phase === 'after-rename')
        throw Error('AUDIT after rename acknowledgement');
    },
  };
});
let dir: string;
beforeEach(async () => {
  fault.target = '';
  fault.phase = '';
  dir = await fs.mkdtemp(join(tmpdir(), 'nexar070b-audit-'));
});
afterEach(async () => {
  fault.target = '';
  fault.phase = '';
  const p = resolve(dir);
  if (dirname(p) !== resolve(tmpdir()) || !p.split(/[\\/]/).at(-1)?.startsWith('nexar070b-audit-'))
    throw Error('unsafe cleanup');
  await fs.rm(p, { recursive: true, force: true });
});
describe('Settings backup and atomic-write regression gates', () => {
  it.each(['before-temp', 'during-temp', 'before-rename'])(
    'F01 atomic helper preserves old primary on %s',
    async (phase) => {
      const path = join(dir, 'fixture.json');
      await writeFileAtomic(path, 'old');
      fault.target = path;
      fault.phase = phase;
      await expect(writeFileAtomic(path, 'new')).rejects.toThrow('AUDIT');
      expect(await fs.readFile(path, 'utf8')).toBe('old');
      expect((await fs.readdir(dir)).filter((x) => x.endsWith('.tmp'))).toHaveLength(0);
    },
  );
  it('F02 after-rename acknowledgement failure reloads committed disk state instead of retaining stale cache', async () => {
    const path = join(dir, 'settings.json');
    const store = new SettingsStore(path);
    await store.set({ theme: 'light' });
    fault.target = path;
    fault.phase = 'after-rename';
    await expect(store.set({ theme: 'dark' })).rejects.toThrow('AUDIT');
    expect((await store.get()).theme).toBe('dark');
    expect((await new SettingsStore(path).get()).theme).toBe('dark');
  });
  it('F03 backup write failure refuses primary mutation', async () => {
    const path = join(dir, 'settings.json');
    const store = new SettingsStore(path);
    await store.set({ theme: 'light' });
    fault.target = path + '.bak';
    fault.phase = 'before-temp';
    await expect(store.set({ theme: 'dark' })).rejects.toThrow();
    expect((await new SettingsStore(path).get()).theme).toBe('light');
    await expect(fs.readFile(path + '.bak', 'utf8')).rejects.toThrow();
  });
  it('F04 corrupt backup does not damage valid primary; corrupt primary fails connection authority closed', async () => {
    const path = join(dir, 'settings.json');
    const store = new SettingsStore(path);
    await store.set({ theme: 'light' });
    await store.set({ theme: 'dark' });
    await fs.writeFile(path + '.bak', '{AUDIT-broken-backup');
    expect((await new SettingsStore(path).get()).theme).toBe('dark');
    await fs.writeFile(path, '{AUDIT-broken-primary');
    const loaded = await new SettingsStore(path).getConnections();
    expect(loaded.valid).toBe(false);
  });
});
