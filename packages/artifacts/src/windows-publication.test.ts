import * as fs from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { projectId, taskId } from '@nexar/contracts';
import { ProjectRegistry } from '@nexar/projects';
import { LocalArtifactStore } from './store.js';

vi.mock('node:fs/promises', async (importOriginal: () => Promise<typeof fs>) => {
  const actual = await importOriginal();
  return { ...actual, link: vi.fn(actual.link), open: vi.fn(actual.open) };
});

describe('Windows artifact publication', () => {
  const originalPlatform = process.platform;
  const platform = Object.getOwnPropertyDescriptor(process, 'platform');
  let dir: string;
  let root: string;
  let outside: string;
  let store: LocalArtifactStore;
  const input = {
    projectId: projectId('demo'),
    taskId: taskId('task'),
    filename: 'sow.md',
    content: 'artifact',
    mediaType: 'text/markdown',
  } as const;

  beforeEach(async () => {
    Object.defineProperty(process, 'platform', { value: 'win32', configurable: true });
    dir = await fs.realpath(await fs.mkdtemp(join(tmpdir(), 'nexar-artifact-publish-')));
    root = join(dir, 'work');
    outside = join(dir, 'outside');
    await fs.mkdir(root);
    await fs.mkdir(outside);
    const projects = await ProjectRegistry.create([
      { id: input.projectId, displayName: 'Demo', roots: [root] },
    ]);
    store = new LocalArtifactStore({ projects });
    vi.mocked(fs.link).mockClear();
    vi.mocked(fs.open).mockClear();
  });

  afterEach(async () => {
    if (platform !== undefined) Object.defineProperty(process, 'platform', platform);
    vi.restoreAllMocks();
    const actual = await vi.importActual<typeof fs>('node:fs/promises');
    vi.mocked(fs.link).mockReset().mockImplementation(actual.link);
    vi.mocked(fs.open).mockReset().mockImplementation(actual.open);
    await fs.rm(dir, { recursive: true, force: true });
  });

  it('refuses a destination link introduced during publication and leaves its target untouched', async () => {
    const actual = await vi.importActual<typeof fs>('node:fs/promises');
    const directory = join(root, '.nexar', 'artifacts', 'task');
    vi.mocked(fs.link).mockImplementation(async (source, destination) => {
      if (destination === join(directory, 'sow.md')) {
        // Fully written staging files still stay private until publication succeeds.
        expect(await store.list({ projectId: input.projectId, taskId: input.taskId })).toEqual([]);
        await fs.symlink(outside, destination, originalPlatform === 'win32' ? 'junction' : 'dir');
      }
      await actual.link(source, destination);
    });
    const ref = await store.store(input);
    expect(fileURLToPath(ref.uri)).toBe(join(directory, 'sow-2.md'));
    expect(await fs.readFile(fileURLToPath(ref.uri), 'utf8')).toBe('artifact');
    expect(await fs.readdir(outside)).toEqual([]);
    expect((await fs.lstat(join(directory, 'sow.md'))).isSymbolicLink()).toBe(true);
    expect((await fs.readdir(directory)).sort()).toEqual(['sow-2.md', 'sow.md']);
    expect(fs.open).not.toHaveBeenCalledWith(join(directory, 'sow.md'), 'wx', 0o600);
  });

  it('publishes .gitignore without opening an existing link at that name', async () => {
    const actual = await vi.importActual<typeof fs>('node:fs/promises');
    const ignore = join(root, '.nexar', '.gitignore');
    vi.mocked(fs.link).mockImplementation(async (source, destination) => {
      if (destination === ignore) {
        await fs.symlink(outside, destination, originalPlatform === 'win32' ? 'junction' : 'dir');
      }
      await actual.link(source, destination);
    });
    await store.store(input);
    expect((await fs.lstat(ignore)).isSymbolicLink()).toBe(true);
    expect(await fs.readdir(outside)).toEqual([]);
    expect(fs.open).not.toHaveBeenCalledWith(ignore, 'wx', 0o600);
    expect((await fs.readdir(join(root, '.nexar'))).sort()).toEqual(['.gitignore', 'artifacts']);
  });

  it('does not read an outside file when open follows a replaced entry', async () => {
    await store.store(input);
    const secret = join(outside, 'secret.md');
    await fs.writeFile(secret, 'secret');
    const actual = await vi.importActual<typeof fs>('node:fs/promises');
    const outsideHandle = await actual.open(secret, 'r');
    const read = vi.spyOn(outsideHandle, 'readFile');
    vi.mocked(fs.open).mockResolvedValueOnce(outsideHandle);
    expect(await store.list({ projectId: input.projectId, taskId: input.taskId })).toEqual([]);
    expect(read).not.toHaveBeenCalled();
  });

  it('skips a file that grows past the read limit between lstat and open', async () => {
    await store.store(input);
    const actual = await vi.importActual<typeof fs>('node:fs/promises');
    const read = vi.fn();
    vi.mocked(fs.open).mockImplementationOnce(async (path, flags) => {
      await fs.writeFile(path, new Uint8Array(5 * 1024 * 1024 + 1));
      const handle = await actual.open(path, flags);
      vi.spyOn(handle, 'readFile').mockImplementation(() => {
        read();
        return Promise.reject(new Error('oversized file must not be read'));
      });
      return handle;
    });
    expect(await store.list({ projectId: input.projectId, taskId: input.taskId })).toEqual([]);
    expect(read).not.toHaveBeenCalled();
  });
});
