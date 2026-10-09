import {
  link,
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  rm,
  stat,
  symlink,
  writeFile,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { MAX_REQUIRED_CONTEXT_CHARS, renderProjectMemory } from './render.js';
import { MAX_MEMORY_ENTRIES, MAX_MEMORY_TEXT_CHARS } from './types.js';
import { FileProjectMemoryStore } from './store.js';

let root: string;
let writer: boolean;

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'nexar-project-memory-'));
  writer = true;
});

afterEach(async () => {
  await rm(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 });
});

function makeStore(): FileProjectMemoryStore {
  let n = 0;
  return new FileProjectMemoryStore({
    stateDir: root,
    isWriter: () => writer,
    newId: () => {
      n += 1;
      return n.toString(16).padStart(32, '0');
    },
    clock: () => new Date('2026-10-02T10:00:00.000Z'),
  });
}

const dirOf = (): string => join(root, 'project-memory');
const fileOf = (projectId: string): string => join(dirOf(), `${projectId}.json`);

async function canMakeSymlink(): Promise<boolean> {
  try {
    await mkdir(join(root, 'probe-target'));
    await symlink(join(root, 'probe-target'), join(root, 'probe-link'), 'junction');
    return true;
  } catch {
    return false;
  }
}

describe('FileProjectMemoryStore', () => {
  it('lists nothing for a project without a file', async () => {
    await expect(makeStore().list('proj-1')).resolves.toEqual([]);
  });

  it('adds, lists and removes entries', async () => {
    const store = makeStore();
    const a = await store.add('proj-1', { kind: 'constraint', text: '  never push  ' });
    const b = await store.add('proj-1', {
      kind: 'decision',
      text: 'line one\nline two',
      sessionId: `ses_${'a'.repeat(32)}`,
      turnId: `turn_${'b'.repeat(32)}`,
    });
    expect(a).toEqual({
      id: `mem_${'1'.padStart(32, '0')}`,
      kind: 'constraint',
      text: 'never push',
      createdAt: '2026-10-02T10:00:00.000Z',
      source: 'owner',
    });
    expect(b).toMatchObject({
      sessionId: `ses_${'a'.repeat(32)}`,
      turnId: `turn_${'b'.repeat(32)}`,
    });
    expect(await store.list('proj-1')).toEqual([a, b]);
    expect(await store.list('proj-2')).toEqual([]);

    await store.remove('proj-1', a.id);
    expect(await store.list('proj-1')).toEqual([b]);
    await store.remove('proj-1', a.id); // unknown id is a no-op
    expect(await store.list('proj-1')).toEqual([b]);

    const record = JSON.parse(await readFile(fileOf('proj-1'), 'utf8')) as { revision: number };
    expect(record.revision).toBe(3);
  });

  it('is idempotent for the same kind and text, and keeps the revision', async () => {
    const store = makeStore();
    const first = await store.add('proj-1', { kind: 'constraint', text: 'same' });
    const again = await store.add('proj-1', { kind: 'constraint', text: ' same ' });
    expect(again).toEqual(first);
    const other = await store.add('proj-1', { kind: 'decision', text: 'same' });
    expect(other.id).not.toBe(first.id);
    expect((await store.list('proj-1')).length).toBe(2);
    const record = JSON.parse(await readFile(fileOf('proj-1'), 'utf8')) as { revision: number };
    expect(record.revision).toBe(2);
  });

  it('checks the expected revision', async () => {
    const store = makeStore();
    await store.add('proj-1', { kind: 'constraint', text: 'a' }, 0);
    await expect(store.add('proj-1', { kind: 'constraint', text: 'b' }, 0)).rejects.toMatchObject({
      code: 'CONFLICT',
      details: { reason: 'stale-revision', revision: 1 },
    });
  });

  it('serializes concurrent adds for one project', async () => {
    const store = makeStore();
    await Promise.all(
      Array.from({ length: 20 }, (_, i) =>
        store.add('proj-1', { kind: 'requirement', text: `entry ${String(i)}` }),
      ),
    );
    const entries = await store.list('proj-1');
    expect(entries).toHaveLength(20);
    expect(new Set(entries.map((e) => e.id)).size).toBe(20);
  });

  describe('bounds', () => {
    it('rejects bad text', async () => {
      const store = makeStore();
      for (const text of [
        '',
        '   ',
        'x'.repeat(MAX_MEMORY_TEXT_CHARS + 1),
        'a\u0000b',
        'a\tb',
        'a\rb',
      ]) {
        await expect(store.add('proj-1', { kind: 'constraint', text })).rejects.toMatchObject({
          code: 'VALIDATION_ERROR',
        });
      }
      await expect(
        store.add('proj-1', { kind: 'constraint', text: 'x'.repeat(MAX_MEMORY_TEXT_CHARS) }),
      ).resolves.toBeDefined();
      await expect(
        store.add('proj-1', { kind: 'nope' as never, text: 'ok' }),
      ).rejects.toMatchObject({ code: 'VALIDATION_ERROR' });
      await expect(
        store.add('proj-1', { kind: 'decision', text: 'ok', sessionId: 'bad' }),
      ).rejects.toMatchObject({ code: 'VALIDATION_ERROR' });
      await expect(
        store.add('proj-1', { kind: 'decision', text: 'ok', turnId: 'bad' }),
      ).rejects.toMatchObject({ code: 'VALIDATION_ERROR' });
    });

    it('rejects the 257th entry', async () => {
      const store = makeStore();
      for (let i = 0; i < MAX_MEMORY_ENTRIES; i += 1) {
        await store.add('proj-1', { kind: 'pending-work', text: `item ${String(i)}` });
      }
      await expect(
        store.add('proj-1', { kind: 'pending-work', text: 'one too many' }),
      ).rejects.toMatchObject({ code: 'POLICY_REJECTED', details: { reason: 'memory-full' } });
      expect(await store.list('proj-1')).toHaveLength(MAX_MEMORY_ENTRIES);
    }, 60_000);
  });

  describe('project ids and entry ids', () => {
    it('rejects anything but a valid project id', async () => {
      const store = makeStore();
      for (const id of ['', '..', '../x', 'a/b', 'a\\b', 'A', '.hidden', 'x'.repeat(129), 'a b']) {
        await expect(store.list(id)).rejects.toMatchObject({ code: 'VALIDATION_ERROR' });
        await expect(store.add(id, { kind: 'constraint', text: 'x' })).rejects.toMatchObject({
          code: 'VALIDATION_ERROR',
        });
      }
      await expect(store.remove('proj-1', 'not-an-id')).rejects.toMatchObject({
        code: 'VALIDATION_ERROR',
      });
    });

    it('keeps colons and device names out of file names', async () => {
      const store = makeStore();
      await store.add('a:b', { kind: 'constraint', text: 'x' });
      await store.add('con', { kind: 'constraint', text: 'y' });
      const names = (await readdir(dirOf())).sort();
      expect(names).toEqual(['_con.json', 'a%3ab.json']);
      expect(await store.list('a:b')).toHaveLength(1);
      expect(await store.list('con')).toHaveLength(1);
    });
  });

  describe('single writer', () => {
    it('refuses mutations without the lease, but still reads', async () => {
      const store = makeStore();
      const entry = await store.add('proj-1', { kind: 'constraint', text: 'x' });
      writer = false;
      await expect(store.add('proj-1', { kind: 'constraint', text: 'y' })).rejects.toMatchObject({
        code: 'CONFLICT',
        details: { reason: 'not-writer' },
      });
      await expect(store.remove('proj-1', entry.id)).rejects.toMatchObject({
        code: 'CONFLICT',
        details: { reason: 'not-writer' },
      });
      expect(await store.list('proj-1')).toEqual([entry]);
    });
  });

  describe('corrupt files', () => {
    const cases: Record<string, string> = {
      'not json': '{nope',
      'wrong shape': JSON.stringify({ schemaVersion: 1, projectId: 'proj-1', revision: 0 }),
      'extra key': JSON.stringify({
        schemaVersion: 1,
        projectId: 'proj-1',
        revision: 0,
        entries: [],
        extra: true,
      }),
      'other project': JSON.stringify({
        schemaVersion: 1,
        projectId: 'proj-2',
        revision: 0,
        entries: [],
      }),
      'prototype key':
        '{"schemaVersion":1,"projectId":"proj-1","revision":0,"entries":[],"__proto__":{}}',
      'bad entry': JSON.stringify({
        schemaVersion: 1,
        projectId: 'proj-1',
        revision: 1,
        entries: [{ id: 'x', kind: 'constraint', text: 'a', createdAt: 'now', source: 'owner' }],
      }),
    };

    for (const [name, content] of Object.entries(cases)) {
      it(`fails closed and leaves the file untouched: ${name}`, async () => {
        await mkdir(dirOf(), { recursive: true });
        await writeFile(fileOf('proj-1'), content);
        const store = makeStore();
        await expect(store.list('proj-1')).rejects.toMatchObject({ code: 'VALIDATION_ERROR' });
        await expect(store.add('proj-1', { kind: 'constraint', text: 'x' })).rejects.toMatchObject({
          code: 'VALIDATION_ERROR',
        });
        await expect(store.remove('proj-1', `mem_${'1'.repeat(32)}`)).rejects.toMatchObject({
          code: 'VALIDATION_ERROR',
        });
        expect(await readFile(fileOf('proj-1'), 'utf8')).toBe(content);
      });
    }

    it('rejects an oversized file', async () => {
      await mkdir(dirOf(), { recursive: true });
      await writeFile(fileOf('proj-1'), 'x'.repeat(1024 * 1024 + 1));
      await expect(makeStore().list('proj-1')).rejects.toMatchObject({ code: 'VALIDATION_ERROR' });
    });

    it('never puts paths or content in errors', async () => {
      await mkdir(dirOf(), { recursive: true });
      await writeFile(fileOf('proj-1'), '{secret-content');
      const error = await makeStore()
        .list('proj-1')
        .catch((e: unknown) => e as Error);
      expect(JSON.stringify(error) + (error as Error).message).not.toContain(root);
      expect(JSON.stringify(error) + (error as Error).message).not.toContain('secret-content');
    });
  });

  describe('links', () => {
    it('refuses a symlinked record file', async () => {
      if (!(await canMakeSymlink())) return;
      const store = makeStore();
      await mkdir(dirOf(), { recursive: true });
      await writeFile(join(root, 'target.json'), '{"schemaVersion":1}');
      try {
        await symlink(join(root, 'target.json'), fileOf('proj-1'), 'file');
      } catch {
        return;
      }
      await expect(store.list('proj-1')).rejects.toMatchObject({ code: 'VALIDATION_ERROR' });
    });

    it('refuses a hard-linked record file', async () => {
      const store = makeStore();
      await store.add('proj-1', { kind: 'constraint', text: 'x' });
      try {
        await link(fileOf('proj-1'), join(root, 'alias.json'));
      } catch {
        return;
      }
      await expect(store.list('proj-1')).rejects.toMatchObject({ code: 'VALIDATION_ERROR' });
    });

    it('refuses a symlinked or junctioned directory', async () => {
      if (!(await canMakeSymlink())) return;
      await mkdir(join(root, 'elsewhere'));
      await symlink(join(root, 'elsewhere'), dirOf(), 'junction');
      const store = makeStore();
      await expect(store.list('proj-1')).rejects.toMatchObject({ code: 'POLICY_REJECTED' });
      await expect(store.add('proj-1', { kind: 'constraint', text: 'x' })).rejects.toMatchObject({
        code: 'POLICY_REJECTED',
      });
      expect(await readdir(join(root, 'elsewhere'))).toEqual([]);
    });
  });

  describe.skipIf(process.platform === 'win32')('permissions', () => {
    it('uses 0700 for the directory and 0600 for the file, and leaves no temp files', async () => {
      const store = makeStore();
      await store.add('proj-1', { kind: 'constraint', text: 'x' });
      expect((await stat(dirOf())).mode & 0o777).toBe(0o700);
      expect((await stat(fileOf('proj-1'))).mode & 0o777).toBe(0o600);
      expect(await readdir(dirOf())).toEqual(['proj-1.json']);
    });
  });
});

