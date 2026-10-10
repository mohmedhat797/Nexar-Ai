import { mkdir, mkdtemp, realpath, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DSH_PINNED_VERSION } from '@nexar/integration-deepseek-harness';
import { afterEach, describe, expect, it } from 'vitest';
import { dshLaunchForEntry, packagedDshEntry, resolveDshEntry } from './dsh-runtime-path.js';

const dirs: string[] = [];
afterEach(async () => {
  await Promise.all(
    dirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true, maxRetries: 5 })),
  );
});

interface Packaged {
  /** `process.resourcesPath` stand-in. */
  readonly dir: string;
  /** The canonical entry the manifest names. */
  readonly entry: string;
}

/** A resources directory with `dsh-runtime/runtime.json` and (unless `file` is false) the entry. */
async function resources(
  manifest: unknown,
  options: { readonly file?: boolean; readonly name?: string; readonly path?: string } = {},
): Promise<Packaged> {
  const dir = await realpath(await mkdtemp(join(tmpdir(), 'nexar-dsh-runtime-')));
  dirs.push(dir);
  const root = join(dir, 'dsh-runtime');
  const entryDir = join(root, 'node_modules', ...(options.name ?? '@scope/dsh').split('/'), 'lib');
  await mkdir(entryDir, { recursive: true });
  const entry = join(entryDir, 'bin.js');
  if (options.file !== false) await writeFile(entry, '// entry\n');
  if (manifest !== undefined) {
    await writeFile(join(root, 'runtime.json'), JSON.stringify(manifest));
  }
  return { dir, entry };
}

const valid = { package: '@scope/dsh', version: DSH_PINNED_VERSION };

describe('DeepSeek Harness runtime resolution', () => {
  it('prefers the test entry, then the settings entry, then the packaged runtime, then development', async () => {
    const { dir, entry } = await resources(valid);
    const sources = {
      settingsEntry: join(dir, 's.js'),
      resourcesPath: dir,
      devEntry: join(dir, 'd.js'),
    };
    expect(await resolveDshEntry({ ...sources, testEntry: join(dir, 't.js') })).toBe(
      join(dir, 't.js'),
    );
    expect(await resolveDshEntry(sources)).toBe(join(dir, 's.js'));
    expect(await resolveDshEntry({ resourcesPath: dir, devEntry: join(dir, 'd.js') })).toBe(entry);
    expect(await resolveDshEntry({ devEntry: join(dir, 'd.js') })).toBe(join(dir, 'd.js'));
    expect(await resolveDshEntry({})).toBeUndefined();
  });

  it('falls back to the development entry only when the packaged runtime is unusable', async () => {
    const { dir } = await resources({ ...valid, version: '0.0.1' });
    expect(await resolveDshEntry({ resourcesPath: dir, devEntry: join(dir, 'd.js') })).toBe(
      join(dir, 'd.js'),
    );
    expect(await resolveDshEntry({ resourcesPath: dir })).toBeUndefined();
  });

  it('reads the package, version and entry from runtime.json', async () => {
    const { dir, entry } = await resources(
      { package: 'dsh', version: DSH_PINNED_VERSION, entry: 'lib/bin.js' },
      { name: 'dsh' },
    );
    expect(await packagedDshEntry(dir)).toBe(entry);
  });

  it('defaults the entry to lib/bin.js', async () => {
    const { dir, entry } = await resources(valid);
    expect(await packagedDshEntry(dir)).toBe(entry);
  });

  it.each([
    ['a missing manifest', undefined],
    ['an unparseable manifest', '{ not json'],
    ['a non-object manifest', ['x']],
    ['a missing package', { version: DSH_PINNED_VERSION }],
    ['a missing version', { package: '@scope/dsh' }],
    ['a different version', { package: '@scope/dsh', version: '0.0.1' }],
    ['a traversing package', { ...valid, package: '../../evil' }],
    ['an absolute entry', { ...valid, entry: '/etc/x.js' }],
    ['a traversing entry', { ...valid, entry: '../../x.js' }],
    ['a non-js entry', { ...valid, entry: 'lib/bin.cmd' }],
    ['an entry that is missing', { ...valid, entry: 'lib/nope.js' }],
    ['an entry that is a directory', { ...valid, entry: 'lib' }],
  ])('refuses %s', async (_name, manifest) => {
    const { dir } = await resources(typeof manifest === 'string' ? undefined : manifest);
    if (typeof manifest === 'string') {
      await writeFile(join(dir, 'dsh-runtime', 'runtime.json'), manifest);
    }
    expect(await packagedDshEntry(dir)).toBeUndefined();
  });

  it('refuses a manifest whose entry file does not exist', async () => {
    const { dir } = await resources(valid, { file: false });
    expect(await packagedDshEntry(dir)).toBeUndefined();
  });

  it('refuses a missing runtime directory and a relative resources path', async () => {
    const dir = await realpath(await mkdtemp(join(tmpdir(), 'nexar-dsh-runtime-')));
    dirs.push(dir);
    expect(await packagedDshEntry(dir)).toBeUndefined();
    expect(await packagedDshEntry('resources')).toBeUndefined();
  });

  it('refuses an entry that is a link out of the runtime directory', async () => {
    const { dir, entry } = await resources(valid, { file: false });
    const outside = join(dir, 'outside.js');
    await writeFile(outside, '// outside\n');
    try {
      await symlink(outside, entry, 'file');
    } catch {
      return; // creating links needs a privilege some Windows hosts do not grant
    }
    expect(await packagedDshEntry(dir)).toBeUndefined();
  });

  it('refuses an entry reached through a linked directory', async () => {
    const { dir } = await resources(valid, { file: false });
    const outside = join(dir, 'outside');
    await mkdir(join(outside, 'lib'), { recursive: true });
    await writeFile(join(outside, 'lib', 'bin.js'), '// outside\n');
    const linked = join(dir, 'dsh-runtime', 'node_modules', '@scope', 'dsh');
    await rm(linked, { recursive: true, force: true });
    try {
      await symlink(outside, linked, 'junction');
    } catch {
      return;
    }
    expect(await packagedDshEntry(dir)).toBeUndefined();
  });

  it('launches a script as this executable in plain Node, never a shell', () => {
    const entry = join(tmpdir(), 'bin.js');
    expect(dshLaunchForEntry(entry)).toEqual({
      command: process.execPath,
      args: [entry],
      env: { ELECTRON_RUN_AS_NODE: '1' },
    });
    expect(dshLaunchForEntry('relative.js')).toBeUndefined();
    expect(dshLaunchForEntry(join(tmpdir(), 'dsh.cmd'))).toBeUndefined();
  });
});
