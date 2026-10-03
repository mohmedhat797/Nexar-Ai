import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  DEFAULT_CODE_PLANE,
  MAX_PLANE_PROJECTS,
  SettingsStore,
  type CodePlaneConfigResult,
} from './settings-store.js';

let dir: string;
let path: string;

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'nexar-settings-'));
  path = join(dir, 'desktop-settings.json');
});
afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

const base = { theme: 'light', density: 'comfortable', mode: 'cowork' };

async function codePlaneOf(section: unknown): Promise<CodePlaneConfigResult> {
  await writeFile(path, JSON.stringify({ ...base, codePlane: section }));
  return new SettingsStore(path).getCodePlane();
}

describe('Code plane settings', () => {
  it('defaults when the file or the section is missing', async () => {
    expect(await new SettingsStore(path).getCodePlane()).toEqual({
      valid: true,
      value: DEFAULT_CODE_PLANE,
    });
    await writeFile(path, JSON.stringify(base));
    expect(await new SettingsStore(path).getCodePlane()).toEqual({
      valid: true,
      value: DEFAULT_CODE_PLANE,
    });
    expect(DEFAULT_CODE_PLANE).toEqual({
      distro: 'nexar-plane',
      command: '/usr/local/bin/nexar',
      projects: {},
    });
  });

  it('fills defaults for omitted keys and accepts valid owner values', async () => {
    expect(await codePlaneOf({})).toEqual({ valid: true, value: DEFAULT_CODE_PLANE });
    expect(
      await codePlaneOf({
        distro: 'Ubuntu-24.04_plane',
        command: '/opt/nexar-1.2/bin/nexar',
        projects: { 'my.proj:1': 'plane_proj-2'.toLowerCase() },
      }),
    ).toEqual({
      valid: true,
      value: {
        distro: 'Ubuntu-24.04_plane',
        command: '/opt/nexar-1.2/bin/nexar',
        projects: { 'my.proj:1': 'plane_proj-2' },
      },
    });
  });

  it.each([
    ['a distro with a space', { distro: 'my distro' }],
    ['a distro starting with a dash (an option)', { distro: '-d' }],
    ['a distro with a shell metacharacter', { distro: 'x;rm' }],
    ['an empty distro', { distro: '' }],
    ['a 65-character distro', { distro: 'a'.repeat(65) }],
    ['a relative command', { command: 'nexar' }],
    ['a command with ..', { command: '/usr/../bin/sh' }],
    ['a command with a space', { command: '/usr/local/bin/nexar --x' }],
    ['a Windows command', { command: 'C:\nexar.exe' }],
    ['a command with shell characters', { command: '/bin/sh;id' }],
    ['a 257-character command', { command: `/${'a'.repeat(256)}` }],
    ['an unknown key', { shell: true }],
    ['a non-object', 'nexar-plane'],
    ['null', null],
    ['an array', []],
    ['a path as a plane project', { projects: { p: '/home/me/repo' } }],
    ['an uppercase desktop project id', { projects: { Proj: 'x' } }],
    ['a non-string mapping', { projects: { p: 1 } }],
  ])('fails closed on %s', async (_name, section) => {
    expect(await codePlaneOf(section)).toEqual({ valid: false });
  });

  it('never turns a prototype key into a mapping or pollutes Object', async () => {
    await writeFile(
      path,
      `{"theme":"light","density":"comfortable","mode":"cowork","codePlane":{"projects":{"__proto__":{"polluted":true}}}}`,
    );
    const result = await new SettingsStore(path).getCodePlane();
    if (result.valid) {
      expect(Object.keys(result.value.projects)).toEqual([]);
    }
    expect(({} as Record<string, unknown>)['polluted']).toBeUndefined();
  });

  it('refuses more than the maximum number of mappings', async () => {
    const projects = Object.fromEntries(
      Array.from({ length: MAX_PLANE_PROJECTS + 1 }, (_unused, i) => [`p${String(i)}`, 'x']),
    );
    expect(await codePlaneOf({ projects })).toEqual({ valid: false });
  });

  it('writes the section only once a mapping was set, and keeps the appearance keys', async () => {
    const store = new SettingsStore(path);
    await store.set({ theme: 'dark' });
    expect(JSON.parse(await readFile(path, 'utf8'))).toEqual({ ...base, theme: 'dark' });
    await store.setPlaneProject('proj-1', 'plane-1');
    expect(JSON.parse(await readFile(path, 'utf8'))).toEqual({
      ...base,
      theme: 'dark',
      codePlane: { ...DEFAULT_CODE_PLANE, projects: { 'proj-1': 'plane-1' } },
    });
    expect(await store.setPlaneProject('proj-1', null)).toEqual(DEFAULT_CODE_PLANE);
  });

  it('serializes concurrent mapping changes', async () => {
    const store = new SettingsStore(path);
    await Promise.all(
      Array.from({ length: 12 }, (_unused, i) => store.setPlaneProject(`p${String(i)}`, 'x')),
    );
    const stored = JSON.parse(await readFile(path, 'utf8')) as {
      codePlane: { projects: Record<string, string> };
    };
    expect(Object.keys(stored.codePlane.projects)).toHaveLength(12);
  });

  it('validates ids on write and enforces the mapping limit', async () => {
    const store = new SettingsStore(path);
    await expect(store.setPlaneProject('Bad Id', 'x')).rejects.toMatchObject({
      code: 'VALIDATION_ERROR',
    });
    await expect(store.setPlaneProject('ok', '../x')).rejects.toMatchObject({
      code: 'VALIDATION_ERROR',
    });
    await expect(store.setPlaneProject('__proto__', 'x')).rejects.toMatchObject({
      code: 'VALIDATION_ERROR',
    });
    for (let i = 0; i < MAX_PLANE_PROJECTS; i += 1)
      await store.setPlaneProject(`p${String(i)}`, 'x');
    await expect(store.setPlaneProject('one-too-many', 'x')).rejects.toMatchObject({
      code: 'POLICY_REJECTED',
    });
  });

  it('refuses to edit a damaged section', async () => {
    await writeFile(path, JSON.stringify({ ...base, codePlane: { distro: 'bad distro' } }));
    const store = new SettingsStore(path);
    await expect(store.setPlaneProject('p', 'x')).rejects.toMatchObject({
      code: 'CONFIGURATION_ERROR',
    });
    // Appearance changes still work and keep the owner's damaged text for them to fix.
    await store.set({ theme: 'sand' });
    expect(JSON.parse(await readFile(path, 'utf8'))).toMatchObject({
      theme: 'sand',
      codePlane: { distro: 'bad distro' },
    });
  });
});
