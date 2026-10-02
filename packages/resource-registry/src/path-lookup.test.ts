import { chmod, mkdir, mkdtemp, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, posix } from 'node:path';
import { adapterId, resourceId, type ResourceDescriptor } from '@nexar/contracts';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { cliDiscoverySource, isBinaryOnPath, type FileStatLike } from './path-lookup.js';

const descriptor: ResourceDescriptor = {
  id: resourceId('tool'),
  displayName: 'Tool',
  kind: { type: 'agent', agent: 'tool', interface: 'cli' },
  capabilities: ['coding'],
  runtime: { adapter: adapterId('tool'), locality: 'local' },
  auth: {
    mode: 'subscription',
    credential: { source: 'runtime-managed', description: 'tool login' },
  },
  cost: { model: 'subscription' },
  dataLocality: 'third-party',
};

describe('isBinaryOnPath (POSIX)', () => {
  let dir: string;
  let modes: Map<string, number>;
  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'nexar-path-'));
    modes = new Map();
  });
  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  // A script that would leave a marker if anything ever ran it.
  async function script(name: string, mode: number): Promise<string> {
    const path = join(dir, name);
    await writeFile(path, `#!/bin/sh\ntouch "${join(dir, 'RAN')}"\n`);
    await chmod(path, mode);
    modes.set(name, mode);
    return path;
  }

  // Exercise POSIX PATH semantics on either host; Windows chmod has no executable bit.
  const posixStat = async (path: string): Promise<FileStatLike> => {
    if (posix.dirname(path) !== '/tools') throw new Error('ENOENT');
    const name = posix.basename(path);
    const info = await stat(join(dir, name));
    return { isFile: () => info.isFile(), mode: modes.get(name) ?? info.mode };
  };

  it('finds an executable regular file and never runs it', async () => {
    await script('codex', 0o755);
    const env = { PATH: '/nonexistent:/tools' };
    expect(await isBinaryOnPath('codex', { env, platform: 'linux', stat: posixStat })).toBe(true);
    const found = await cliDiscoverySource({
      id: 'cli:codex',
      binary: 'codex',
      build: () => descriptor,
      env,
      platform: 'linux',
      stat: posixStat,
    }).discover({ now: new Date(), signal: AbortSignal.timeout(1000) });
    expect(found).toEqual([descriptor]);
    // The descriptor carries nothing about where the binary was found.
    expect(JSON.stringify(found)).not.toContain(dir);
    await expect(writeFile(join(dir, 'RAN'), '', { flag: 'wx' })).resolves.toBeUndefined();
  });

  it('ignores a missing binary, a non-executable file and a directory of the same name', async () => {
    await script('plain', 0o644);
    await mkdir(join(dir, 'folder'));
    const env = { PATH: '/tools' };
    expect(await isBinaryOnPath('missing', { env, platform: 'linux', stat: posixStat })).toBe(
      false,
    );
    expect(await isBinaryOnPath('plain', { env, platform: 'linux', stat: posixStat })).toBe(false);
    expect(await isBinaryOnPath('folder', { env, platform: 'linux', stat: posixStat })).toBe(false);
  });

  it('returns false without PATH', async () => {
    expect(await isBinaryOnPath('sh', { env: {}, platform: 'linux' })).toBe(false);
    expect(await isBinaryOnPath('sh', { env: { PATH: '' }, platform: 'linux' })).toBe(false);
  });
});

describe('isBinaryOnPath (Windows)', () => {
  function fakeStat(files: readonly string[]) {
    const seen: string[] = [];
    const stat = (path: string): Promise<FileStatLike> => {
      seen.push(path);
      return files.includes(path)
        ? Promise.resolve({ isFile: () => true, mode: 0 })
        : Promise.reject(new Error('ENOENT'));
    };
    return { stat, seen };
  }

  it('honours PATHEXT, a case-insensitive Path variable and quoted entries', async () => {
    const { stat, seen } = fakeStat(['C:\\Tools\\codex.CMD']);
    const env = { Path: 'C:\\Windows;"C:\\Tools"', PATHEXT: '.EXE;.CMD' };
    expect(await isBinaryOnPath('codex', { env, platform: 'win32', stat })).toBe(true);
    expect(seen).toContain('C:\\Windows\\codex.EXE');
    // A bare name is never runnable on Windows.
    expect(seen).not.toContain('C:\\Tools\\codex');
  });

  it('uses the default PATHEXT when none is set', async () => {
    const { stat } = fakeStat(['C:\\bin\\agy.EXE']);
    expect(await isBinaryOnPath('agy', { env: { PATH: 'C:\\bin' }, platform: 'win32', stat })).toBe(
      true,
    );
  });

  it('does not require an executable bit on Windows', async () => {
    const { stat } = fakeStat(['C:\\bin\\dsh.EXE']);
    expect(
      await isBinaryOnPath('dsh', { env: { PATH: 'C:\\bin\\' }, platform: 'win32', stat }),
    ).toBe(true);
  });
});
