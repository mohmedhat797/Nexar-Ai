import { mkdir, mkdtemp, realpath, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { isNexarError } from '@nexar/contracts';
import { validateHostPath, validateMounts, validateToolchainPaths } from './mounts.js';

let root: string;
let home: string;
let data: string;

beforeEach(async () => {
  root = await realpath(await mkdtemp(join(tmpdir(), 'nexar-mounts-')));
  home = join(root, 'home', 'me');
  data = join(root, 'data');
  await mkdir(home, { recursive: true });
  await mkdir(data, { recursive: true });
});
afterEach(async () => {
  await rm(root, { recursive: true, force: true });
});

async function expectRejected(promise: Promise<unknown>, secret: string): Promise<void> {
  const error = await promise.then(
    () => undefined,
    (e: unknown) => e,
  );
  expect(isNexarError(error)).toBe(true);
  expect((error as { code: string }).code).toBe('CONFIGURATION_ERROR');
  expect(JSON.stringify((error as { toJSON(): unknown }).toJSON())).not.toContain(secret);
  expect((error as Error).message).not.toContain(secret);
}

// These are Linux-plane credential mount paths (ADR-018), not native Windows mounts.
describe.skipIf(process.platform === 'win32')('validateHostPath', () => {
  it('returns the canonical path', async () => {
    await mkdir(join(data, 'real'));
    await symlink(join(data, 'real'), join(data, 'link'));
    expect(await validateHostPath(join(data, 'link'), 'm', { homeDir: home })).toBe(
      join(data, 'real'),
    );
  });

  it('rejects relative, missing, root, home and home ancestors', async () => {
    await expectRejected(validateHostPath('relative/x', 'm', { homeDir: home }), 'relative/x');
    await expectRejected(
      validateHostPath(join(data, 'nope-zzz'), 'm', { homeDir: home }),
      'nope-zzz',
    );
    await expectRejected(validateHostPath('/', 'm', { homeDir: home }), 'zzzz');
    await expectRejected(validateHostPath(home, 'm', { homeDir: home }), home);
    await expectRejected(validateHostPath(join(root, 'home'), 'm', { homeDir: home }), 'zzzz');
  });

  it('rejects a symlink that resolves to the home directory', async () => {
    await symlink(home, join(data, 'innocent-link'));
    await expectRejected(
      validateHostPath(join(data, 'innocent-link'), 'm', { homeDir: home }),
      'innocent-link',
    );
  });

  it('allows a path inside the home directory', async () => {
    const inside = join(home, 'proj');
    await mkdir(inside);
    expect(await validateHostPath(inside, 'm', { homeDir: home })).toBe(inside);
  });

  it('rejects denied credential segments, also via symlink', async () => {
    for (const name of ['.ssh', '.gnupg', '.aws', '.azure', '.kube', '.docker']) {
      await mkdir(join(home, name));
      await expectRejected(
        validateHostPath(join(home, name), 'm', { homeDir: join(root, 'other') }),
        name,
      );
    }
    for (const name of ['.netrc', '.git-credentials', 'docker.sock', 'containerd.sock']) {
      await writeFile(join(data, name), '');
      await expectRejected(validateHostPath(join(data, name), 'm', { homeDir: home }), name);
    }
    await mkdir(join(home, '.ssh', 'keys'), { recursive: true });
    await symlink(join(home, '.ssh', 'keys'), join(data, 'harmless'));
    await expectRejected(
      validateHostPath(join(data, 'harmless'), 'm', { homeDir: join(root, 'other') }),
      'harmless',
    );
  });

  it('rejects system locations', async () => {
    for (const path of ['/proc', '/sys', '/dev', '/etc', '/etc/ssl']) {
      await expectRejected(validateHostPath(path, 'm', { homeDir: home }), 'zzzz');
    }
  });
});

describe('validateMounts', () => {
  const mount = (sandboxPath: string, hostPath = '') => ({
    hostPath,
    sandboxPath,
    access: 'read-only' as const,
  });

  it('accepts valid mounts and uses canonical host paths', async () => {
    const [result] = await validateMounts([mount('/home/agent/.cred', data)], { homeDir: home });
    expect(result).toEqual({
      hostPath: data,
      sandboxPath: '/home/agent/.cred',
      access: 'read-only',
    });
    const [other] = await validateMounts([mount('/opt/nexar/tools', data)], { homeDir: home });
    expect(other?.sandboxPath).toBe('/opt/nexar/tools');
  });

  it('rejects bad sandbox paths', async () => {
    for (const path of [
      'home/agent/x',
      '/home/agent/../x',
      '/home/agent//x',
      '/home/agent/x/',
      '/home/agent',
      '/home',
      '/opt',
      '/',
      '/var/lib/x',
      '/sys/x',
      '/work',
      '/work/sub',
      '/run/nexar/x',
      '/tmp/x',
      '/proc/x',
      '/dev/x',
      '/usr/x',
      '/etc/x',
    ]) {
      await expectRejected(validateMounts([mount(path, data)], { homeDir: home }), 'zzzz');
    }
  });

  it('accepts mounts at a runtime-specific path outside the reserved locations', async () => {
    const [m] = await validateMounts([mount('/home/runtime/.config/token', data)], {
      homeDir: home,
    });
    expect(m?.sandboxPath).toBe('/home/runtime/.config/token');
  });

  it('rejects duplicate sandbox paths and does not echo host paths', async () => {
    await expectRejected(
      validateMounts([mount('/home/agent/a', data), mount('/home/agent/a', data)], {
        homeDir: home,
      }),
      data,
    );
    await expectRejected(
      validateMounts([mount('/home/agent/a', join(data, 'missing-dir'))], { homeDir: home }),
      'missing-dir',
    );
  });
});

describe('validateToolchainPaths', () => {
  it('accepts paths anywhere that pass the host rules, de-duplicated', async () => {
    const tool = join(data, 'node22');
    await mkdir(tool);
    expect(await validateToolchainPaths([tool, tool], { homeDir: home })).toEqual([tool]);
    await expectRejected(validateToolchainPaths([home], { homeDir: home }), 'zzzz');
  });
});
