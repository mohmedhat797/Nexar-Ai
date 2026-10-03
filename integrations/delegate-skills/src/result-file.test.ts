import { mkdtemp, mkdir, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { readBoundedFile } from './result.js';

describe('untrusted relay result files', () => {
  let dir: string;
  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'nexar-relay-result-'));
  });
  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it('reads a bounded regular file and rejects missing, oversized and directory results', async () => {
    const path = join(dir, 'result.json');
    await writeFile(path, 'safe');
    expect(await readBoundedFile(path, 4)).toBe('safe');
    expect(await readBoundedFile(path, 3)).toBeUndefined();
    expect(await readBoundedFile(join(dir, 'missing'), 10)).toBeUndefined();
    await mkdir(join(dir, 'directory'));
    expect(await readBoundedFile(join(dir, 'directory'), 10)).toBeUndefined();
  });

  it('rejects file symlinks before reading their target', async (context) => {
    const target = join(dir, 'outside.json');
    const path = join(dir, 'result.json');
    await writeFile(target, 'secret');
    try {
      await symlink(target, path, 'file');
    } catch (error) {
      if (process.platform === 'win32' && (error as NodeJS.ErrnoException).code === 'EPERM') {
        context.skip(true, 'Windows file symlinks require Developer Mode or symlink privilege');
        return;
      }
      throw error;
    }
    expect(await readBoundedFile(path, 100)).toBeUndefined();
  });
});
