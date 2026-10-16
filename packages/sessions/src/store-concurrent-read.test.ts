import { lstat, mkdtemp, rm } from 'node:fs/promises';
import type * as FileSystem from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { FileSessionStore } from './store.js';

vi.mock('node:fs/promises', async (original) => {
  const actual = await original<typeof FileSystem>();
  return { ...actual, lstat: vi.fn(actual.lstat) };
});

const roots: string[] = [];
afterEach(async () => {
  vi.mocked(lstat).mockClear();
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe('session reads during atomic replacement', () => {
  it.each(['get', 'list'] as const)(
    '%s shares the writer queue without weakening file checks',
    async (method) => {
      const root = await mkdtemp(join(tmpdir(), 'nexar-session-read-'));
      roots.push(root);
      const store = new FileSessionStore(root);
      await store.acquireLease();
      const session = await store.create({
        projectId: 'synthetic',
        mode: 'cowork',
        title: 'Before',
      });
      let entered!: () => void;
      const inspected = new Promise<void>((resolve) => {
        entered = resolve;
      });
      let release!: () => void;
      const barrier = new Promise<void>((resolve) => {
        release = resolve;
      });
      const actual = (await vi.importActual<typeof FileSystem>('node:fs/promises')).lstat;
      vi.mocked(lstat)
        .mockImplementationOnce(actual)
        .mockImplementationOnce(async (...args) => {
          const result = await actual(...args);
          entered();
          await barrier;
          return result;
        });
      const reading = method === 'get' ? store.get(session.id) : store.list();
      // Observe a rejection too, so the deliberately blocked baseline cannot create an unhandled one.
      const observed = reading.then(
        (value) => ({ value }),
        (error: unknown) => ({ error }),
      );
      await inspected;
      let replaced = false;
      const writing = store.rename(session.id, 'After').then(() => {
        replaced = true;
      });
      try {
        await new Promise((resolve) => setTimeout(resolve, 50));
        expect(replaced).toBe(false);
      } finally {
        release();
        await writing;
      }
      const outcome = await observed;
      expect(outcome).not.toHaveProperty('error');
      if ('value' in outcome) {
        expect(
          method === 'get'
            ? outcome.value
            : Array.isArray(outcome.value)
              ? outcome.value[0]
              : undefined,
        ).toMatchObject({ title: 'Before' });
      }
      expect(await store.get(session.id)).toMatchObject({
        title: 'After',
        revision: session.revision + 1,
      });
      await store.releaseLease();
    },
  );
});
