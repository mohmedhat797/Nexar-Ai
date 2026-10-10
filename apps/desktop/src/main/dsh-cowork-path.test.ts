import { link, mkdir, mkdtemp, realpath, rm, symlink, writeFile } from 'node:fs/promises';
import type * as FileSystem from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { isPhysicalScratchEscape } from './dsh-cowork.js';

vi.mock('node:fs/promises', async (original) => {
  const actual = await original<typeof FileSystem>();
  return { ...actual, realpath: vi.fn(actual.realpath) };
});

let base: string;
let root: string;
beforeEach(async () => {
  base = await mkdtemp(join(tmpdir(), 'nexar-containment-'));
  root = join(base, 'scratch');
  await mkdir(root);
});
afterEach(async () => {
  vi.mocked(realpath).mockClear();
  await rm(base, { recursive: true, force: true });
});

describe('Cowork physical path checks', () => {
  it('rejects a hard-linked existing target that aliases an outside file', async () => {
    const outside = join(base, 'outside.txt');
    await writeFile(outside, 'synthetic outside');
    await link(outside, join(root, 'alias.txt'));
    expect(await isPhysicalScratchEscape(root, 'alias.txt')).toBe(true);
  });
  it('fails closed on a permission-denied root lookup', async () => {
    vi.mocked(realpath).mockRejectedValueOnce(
      Object.assign(new Error('synthetic'), { code: 'EACCES' }),
    );
    expect(await isPhysicalScratchEscape(root, 'draft.md')).toBe(true);
  });

  it('fails closed on a permission-denied ancestor lookup', async () => {
    await mkdir(join(root, 'nested'));
    const actual = (await vi.importActual<typeof FileSystem>('node:fs/promises')).realpath;
    vi.mocked(realpath)
      .mockImplementationOnce(actual)
      .mockRejectedValueOnce(Object.assign(new Error('synthetic'), { code: 'EACCES' }));
    expect(await isPhysicalScratchEscape(root, 'nested/draft.md')).toBe(true);
  });

  it('rejects a scratch root replaced by a junction', async () => {
    const outside = join(base, 'outside');
    await mkdir(outside);
    await rm(root, { recursive: true });
    await symlink(outside, root, 'junction');
    expect(await isPhysicalScratchEscape(root, 'draft.md')).toBe(true);
  });

  it('rejects an invalid non-directory root', async () => {
    const file = join(base, 'file');
    await writeFile(file, 'synthetic');
    expect(await isPhysicalScratchEscape(file, 'draft.md')).toBe(true);
  });

  it('conservatively rejects internal directory links too', async () => {
    await mkdir(join(root, 'inner'));
    await symlink(join(root, 'inner'), join(root, 'alias'), 'junction');
    expect(await isPhysicalScratchEscape(root, 'alias/draft.md')).toBe(true);
  });

  it('allows a regular directory beginning with two dots', async () => {
    await mkdir(join(root, '..notes'));
    expect(await isPhysicalScratchEscape(root, '..notes/draft.md')).toBe(false);
  });

  it('remains independent under repeated concurrent checks', async () => {
    const outcomes = await Promise.all(
      Array.from({ length: 24 }, (_, i) => isPhysicalScratchEscape(root, `nested/${String(i)}.md`)),
    );
    expect(outcomes).toEqual(Array<boolean>(24).fill(false));
  });
});
