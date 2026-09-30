import { mkdir, mkdtemp, realpath, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, sep } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { isNexarError } from '@nexar/contracts';
import { canonicalRoots, isWithin, resolveContainedPath } from './path-policy.js';

describe('isWithin', () => {
  it('accepts equal paths and descendants', () => {
    expect(isWithin('/a/b', '/a/b')).toBe(true);
    expect(isWithin('/a/b', '/a/b/c/d')).toBe(true);
    expect(isWithin('/', '/etc')).toBe(true);
  });

  it('rejects siblings, prefixes and parents', () => {
    expect(isWithin('/a/b', '/a/bc')).toBe(false);
    expect(isWithin('/a/b', '/a')).toBe(false);
    expect(isWithin('/a/b', '/x/y')).toBe(false);
  });

  it('accepts a child whose name merely starts with two dots', () => {
    expect(isWithin('/a/b', '/a/b/..hidden')).toBe(true);
  });
});

describe('resolveContainedPath', () => {
  let base: string; // canonical temp dir
  let root: string; // base/allowed
  let outside: string; // base/outside
  beforeEach(async () => {
    base = await realpath(await mkdtemp(join(tmpdir(), 'nexar-policy-')));
    root = join(base, 'allowed');
    outside = join(base, 'private-target');
    await mkdir(join(root, 'sub'), { recursive: true });
    await mkdir(outside);
    await writeFile(join(outside, 'secret.txt'), 'x');
    await writeFile(join(root, 'file.txt'), 'x');
  });
  afterEach(async () => {
    await rm(base, { recursive: true, force: true });
  });

  async function rejection(candidate: string, roots: string[] = [root]): Promise<Error> {
    const error = await resolveContainedPath(candidate, roots).then(
      () => undefined,
      (e: unknown) => e,
    );
    expect(isNexarError(error)).toBe(true);
    const nexarError = error as Error & { code: string; details?: Record<string, unknown> };
    expect(nexarError.code).toBe('POLICY_REJECTED');
    // The rejected path, its target and the temp base must never leak.
    const serialized = JSON.stringify({
      message: nexarError.message,
      details: nexarError.details,
      cause: (nexarError as { cause?: unknown }).cause,
    });
    expect(serialized).not.toContain(base);
    expect(serialized).not.toContain('private-target');
    return nexarError;
  }

  it('returns the canonical path for the root itself and descendants', async () => {
    expect(await resolveContainedPath(root, [root])).toBe(root);
    expect(await resolveContainedPath(join(root, 'sub'), [root])).toBe(join(root, 'sub'));
    expect(await resolveContainedPath(join(root, 'file.txt'), [root])).toBe(join(root, 'file.txt'));
  });

  it('resolves relative candidates against options.base', async () => {
    expect(await resolveContainedPath('sub', [root], { base: root })).toBe(join(root, 'sub'));
  });

  it('rejects the symlink attack: allowed/link -> outside', async () => {
    await symlink(outside, join(root, 'link'));
    await rejection(join(root, 'link'));
    await rejection(join(root, 'link', 'secret.txt'));
  });

  it('rejects `..` escapes and absolute outside paths', async () => {
    await rejection(join(root, '..', 'private-target'));
    await rejection(`${root}${sep}sub${sep}..${sep}..${sep}private-target`);
    await rejection(outside);
    await rejection('/');
  });

  it('rejects a sibling sharing the root name as a prefix', async () => {
    await mkdir(`${root}-evil`);
    await rejection(`${root}-evil`);
  });

  it('rejects nonexistent paths with the errno as reason', async () => {
    const error = await rejection(join(root, 'nope'));
    expect((error as { details?: { reason?: string } }).details?.reason).toBe('ENOENT');
  });

  it('rejects a dangling symlink', async () => {
    await symlink(join(base, 'does-not-exist'), join(root, 'dangling'));
    await rejection(join(root, 'dangling'));
  });

  it('rejects a symlink loop', async () => {
    await symlink(join(root, 'b'), join(root, 'a'));
    await symlink(join(root, 'a'), join(root, 'b'));
    const error = await rejection(join(root, 'a'));
    expect((error as { details?: { reason?: string } }).details?.reason).toBe('ELOOP');
  });

  it('allows a symlink inside the root that points inside the root', async () => {
    await symlink(join(root, 'sub'), join(root, 'inner'));
    expect(await resolveContainedPath(join(root, 'inner'), [root])).toBe(join(root, 'sub'));
  });

  it('accepts the union of several roots', async () => {
    expect(await resolveContainedPath(outside, [root, outside])).toBe(outside);
  });

  it('rejects everything when there are no allowed roots', async () => {
    await rejection(root, []);
  });
});

describe('canonicalRoots', () => {
  let base: string;
  beforeEach(async () => {
    base = await realpath(await mkdtemp(join(tmpdir(), 'nexar-roots-')));
  });
  afterEach(async () => {
    await rm(base, { recursive: true, force: true });
  });

  it('follows a symlinked root and returns its real path', async () => {
    const real = join(base, 'real');
    await mkdir(real);
    await symlink(real, join(base, 'link'));
    expect(await canonicalRoots([join(base, 'link')])).toEqual([real]);
  });

  it('fails with CONFIGURATION_ERROR naming the configured path', async () => {
    const missing = join(base, 'missing');
    const error = await canonicalRoots([missing]).then(
      () => undefined,
      (e: unknown) => e,
    );
    expect(isNexarError(error) && error.code).toBe('CONFIGURATION_ERROR');
    expect((error as Error).message).toContain(missing);
  });

  it('requires a directory', async () => {
    const file = join(base, 'f.txt');
    await writeFile(file, 'x');
    await expect(canonicalRoots([file])).rejects.toMatchObject({ code: 'CONFIGURATION_ERROR' });
  });
});