describe('FileProjectMemoryStore required-context budget', () => {
  const full = (i: number): string => String(i).padEnd(MAX_MEMORY_TEXT_CHARS, 'x');

  async function fill(store: FileProjectMemoryStore): Promise<void> {
    for (let i = 0; i < 15; i += 1)
      await store.add('proj-1', { kind: 'constraint', text: full(i) });
  }

  it('refuses the add that would make the block unrenderable and writes nothing', async () => {
    const store = makeStore();
    await fill(store);
    const before = await readFile(fileOf('proj-1'), 'utf8');
    await expect(store.add('proj-1', { kind: 'constraint', text: full(99) })).rejects.toMatchObject(
      {
        code: 'POLICY_REJECTED',
        details: { reason: 'required-context-budget' },
      },
    );
    expect(await readFile(fileOf('proj-1'), 'utf8')).toBe(before);
    expect((JSON.parse(before) as { revision: number }).revision).toBe(15);
    expect(await store.list('proj-1')).toHaveLength(15);
    const names = await readdir(dirOf());
    expect(names.filter((n) => n.endsWith('.tmp'))).toEqual([]);
  });

  it('accepts an add that lands exactly at the cap, and refuses one char more', async () => {
    const store = makeStore();
    await fill(store);
    const used = renderProjectMemory(await store.list('proj-1')).block.length;
    const room = MAX_REQUIRED_CONTEXT_CHARS - used - '\n- [constraint] '.length;
    await store.add('proj-1', { kind: 'constraint', text: 'y'.repeat(room) });
    const entries = await store.list('proj-1');
    expect(renderProjectMemory(entries).block.length).toBe(MAX_REQUIRED_CONTEXT_CHARS);
    await expect(store.add('proj-1', { kind: 'constraint', text: 'z' })).rejects.toMatchObject({
      details: { reason: 'required-context-budget' },
    });
  });

  it('keeps the idempotent duplicate path ahead of the budget check', async () => {
    const store = makeStore();
    await fill(store);
    const used = renderProjectMemory(await store.list('proj-1')).block.length;
    const room = MAX_REQUIRED_CONTEXT_CHARS - used - '\n- [constraint] '.length;
    const last = await store.add('proj-1', { kind: 'constraint', text: 'y'.repeat(room) });
    await expect(
      store.add('proj-1', { kind: 'constraint', text: 'y'.repeat(room) }),
    ).resolves.toEqual(last);
  });

  it('lets an entry be removed to make room again', async () => {
    const store = makeStore();
    await fill(store);
    const entries = await store.list('proj-1');
    await expect(store.add('proj-1', { kind: 'decision', text: full(99) })).rejects.toMatchObject({
      details: { reason: 'required-context-budget' },
    });
    await store.remove('proj-1', entries[0]?.id ?? '');
    await expect(store.add('proj-1', { kind: 'decision', text: full(99) })).resolves.toBeDefined();
  });
});
