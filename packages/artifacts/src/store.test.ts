import { createHash } from 'node:crypto';
import {
  lstat,
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  realpath,
  rm,
  stat,
  symlink,
  writeFile,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { projectId, taskId, type NexarError } from '@nexar/contracts';
import { ProjectRegistry } from '@nexar/projects';
import { LocalArtifactStore, type StoreArtifactInput } from './store.js';

const PID = projectId('demo');
const TID = taskId('task:abc/../123');

describe('LocalArtifactStore', () => {
  let dir: string;
  let root: string;
  let outside: string;

  beforeEach(async () => {
    dir = await realpath(await mkdtemp(join(tmpdir(), 'nexar-artifacts-')));
    root = join(dir, 'work');
    outside = join(dir, 'outside');
    await mkdir(root);
    await mkdir(outside);
  });
  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  async function makeStore(artifactsDirectory?: string, maxBytes?: number) {
    const projects = await ProjectRegistry.create([
      {
        id: PID,
        displayName: 'Demo',
        roots: [root],
        ...(artifactsDirectory === undefined ? {} : { artifactsDirectory }),
      },
    ]);
    return new LocalArtifactStore({ projects, ...(maxBytes === undefined ? {} : { maxBytes }) });
  }

  const input = (over: Partial<StoreArtifactInput> = {}): StoreArtifactInput => ({
    projectId: PID,
    taskId: TID,
    filename: 'sow.md',
    content: '# SOW\n',
    mediaType: 'text/markdown',
    ...over,
  });

  const taskDir = join('.nexar', 'artifacts', 'task-abc-..-123');
  const mode = async (p: string): Promise<number> => (await stat(p)).mode & 0o777;

  it('stores a file with sha256, size, a file: uri and restrictive permissions', async () => {
    const store = await makeStore();
    const ref = await store.store(input({ label: 'Statement of work' }));
    const path = join(root, taskDir, 'sow.md');
    expect(fileURLToPath(ref.uri)).toBe(path);
    expect(ref).toMatchObject({
      label: 'Statement of work',
      mediaType: 'text/markdown',
      sizeBytes: 6,
      draft: false,
      sha256: createHash('sha256').update('# SOW\n').digest('hex'),
    });
    expect(await readFile(path, 'utf8')).toBe('# SOW\n');
    expect(await mode(path)).toBe(0o600);
    for (const d of ['.nexar', join('.nexar', 'artifacts'), taskDir]) {
      expect(await mode(join(root, d))).toBe(0o700);
    }
  });

  it('labels with the project-relative path by default and accepts bytes', async () => {
    const store = await makeStore();
    const ref = await store.store(input({ content: new Uint8Array([104, 105]) }));
    expect(ref.label).toBe(join(taskDir, 'sow.md'));
    expect(ref.sizeBytes).toBe(2);
  });

  it('sanitizes hostile file names', async () => {
    const store = await makeStore();
    const ref = await store.store(input({ filename: '../../../etc/cron.d/evil.sh' }));
    expect(fileURLToPath(ref.uri)).toBe(join(root, taskDir, 'evil.md'));
  });

  it('creates .nexar/.gitignore once and never overwrites an existing one', async () => {
    const store = await makeStore();
    await store.store(input());
    const ignore = join(root, '.nexar', '.gitignore');
    expect(await readFile(ignore, 'utf8')).toBe('*\n');
    expect(await mode(ignore)).toBe(0o600);

    await rm(join(root, '.nexar'), { recursive: true });
    await mkdir(join(root, '.nexar'));
    await writeFile(ignore, 'custom\n');
    await store.store(input());
    expect(await readFile(ignore, 'utf8')).toBe('custom\n');
  });

  it('adds the .gitignore to a pre-existing .nexar directory that lacks one', async () => {
    await mkdir(join(root, '.nexar'));
    const store = await makeStore();
    await store.store(input());
    expect(await readFile(join(root, '.nexar', '.gitignore'), 'utf8')).toBe('*\n');
  });

  it('never overwrites: collisions get -2, -3 suffixes', async () => {
    const store = await makeStore();
    const first = await store.store(input({ content: 'one' }));
    const second = await store.store(input({ content: 'two' }));
    const third = await store.store(input({ content: 'three' }));
    expect(fileURLToPath(second.uri)).toBe(join(root, taskDir, 'sow-2.md'));
    expect(fileURLToPath(third.uri)).toBe(join(root, taskDir, 'sow-3.md'));
    expect(await readFile(fileURLToPath(first.uri), 'utf8')).toBe('one');
    expect(await readFile(fileURLToPath(second.uri), 'utf8')).toBe('two');
  });

  it('fails after 99 names', async () => {
    const store = await makeStore();
    for (let i = 0; i < 99; i++) await store.store(input());
    await expect(store.store(input())).rejects.toMatchObject({ code: 'VALIDATION_ERROR' });
    expect(await readdir(join(root, taskDir))).toHaveLength(99);
  });

  it('does not follow a pre-existing symlink at the target name', async () => {
    const store = await makeStore();
    const target = join(outside, 'victim.txt');
    await writeFile(target, 'original');
    await mkdir(join(root, taskDir), { recursive: true });
    await symlink(target, join(root, taskDir, 'sow.md'));
    const ref = await store.store(input());
    expect(fileURLToPath(ref.uri)).toBe(join(root, taskDir, 'sow-2.md'));
    expect(await readFile(target, 'utf8')).toBe('original');
  });

  it('does not follow a dangling symlink at the target name', async () => {
    const store = await makeStore();
    const target = join(outside, 'not-yet');
    await mkdir(join(root, taskDir), { recursive: true });
    await symlink(target, join(root, taskDir, 'sow.md'));
    await store.store(input());
    await expect(lstat(target)).rejects.toMatchObject({ code: 'ENOENT' });
  });

  it('rejects a symlinked .nexar pointing outside and writes nothing there', async () => {
    await symlink(outside, join(root, '.nexar'));
    const store = await makeStore();
    await expect(store.store(input())).rejects.toMatchObject({ code: 'POLICY_REJECTED' });
    expect(await readdir(outside)).toEqual([]);
  });

  it('rejects a symlinked task directory pointing outside and writes nothing there', async () => {
    await mkdir(join(root, '.nexar', 'artifacts'), { recursive: true });
    await symlink(outside, join(root, taskDir));
    const store = await makeStore();
    await expect(store.store(input())).rejects.toMatchObject({ code: 'POLICY_REJECTED' });
    expect(await readdir(outside)).toEqual([]);
  });

  it('rejects a symlinked drafts directory pointing outside', async () => {
    await mkdir(join(root, taskDir), { recursive: true });
    await symlink(outside, join(root, taskDir, 'drafts'));
    const store = await makeStore();
    await expect(store.store(input({ draft: true }))).rejects.toMatchObject({
      code: 'POLICY_REJECTED',
    });
    expect(await readdir(outside)).toEqual([]);
  });

  it('rejects unknown projects', async () => {
    const store = await makeStore();
    await expect(store.store(input({ projectId: projectId('nope') }))).rejects.toMatchObject({
      code: 'POLICY_REJECTED',
    });
  });

  it('enforces the size limit and writes nothing', async () => {
    const store = await makeStore(undefined, 10);
    await expect(store.store(input({ content: 'x'.repeat(11) }))).rejects.toMatchObject({
      code: 'VALIDATION_ERROR',
    });
    await expect(lstat(join(root, '.nexar'))).rejects.toMatchObject({ code: 'ENOENT' });
    await store.store(input({ content: 'x'.repeat(10) }));
  });

  it('honours the default 5 MiB limit', async () => {
    const store = await makeStore();
    await expect(
      store.store(input({ content: new Uint8Array(5 * 1024 * 1024 + 1) })),
    ).rejects.toMatchObject({ code: 'VALIDATION_ERROR' });
  });

  it('stops when already aborted', async () => {
    const store = await makeStore();
    const controller = new AbortController();
    controller.abort();
    await expect(store.store(input(), controller.signal)).rejects.toMatchObject({
      code: 'EXECUTION_CANCELLED',
    });
  });

  describe('artifactsDirectory', () => {
    it('stores under a custom directory inside the root, without a .gitignore', async () => {
      const store = await makeStore('out/docs');
      const ref = await store.store(input());
      expect(fileURLToPath(ref.uri)).toBe(join(root, 'out', 'docs', 'task-abc-..-123', 'sow.md'));
      await expect(lstat(join(root, '.nexar'))).rejects.toMatchObject({ code: 'ENOENT' });
      await expect(lstat(join(root, 'out', '.gitignore'))).rejects.toMatchObject({
        code: 'ENOENT',
      });
    });

    it.each(['..', '../escape', 'a/../../escape', '/tmp/abs'])('rejects %s', async (bad) => {
      const store = await makeStore(bad);
      const error = (await store.store(input()).catch((e: unknown) => e)) as NexarError;
      expect(error.code).toBe('CONFIGURATION_ERROR');
      expect(await readdir(outside)).toEqual([]);
    });

    it('rejects a custom directory that is a symlink out of the root', async () => {
      await symlink(outside, join(root, 'out'));
      const store = await makeStore('out');
      await expect(store.store(input())).rejects.toMatchObject({ code: 'POLICY_REJECTED' });
      expect(await readdir(outside)).toEqual([]);
    });
  });

  describe('drafts', () => {
    it('stores drafts in a drafts/ subdirectory flagged draft', async () => {
      const store = await makeStore();
      const ref = await store.store(
        input({ draft: true, filename: 'email.txt', mediaType: 'text/plain' }),
      );
      expect(ref.draft).toBe(true);
      expect(fileURLToPath(ref.uri)).toBe(join(root, taskDir, 'drafts', 'email.txt'));
    });
  });

  describe('list', () => {
    it('returns [] when nothing was stored', async () => {
      const store = await makeStore();
      expect(await store.list({ projectId: PID, taskId: TID })).toEqual([]);
    });

    it('lists final and draft artifacts sorted by label with sha256 and size', async () => {
      const store = await makeStore();
      await store.store(input({ filename: 'b.md', content: 'bb' }));
      await store.store(
        input({ filename: 'a.json', mediaType: 'application/json', content: '{}' }),
      );
      await store.store(input({ filename: 'c.txt', mediaType: 'text/plain', draft: true }));
      const refs = await store.list({ projectId: PID, taskId: TID });
      expect(refs.map((r) => r.label)).toEqual([
        join(taskDir, 'a.json'),
        join(taskDir, 'b.md'),
        join(taskDir, 'drafts', 'c.txt'),
      ]);
      expect(refs.map((r) => r.draft)).toEqual([false, false, true]);
      expect(refs[1]).toMatchObject({
        mediaType: 'text/markdown',
        sizeBytes: 2,
        sha256: createHash('sha256').update('bb').digest('hex'),
      });
    });

    it('ignores symlinks, directories and other tasks', async () => {
      const store = await makeStore();
      await store.store(input());
      await store.store(input({ taskId: taskId('other') }));
      const secret = join(outside, 'secret.md');
      await writeFile(secret, 'secret');
      await symlink(secret, join(root, taskDir, 'link.md'));
      await mkdir(join(root, taskDir, 'subdir'));
      const refs = await store.list({ projectId: PID, taskId: TID });
      expect(refs.map((r) => r.label)).toEqual([join(taskDir, 'sow.md')]);
    });

    it('rejects a task directory symlinked outside the project', async () => {
      await mkdir(join(root, '.nexar', 'artifacts'), { recursive: true });
      await writeFile(join(outside, 'x.md'), 'x');
      await symlink(outside, join(root, taskDir));
      const store = await makeStore();
      await expect(store.list({ projectId: PID, taskId: TID })).rejects.toMatchObject({
        code: 'POLICY_REJECTED',
      });
    });

    it('rejects unknown projects', async () => {
      const store = await makeStore();
      await expect(store.list({ projectId: projectId('nope'), taskId: TID })).rejects.toMatchObject(
        { code: 'POLICY_REJECTED' },
      );
    });
  });
});
