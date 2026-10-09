import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { dshLaunchForEntry, packagedDshEntry, resolveDshEntry } from './dsh-runtime-path.js';

const dirs: string[] = [];
afterEach(async () => {
  await Promise.all(
    dirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true, maxRetries: 5 })),
  );
});

async function resources(manifest: unknown): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), 'nexar-dsh-runtime-'));
  dirs.push(dir);
  await mkdir(join(dir, 'dsh-runtime'), { recursive: true });
  if (manifest !== undefined) {
    await writeFile(join(dir, 'dsh-runtime', 'runtime.json'), JSON.stringify(manifest));
  }
  return dir;
}

describe('DeepSeek Harness runtime resolution', () => {
  it('prefers the test entry, then the settings entry, then the packaged runtime', async () => {
    const dir = await resources({ package: '@scope/dsh' });
    const packaged = join(dir, 'dsh-runtime', 'node_modules', '@scope', 'dsh', 'lib', 'bin.js');
    const sources = { settingsEntry: join(dir, 's.js'), resourcesPath: dir };
    expect(await resolveDshEntry({ ...sources, testEntry: join(dir, 't.js') })).toBe(
      join(dir, 't.js'),
    );
    expect(await resolveDshEntry(sources)).toBe(join(dir, 's.js'));
    expect(await resolveDshEntry({ resourcesPath: dir })).toBe(packaged);
    expect(await resolveDshEntry({})).toBeUndefined();
  });

  it('reads the package and entry from runtime.json', async () => {
    const dir = await resources({ package: 'dsh', entry: 'dist/cli.js' });
    expect(await packagedDshEntry(dir)).toBe(
      join(dir, 'dsh-runtime', 'node_modules', 'dsh', 'dist', 'cli.js'),
    );
  });

  it.each([
    ['a missing manifest', undefined],
    ['a non-object manifest', ['x']],
    ['a missing package', { entry: 'lib/bin.js' }],
    ['a traversing package', { package: '../../evil' }],
    ['an absolute entry', { package: 'dsh', entry: '/etc/x.js' }],
    ['a traversing entry', { package: 'dsh', entry: '../../x.js' }],
    ['a non-js entry', { package: 'dsh', entry: 'lib/bin.cmd' }],
  ])('refuses %s', async (_name, manifest) => {
    expect(await packagedDshEntry(await resources(manifest))).toBeUndefined();
  });

  it('refuses a relative resources path', async () => {
    expect(await packagedDshEntry('resources')).toBeUndefined();
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
