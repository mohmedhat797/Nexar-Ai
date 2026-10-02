import * as fs from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { FileApprovalStore, newApprovalId } from './store.js';
import type { ApprovalRequest } from './types.js';

vi.mock('node:fs/promises', async (importOriginal: () => Promise<typeof fs>) => {
  const actual = await importOriginal();
  return { ...actual, rename: vi.fn(actual.rename), unlink: vi.fn(actual.unlink) };
});

describe('FileApprovalStore atomic replacement on Windows', () => {
  let dir: string;
  let store: FileApprovalStore;
  let record: ApprovalRequest;
  const platform = Object.getOwnPropertyDescriptor(process, 'platform');

  beforeEach(async () => {
    // Exercise Windows retry policy on every CI platform with real filesystem writes.
    Object.defineProperty(process, 'platform', { value: 'win32', configurable: true });
    dir = await fs.mkdtemp(join(tmpdir(), 'nexar-approval-rename-'));
    store = new FileApprovalStore(dir);
    record = {
      id: newApprovalId(),
      createdAt: '2026-10-01T10:00:00.000Z',
      expiresAt: '2026-10-01T11:00:00.000Z',
      instanceId: 'gate-test',
      actionType: 'email.send',
      summary: 'Draft',
      risk: 'high',
      fingerprint: 'a'.repeat(64),
      status: 'approved',
    };
    await store.create(record);
    vi.mocked(fs.rename).mockClear();
    vi.mocked(fs.unlink).mockClear();
  });

  afterEach(async () => {
    if (platform !== undefined) Object.defineProperty(process, 'platform', platform);
    vi.restoreAllMocks();
    vi.mocked(fs.rename).mockReset();
    vi.mocked(fs.rename).mockImplementation(
      (await vi.importActual<typeof fs>('node:fs/promises')).rename,
    );
    vi.mocked(fs.unlink).mockReset();
    vi.mocked(fs.unlink).mockImplementation(
      (await vi.importActual<typeof fs>('node:fs/promises')).unlink,
    );
    await fs.rm(dir, { recursive: true, force: true });
  });

  it('retries a sharing violation without removing the old record and consumes once', async () => {
    vi.mocked(fs.rename).mockImplementationOnce(async () => {
      expect(JSON.parse(await fs.readFile(join(dir, `${record.id}.json`), 'utf8'))).toEqual(record);
      throw Object.assign(new Error('sharing violation'), { code: 'EPERM' });
    });
    await expect(store.transition(record.id, ['approved'], 'consumed', {})).resolves.toMatchObject({
      status: 'consumed',
    });
    expect(fs.rename).toHaveBeenCalledTimes(2);
    await expect(store.transition(record.id, ['approved'], 'consumed', {})).rejects.toMatchObject({
      code: 'APPROVAL_DENIED',
      details: { reason: 'already-consumed' },
    });
    expect(await fs.readdir(dir)).toEqual(
      expect.arrayContaining([`${record.id}.consumed`, `${record.id}.json`]),
    );
  });

  it('makes a concurrent reader wait until atomic replacement completes', async () => {
    let release = (): void => undefined;
    let enter = (): void => undefined;
    const blocked = new Promise<void>((resolve) => {
      release = resolve;
    });
    const entered = new Promise<void>((resolve) => {
      enter = resolve;
    });
    const actual = await vi.importActual<typeof fs>('node:fs/promises');
    vi.mocked(fs.rename).mockImplementationOnce(async (source, target) => {
      enter();
      await blocked;
      await actual.rename(source, target);
    });
    const transition = store.transition(record.id, ['approved'], 'consumed', {});
    await entered;
    let readFinished = false;
    const read = store.get(record.id).then((value) => {
      readFinished = true;
      return value;
    });
    try {
      await new Promise((resolve) => setTimeout(resolve, 30));
      expect(readFinished).toBe(false);
    } finally {
      release();
    }
    await transition;
    await expect(read).resolves.toMatchObject({ status: 'consumed' });
  });

  it('bounds retries and preserves the consumed marker when persistence fails', async () => {
    const error = Object.assign(new Error('sharing violation'), { code: 'EPERM' });
    let now = 0;
    let attempts = 0;
    vi.spyOn(Date, 'now').mockImplementation(() => now);
    vi.mocked(fs.rename).mockImplementation(() => {
      if (++attempts === 2) now = 1_000;
      return Promise.reject(error);
    });
    await expect(store.transition(record.id, ['approved'], 'consumed', {})).rejects.toBe(error);
    expect(fs.rename).toHaveBeenCalledTimes(2);
    expect(await store.get(record.id)).toEqual(record);
    expect(await fs.readdir(dir)).toEqual(
      expect.arrayContaining([`${record.id}.consumed`, `${record.id}.json`]),
    );
    expect((await fs.readdir(dir)).some((name) => name.includes('.tmp-'))).toBe(false);
    await expect(store.transition(record.id, ['approved'], 'consumed', {})).rejects.toMatchObject({
      code: 'APPROVAL_DENIED',
      details: { reason: 'already-consumed' },
    });
  });

  it('does not retry unrelated filesystem errors', async () => {
    const error = Object.assign(new Error('disk error'), { code: 'EIO' });
    vi.mocked(fs.rename).mockRejectedValueOnce(error);
    await expect(store.transition(record.id, ['approved'], 'consumed', {})).rejects.toBe(error);
    expect(fs.rename).toHaveBeenCalledTimes(1);
    expect(await store.get(record.id)).toEqual(record);
  });

  it('times out on an undeletable stale lock without changing or consuming the record', async () => {
    const lock = join(dir, `${record.id}.lock`);
    await fs.writeFile(lock, '');
    await fs.utimes(lock, new Date(0), new Date(0));
    let now = 20_000;
    vi.spyOn(Date, 'now').mockImplementation(() => now);
    vi.mocked(fs.unlink).mockImplementation(() => {
      // Advance during the failed filesystem operation, independent of Vitest's clock reads.
      now = 23_000;
      return Promise.reject(Object.assign(new Error('lock cannot be deleted'), { code: 'EPERM' }));
    });
    const timeout = vi.spyOn(globalThis, 'setTimeout');
    await expect(store.transition(record.id, ['approved'], 'consumed', {})).rejects.toMatchObject({
      code: 'APPROVAL_DENIED',
      details: { reason: 'locked' },
    });
    expect(fs.unlink).toHaveBeenCalledTimes(1);
    expect(timeout).toHaveBeenCalledWith(expect.any(Function), 5);
    expect(fs.rename).not.toHaveBeenCalled();
    expect(JSON.parse(await fs.readFile(join(dir, `${record.id}.json`), 'utf8'))).toEqual(record);
    expect(await fs.readdir(dir)).toEqual(
      expect.arrayContaining([`${record.id}.lock`, `${record.id}.json`]),
    );
    await expect(fs.stat(join(dir, `${record.id}.consumed`))).rejects.toMatchObject({
      code: 'ENOENT',
    });
  });
});
