import { lstatSync } from 'node:fs';
import {
  link,
  mkdir,
  mkdtemp,
  readFile,
  realpath,
  rm,
  stat,
  symlink,
  writeFile,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { BUILTIN_CONNECTIONS, type PersistentConnectionRecord } from '@nexar/contracts';
import { CodexHomeStore } from './codex-home-store.js';

const MARKER = '11111111-1111-4111-8111-111111111111';
const ID = 'openai.subscription.caaaaaaaaaa';
const OTHER_ID = 'openai.subscription.cbbbbbbbbbb';

function record(id = ID, marker = MARKER): PersistentConnectionRecord {
  return {
    ...BUILTIN_CONNECTIONS['openai.subscription'],
    id,
    builtIn: false,
    credentialScope: { kind: 'native-home', runtimeId: 'codex', home: 'private' },
    nativeHome: { marker },
    credentialGeneration: 1,
    identityAssurance: 'IDENTITY_UNKNOWN',
    lifecycleState: 'ACTIVE',
    createdAt: '2026-11-01T00:00:00.000Z',
    updatedAt: '2026-11-01T00:00:00.000Z',
  };
}

const refused = { code: 'CONFIGURATION_ERROR' };
let userData: string;
let store: CodexHomeStore;

/** Junctions work unprivileged on Windows, and report as links like a POSIX symlink. */
const linkDir = (target: string, path: string): Promise<void> => symlink(target, path, 'junction');

beforeEach(async () => {
  userData = await realpath(await mkdtemp(join(tmpdir(), 'nexar-codex-home-')));
  store = new CodexHomeStore({
    userData,
    secureDirectory: (path) => mkdir(path, { recursive: true, mode: 0o700 }).then(() => undefined),
  });
});

afterEach(async () => {
  await rm(userData, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
});

describe('CodexHomeStore across the WSL boundary', () => {
  const across = [
    ['linux', '/mnt/c/Users/owner/AppData/Roaming/Nexar'],
    ['linux', '/mnt'],
    ['linux', '//wsl.localhost/Ubuntu/home/nexar'],
    ['win32', '\\\\wsl.localhost\\nexar-plane\\home\\nexar\\.nexar'],
    ['win32', '//wsl.localhost/nexar-plane/home/nexar/.nexar'],
  ] as const;

  it.each(across)('refuses a %s root at %s and touches nothing', async (platform, root) => {
    let secured = 0;
    const offHost = new CodexHomeStore({
      userData: root,
      platform,
      secureDirectory: () => {
        secured += 1;
        return Promise.resolve();
      },
    });
    await expect(offHost.ensure(record())).rejects.toMatchObject(refused);
    await expect(offHost.resolve(record())).rejects.toMatchObject(refused);
    await expect(offHost.remove(record())).rejects.toMatchObject(refused);
    expect(secured).toBe(0);
  });
});

describe('CodexHomeStore', () => {
  it('creates a home at the fixed path, with its marker outside the home', async () => {
    const home = await store.ensure(record());
    expect(home).toBe(join(userData, 'runtime-homes', ID, 'codex'));
    expect(lstatSync(home).isDirectory()).toBe(true);
    expect(await readFile(join(userData, 'runtime-homes', ID, '.nexar-runtime-home'), 'utf8')).toBe(
      MARKER,
    );
    expect(await store.resolve(record())).toBe(home);
  });

  it.skipIf(process.platform === 'win32')('creates homes with mode 0700', async () => {
    const home = await store.ensure(record());
    expect((await stat(home)).mode & 0o777).toBe(0o700);
    expect((await stat(join(home, '..'))).mode & 0o777).toBe(0o700);
  });

  it('gives each connection its own home', async () => {
    const a = await store.ensure(record());
    const b = await store.ensure(record(OTHER_ID, '22222222-2222-4222-8222-222222222222'));
    expect(a).not.toBe(b);
  });

  it('resolves to nothing before a home exists, and never creates one', async () => {
    expect(await store.resolve(record())).toBeUndefined();
    expect(() => lstatSync(join(userData, 'runtime-homes'))).toThrow();
  });

  it.each([
    ['a built-in id', { ...record(), id: 'openai.subscription' }],
    ['a path in the id', { ...record(), id: 'openai.subscription.caaaaaaaaaa/../..' }],
    [
      'a default home',
      {
        ...record(),
        credentialScope: { kind: 'native-home', runtimeId: 'codex', home: 'default' },
      },
    ],
    [
      'another runtime',
      {
        ...record(),
        credentialScope: { kind: 'native-home', runtimeId: 'claude-code', home: 'private' },
      },
    ],
    ['a built-in record', { ...record(), builtIn: true }],
    ['no recorded marker', { ...record(), nativeHome: undefined }],
  ] as const)('refuses %s on every action', async (_name, bad) => {
    const r = bad as PersistentConnectionRecord;
    await expect(store.resolve(r)).rejects.toMatchObject(refused);
    await expect(store.ensure(r)).rejects.toMatchObject(refused);
    await expect(store.remove(r)).rejects.toMatchObject(refused);
  });

  it('refuses another connection marker, and a home with the marker missing', async () => {
    await store.ensure(record());
    const other = record(ID, '33333333-3333-4333-8333-333333333333');
    await expect(store.resolve(other)).rejects.toMatchObject(refused);
    await expect(store.ensure(other)).rejects.toMatchObject(refused);
    await expect(store.remove(other)).rejects.toMatchObject(refused);
    await rm(join(userData, 'runtime-homes', ID, '.nexar-runtime-home'));
    await expect(store.resolve(record())).rejects.toMatchObject(refused);
    await expect(store.ensure(record())).rejects.toMatchObject(refused);
    await expect(store.remove(record())).rejects.toMatchObject(refused);
  });

  it('refuses a linked root, connection directory and home', async () => {
    const outside = await mkdtemp(join(tmpdir(), 'nexar-codex-outside-'));
    try {
      await writeFile(join(outside, 'sentinel'), 'keep');
      const root = join(userData, 'runtime-homes');
      await linkDir(outside, root);
      await expect(store.resolve(record())).rejects.toMatchObject(refused);
      await expect(store.remove(record())).rejects.toMatchObject(refused);
      await rm(root, { recursive: true });

      await mkdir(root);
      await linkDir(outside, join(root, ID));
      await expect(store.ensure(record())).rejects.toMatchObject(refused);
      await expect(store.remove(record())).rejects.toMatchObject(refused);
      await rm(join(root, ID), { recursive: true });

      await store.ensure(record());
      await rm(join(root, ID, 'codex'), { recursive: true });
      await linkDir(outside, join(root, ID, 'codex'));
      await expect(store.resolve(record())).rejects.toMatchObject(refused);
      expect(await readFile(join(outside, 'sentinel'), 'utf8')).toBe('keep');
    } finally {
      await rm(outside, { recursive: true, force: true });
    }
  });

  it('refuses a hard-linked marker', async () => {
    await store.ensure(record());
    const marker = join(userData, 'runtime-homes', ID, '.nexar-runtime-home');
    await link(marker, join(userData, 'marker-copy'));
    await expect(store.resolve(record())).rejects.toMatchObject(refused);
  });

  it('adopts an interrupted creation, and refuses a directory it did not make', async () => {
    const dir = join(userData, 'runtime-homes', ID);
    await mkdir(dir, { recursive: true });
    await writeFile(join(dir, '.nexar-desktop-state'), '');
    expect(await store.ensure(record())).toBe(join(dir, 'codex'));

    const foreign = join(userData, 'runtime-homes', OTHER_ID);
    await mkdir(foreign);
    await writeFile(join(foreign, 'owner-file'), 'keep');
    const r = record(OTHER_ID);
    await expect(store.ensure(r)).rejects.toMatchObject(refused);
    expect(await readFile(join(foreign, 'owner-file'), 'utf8')).toBe('keep');
  });

  it('removes one home without following a link inside it', async () => {
    const outside = await mkdtemp(join(tmpdir(), 'nexar-codex-outside-'));
    try {
      await writeFile(join(outside, 'sentinel'), 'keep');
      const home = await store.ensure(record());
      const other = await store.ensure(record(OTHER_ID, '22222222-2222-4222-8222-222222222222'));
      await writeFile(join(home, 'state.json'), '{}');
      await linkDir(outside, join(home, 'escape'));
      await store.remove(record());
      expect(() => lstatSync(join(userData, 'runtime-homes', ID))).toThrow();
      expect(await readFile(join(outside, 'sentinel'), 'utf8')).toBe('keep');
      expect(lstatSync(other).isDirectory()).toBe(true);
      await expect(store.remove(record())).resolves.toBeUndefined();
    } finally {
      await rm(outside, { recursive: true, force: true });
    }
  });

  it('finishes an interrupted removal, leaving nothing of the old home', async () => {
    const root = join(userData, 'runtime-homes');
    await store.ensure(record());
    const doomed = join(root, `.deleting-${ID}`);
    await mkdir(join(doomed, 'codex'), { recursive: true });
    await writeFile(join(doomed, 'codex', 'state.json'), '{}');
    await store.remove(record());
    expect(() => lstatSync(doomed)).toThrow();
    expect(() => lstatSync(join(root, ID))).toThrow();

    await mkdir(join(doomed, 'codex'), { recursive: true });
    const home = await store.ensure(record());
    expect(() => lstatSync(doomed)).toThrow();
    expect(lstatSync(home).isDirectory()).toBe(true);
  });

  it('secures the directory again when retrying an interrupted creation', async () => {
    const secured: string[] = [];
    const retrying = new CodexHomeStore({
      userData,
      secureDirectory: async (path) => {
        secured.push(path);
        await mkdir(path, { recursive: true });
      },
    });
    await mkdir(join(userData, 'runtime-homes', ID), { recursive: true });
    await retrying.ensure(record());
    expect(secured).toEqual([join(userData, 'runtime-homes', ID)]);
    await retrying.ensure(record());
    expect(secured).toHaveLength(1);
  });

  it('reports a filesystem failure without a path', async () => {
    const failing = new CodexHomeStore({
      userData,
      secureDirectory: () => Promise.reject(new Error(`EACCES: ${userData}`)),
    });
    const error = await failing.ensure(record()).catch((caught: unknown) => caught);
    expect(error).toMatchObject(refused);
    expect((error as Error).message).not.toContain(userData);
  });

  it('recreates a removed home with the same marker', async () => {
    const home = await store.ensure(record());
    await store.remove(record());
    expect(await store.ensure(record())).toBe(home);
  });

  it('never opens a file inside the home', async () => {
    const home = await store.ensure(record());
    // A directory named like a credential file would make any attempt to read it throw.
    await mkdir(join(home, 'auth.json'));
    await expect(store.resolve(record())).resolves.toBe(home);
  });
});
