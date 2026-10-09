import { link, mkdir, mkdtemp, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { collectDrafts, openWorkerWorkspaceDir } from './artifacts.js';

let dir: string;
let outside: string;
beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'ow-drafts-'));
  outside = await mkdtemp(join(tmpdir(), 'ow-outside-'));
});
afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
  await rm(outside, { recursive: true, force: true });
});

describe('collectDrafts', () => {
  it('lists regular files with relative names, sorted', async () => {
    await mkdir(join(dir, 'sub'));
    await writeFile(join(dir, 'b.md'), 'bb');
    await writeFile(join(dir, 'a.md'), 'a');
    await writeFile(join(dir, 'sub', 'c.md'), 'ccc');
    const { files, skipped } = await collectDrafts(dir);
    expect(files.map((f) => [f.name, f.size])).toEqual([
      ['a.md', 1],
      ['b.md', 2],
      ['sub/c.md', 3],
    ]);
    expect(skipped).toBe(0);
  });

  it('returns nothing for a missing directory', async () => {
    expect(await collectDrafts(join(dir, 'nope'))).toEqual({ files: [], skipped: 0 });
  });

  it('refuses symbolic links to files and directories', async () => {
    await writeFile(join(outside, 'secret.txt'), 'x');
    await writeFile(join(dir, 'ok.md'), 'ok');
    let linked = true;
    try {
      await symlink(join(outside, 'secret.txt'), join(dir, 'file-link.md'), 'file');
      await symlink(outside, join(dir, 'dir-link'), 'junction');
    } catch {
      linked = false; // Windows without link privilege
    }
    const { files, skipped } = await collectDrafts(dir);
    expect(files.map((f) => f.name)).toEqual(['ok.md']);
    if (linked) expect(skipped).toBeGreaterThanOrEqual(1);
  });

  it('refuses hard links', async () => {
    await writeFile(join(outside, 'target.txt'), 'x');
    await link(join(outside, 'target.txt'), join(dir, 'hard.md'));
    await writeFile(join(dir, 'ok.md'), 'ok');
    const { files, skipped } = await collectDrafts(dir);
    expect(files.map((f) => f.name)).toEqual(['ok.md']);
    expect(skipped).toBe(1);
  });

  it('caps file count, file size and depth', async () => {
    for (const name of ['1', '2', '3']) await writeFile(join(dir, `${name}.md`), 'x');
    await writeFile(join(dir, 'big.md'), 'x'.repeat(11));
    expect((await collectDrafts(dir, { maxFiles: 2, maxBytes: 10 })).files).toHaveLength(2);
    const sized = await collectDrafts(dir, { maxBytes: 10 });
    expect(sized.files.map((f) => f.name)).toEqual(['1.md', '2.md', '3.md']);
    expect(sized.skipped).toBe(1);

    await mkdir(join(dir, 'a', 'b'), { recursive: true });
    await writeFile(join(dir, 'a', 'b', 'deep.md'), 'x');
    const shallow = await collectDrafts(dir, { maxDepth: 1, maxBytes: 10 });
    expect(shallow.files.map((f) => f.name)).not.toContain('a/b/deep.md');
  });

  it('skips tool-output, workers and hidden directories/files (unrelated files)', async () => {
    await mkdir(join(dir, 'tool-output'));
    await writeFile(join(dir, 'tool-output', '0011-read_file-content.txt'), 'log');
    await mkdir(join(dir, 'workers'));
    await writeFile(join(dir, 'workers', 'worker.md'), 'worker-data');
    await mkdir(join(dir, '.hidden-dir'));
    await writeFile(join(dir, '.hidden-dir', 'hidden.md'), 'hidden');
    await writeFile(join(dir, '.dotfile.md'), 'dot');
    await writeFile(join(dir, 'statement-of-work-live.md'), '# SOW');

    const { files, skipped } = await collectDrafts(dir);
    expect(files.map((f) => f.name)).toEqual(['statement-of-work-live.md']);
    expect(skipped).toBeGreaterThanOrEqual(4);
  });
});

describe('openWorkerWorkspaceDir', () => {
  it('resolves session workspace under scratchBase or homedir', () => {
    const ws = openWorkerWorkspaceDir('turn_123', { scratchBase: '/custom/base' });
    expect(ws.replace(/\\/g, '/')).toMatch(/\/custom\/base\/turn_123$/);

    const homeWs = openWorkerWorkspaceDir('turn_abc', { homedir: '/mock/home' });
    expect(homeWs.replace(/\\/g, '/')).toMatch(/\/mock\/home\/OpenWorker\/turn_abc$/);
  });

  it('rejects invalid session identifiers', () => {
    expect(() => openWorkerWorkspaceDir('')).toThrow(/Invalid/);
    expect(() => openWorkerWorkspaceDir('../escape')).toThrow(/Invalid/);
    expect(() => openWorkerWorkspaceDir('has space')).toThrow(/Invalid/);
  });
});
