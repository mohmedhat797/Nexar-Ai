import { mkdir, mkdtemp, open, readFile, rename, rm, writeFile } from 'node:fs/promises';
import type * as FileSystem from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { FileSessionStore } from './store.js';

vi.mock('node:fs/promises', async (original) => {
  const actual = await original<typeof FileSystem>();
  return { ...actual, open: vi.fn(actual.open), rename: vi.fn(actual.rename) };
});

let root: string;
beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'nexar-lease-race-'));
});
afterEach(async () => {
  vi.mocked(open).mockReset();
  vi.mocked(rename).mockReset();
  await rm(root, { recursive: true, force: true });
});

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

function store(instanceId: string) {
  return new FileSessionStore(root, { instanceId, isProcessAlive: () => false });
}

describe('single-writer lease acquisition', () => {
  it('refuses a second writer while the first lease contents are not yet written', async () => {
    const entered = deferred();
    const release = deferred();
    const actual = (await vi.importActual<typeof FileSystem>('node:fs/promises')).open;
    vi.mocked(open).mockImplementation(async (...args) => {
      const handle = await actual(...args);
      if (String(args[0]) === join(root, '.lease') && args[1] === 'wx') {
        const write = handle.writeFile.bind(handle);
        handle.writeFile = async (...input) => {
          entered.resolve();
          await release.promise;
          return write(...input);
        };
      }
      return handle;
    });
    const first = store('first');
    const second = store('second');
    const acquiring = first.acquireLease();
    await entered.promise;
    try {
      await expect(second.acquireLease()).rejects.toMatchObject({ code: 'CONFLICT' });
      expect(second.holdsLease()).toBe(false);
    } finally {
      release.resolve();
      await acquiring;
    }
    expect(first.holdsLease()).toBe(true);
    expect(JSON.parse(await readFile(join(root, '.lease'), 'utf8'))).toMatchObject({
      instanceId: 'first',
    });
    await first.releaseLease();
  });

  it('serializes contenders replacing the same dead-process lease', async () => {
    await mkdir(root, { recursive: true });
    await writeFile(join(root, '.lease'), JSON.stringify({ instanceId: 'dead', pid: 12345 }));
    const entered = deferred();
    const release = deferred();
    const actual = (await vi.importActual<typeof FileSystem>('node:fs/promises')).rename;
    vi.mocked(rename).mockImplementationOnce(async (...args) => {
      entered.resolve();
      await release.promise;
      return actual(...args);
    });
    const first = store('first');
    const second = store('second');
    const acquiring = first.acquireLease();
    await entered.promise;
    try {
      await expect(second.acquireLease()).rejects.toMatchObject({ code: 'CONFLICT' });
      expect(second.holdsLease()).toBe(false);
    } finally {
      release.resolve();
      await acquiring;
    }
    expect(first.holdsLease()).toBe(true);
    expect(JSON.parse(await readFile(join(root, '.lease'), 'utf8'))).toMatchObject({
      instanceId: 'first',
    });
    await first.releaseLease();
  });

  it('fails closed on an abandoned acquisition claim without overwriting it', async () => {
    await writeFile(join(root, '.lease.claim'), 'synthetic abandoned claim');
    const first = store('first');
    await expect(first.acquireLease()).rejects.toMatchObject({ code: 'CONFLICT' });
    expect(first.holdsLease()).toBe(false);
    expect(await readFile(join(root, '.lease.claim'), 'utf8')).toBe('synthetic abandoned claim');
  });
});
