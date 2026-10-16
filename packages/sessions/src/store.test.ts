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
import { NexarError } from '@nexar/contracts';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { MAX_SESSION_BYTES } from './limits.js';
import { FileSessionStore } from './store.js';
import type { FileSessionStoreOptions } from './store.js';

const BASE = Date.UTC(2026, 9, 2, 10, 0, 0);
const K1 = 'key-0000000000001';
const K2 = 'key-0000000000002';
const isWindows = process.platform === 'win32';

let root: string;
let dir: string;

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'nexar-sessions-'));
  dir = join(root, 'sessions');
});

afterEach(async () => {
  await rm(root, { recursive: true, force: true });
});

function ids(seed: number): () => string {
  let n = seed * 10_000;
  return () => {
    n += 1;
    return n.toString(16).padStart(32, '0');
  };
}

function make(seed = 1, options: FileSessionStoreOptions = {}, at = dir): FileSessionStore {
  let tick = seed * 1000;
  return new FileSessionStore(at, {
    clock: () => new Date(BASE + tick++ * 1000),
    newId: ids(seed),
    instanceId: `instance-${String(seed)}`,
    pid: 1000 + seed,
    isProcessAlive: () => false,
    ...options,
  });
}

async function leased(seed = 1, options: FileSessionStoreOptions = {}): Promise<FileSessionStore> {
  const store = make(seed, options);
  await store.acquireLease();
  return store;
}

async function capture(promise: Promise<unknown>): Promise<NexarError> {
  try {
    await promise;
  } catch (error) {
    expect(error).toBeInstanceOf(NexarError);
    return error as NexarError;
  }
  throw new Error('expected a rejection');
}

async function expectRejects(
  promise: Promise<unknown>,
  code: string,
  reason?: string,
): Promise<NexarError> {
  const error = await capture(promise);
  expect(error.code).toBe(code);
  if (reason !== undefined) expect(error.details?.reason).toBe(reason);
  expect(error.message).not.toContain(root);
  expect(JSON.stringify(error.toJSON())).not.toContain(root);
  return error;
}

async function trySymlink(
  target: string,
  path: string,
  type?: 'junction' | 'file' | 'dir',
): Promise<boolean> {
  try {
    await symlink(target, path, type);
    return true;
  } catch (error) {
    const code = (error as { code?: string }).code;
    if (code === 'EPERM' || code === 'EACCES' || code === 'ENOSYS') return false;
    throw error;
  }
}

describe('FileSessionStore round trip', () => {
  it('creates, mutates, reads back and lists', async () => {
    const store = await leased();
    const session = await store.create({ projectId: 'demo', mode: 'cowork', title: 'First' });
    expect(session.id).toMatch(/^ses_[0-9a-f]{32}$/);
    const begun = await store.beginTurn(session.id, { submissionKey: K1, text: 'hello' });
    expect(begun.created).toBe(true);
    await store.linkTask(session.id, begun.turn.id, { taskId: 'task-1', state: 'running' });
    const done = await store.completeTurn(session.id, begun.turn.id, {
      state: 'succeeded',
      outcome: { text: 'ok' },
    });
    expect(done.session.activeTurnId).toBeNull();
    const read = await store.get(session.id);
    expect(read).toEqual(done.session);
    expect(read?.revision).toBe(4);
    expect(await store.has(session.id)).toBe(true);
    expect(await store.has(`ses_${'f'.repeat(32)}`)).toBe(false);
    expect(await store.get(`ses_${'f'.repeat(32)}`)).toBeUndefined();
    expect(await store.list()).toEqual([
      expect.objectContaining({
        id: session.id,
        turnCount: 1,
        lastTurnState: 'succeeded',
        activeTurnId: null,
      }),
    ]);
  });

  it('renames and changes mode', async () => {
    const store = await leased();
    const { id } = await store.create({ projectId: 'demo', mode: 'cowork', title: 'T' });
    expect((await store.rename(id, 'Renamed')).title).toBe('Renamed');
    const changed = await store.setMode(id, 'code');
    expect(changed).toMatchObject({ mode: 'code' });
    expect(changed.modeChangedAt).toBeDefined();
  });

  it('keeps no temp files and leaves 0700/0600 permissions', async () => {
    const store = await leased();
    const { id } = await store.create({ projectId: 'demo', mode: 'code', title: 'T' });
    await store.rename(id, 'A');
    await store.rename(id, 'B');
    expect((await readdir(dir)).sort()).toEqual(['.lease', `${id}.json`]);
    if (!isWindows) {
      expect((await stat(dir)).mode & 0o777).toBe(0o700);
      expect((await stat(join(dir, `${id}.json`))).mode & 0o777).toBe(0o600);
      expect((await stat(join(dir, '.lease'))).mode & 0o777).toBe(0o600);
    }
  });

  it('lists newest first, honours the limit and ignores lease and temp files', async () => {
    const store = await leased();
    const a = await store.create({ projectId: 'demo', mode: 'code', title: 'A' });
    const b = await store.create({ projectId: 'demo', mode: 'code', title: 'B' });
    await store.rename(a.id, 'A2');
    await writeFile(join(dir, `.${a.id}.deadbeef.tmp`), 'x');
    await writeFile(join(dir, 'notes.txt'), 'x');
    expect((await store.list()).map((s) => s.id)).toEqual([a.id, b.id]);
    expect((await store.list({ limit: 1 })).map((s) => s.id)).toEqual([a.id]);
  });

  it('returns an empty list and undefined for a missing directory', async () => {
    const store = make();
    expect(await store.list()).toEqual([]);
    expect(await store.get(`ses_${'a'.repeat(32)}`)).toBeUndefined();
  });

  it('validates ids before touching the filesystem', async () => {
    const store = await leased();
    await expectRejects(store.get('../escape'), 'VALIDATION_ERROR');
    await expectRejects(
      store.beginTurn('nope', { submissionKey: K1, text: 'x' }),
      'VALIDATION_ERROR',
    );
    await expectRejects(
      store.rename(`ses_${'e'.repeat(32)}`, 'x'),
      'VALIDATION_ERROR',
      'unknown-session',
    );
  });
});

describe('revisions and serialization', () => {
  it('rejects a stale expectedRevision with the current revision', async () => {
    const store = await leased();
    const { id, revision } = await store.create({ projectId: 'demo', mode: 'code', title: 'T' });
    await store.rename(id, 'Newer', revision);
    const error = await expectRejects(
      store.rename(id, 'Stale', revision),
      'CONFLICT',
      'stale-revision',
    );
    expect(error.details).toEqual({ reason: 'stale-revision', revision: revision + 1 });
    expect((await store.get(id))?.title).toBe('Newer');
  });

  it('lets exactly one of two concurrent turns with different keys win', async () => {
    const store = await leased();
    const { id } = await store.create({ projectId: 'demo', mode: 'code', title: 'T' });
    const results = await Promise.allSettled([
      store.beginTurn(id, { submissionKey: K1, text: 'one' }),
      store.beginTurn(id, { submissionKey: K2, text: 'two' }),
    ]);
    expect(results.filter((r) => r.status === 'fulfilled')).toHaveLength(1);
    const rejected = results.find((r) => r.status === 'rejected');
    const error = (rejected as PromiseRejectedResult).reason as NexarError;
    expect(error.code).toBe('CONFLICT');
    expect(error.details).toMatchObject({ reason: 'session-busy' });
    expect((await store.get(id))?.turns).toHaveLength(1);
  });

  it('collapses concurrent retries of the same key into one turn', async () => {
    const store = await leased();
    const { id } = await store.create({ projectId: 'demo', mode: 'code', title: 'T' });
    const [a, b] = await Promise.all([
      store.beginTurn(id, { submissionKey: K1, text: 'same' }),
      store.beginTurn(id, { submissionKey: K1, text: 'same' }),
    ]);
    expect([a.created, b.created].sort()).toEqual([false, true]);
    expect(a.turn.id).toBe(b.turn.id);
    expect((await store.get(id))?.turns).toHaveLength(1);
  });

  it('refuses a new turn near the size cap and keeps the file readable', async () => {
    const store = await leased();
    const { id } = await store.create({ projectId: 'demo', mode: 'code', title: 'T' });
    const text = 'x'.repeat(100_000);
    let rejected: NexarError | undefined;
    for (let i = 0; i < 60 && rejected === undefined; i += 1) {
      try {
        const { turn } = await store.beginTurn(id, {
          submissionKey: `key-${String(i).padStart(12, '0')}`,
          text,
        });
        await store.completeTurn(id, turn.id, { state: 'succeeded' });
      } catch (error) {
        rejected = error as NexarError;
      }
    }
    expect(rejected?.code).toBe('POLICY_REJECTED');
    expect(rejected?.details?.reason).toBe('session-full');
    const stored = await stat(join(dir, `${id}.json`));
    expect(stored.size).toBeLessThanOrEqual(MAX_SESSION_BYTES);
    expect((await store.get(id))?.turns.length).toBeGreaterThan(30);
  }, 60_000);
});

describe('writer lease', () => {
  it('refuses every mutation without the lease but allows reads', async () => {
    const writer = await leased(1);
    const { id } = await writer.create({ projectId: 'demo', mode: 'code', title: 'T' });
    const reader = make(2);
    expect(await reader.get(id)).toBeDefined();
    expect(await reader.list()).toHaveLength(1);
    await expectRejects(
      reader.create({ projectId: 'demo', mode: 'code', title: 'x' }),
      'CONFLICT',
      'lease-required',
    );
    await expectRejects(
      reader.beginTurn(id, { submissionKey: K1, text: 'x' }),
      'CONFLICT',
      'lease-required',
    );
    await expectRejects(reader.rename(id, 'x'), 'CONFLICT', 'lease-required');
    await expectRejects(reader.setMode(id, 'cowork'), 'CONFLICT', 'lease-required');
  });

  it('refuses mutation after the lease was released', async () => {
    const store = await leased();
    const { id } = await store.create({ projectId: 'demo', mode: 'code', title: 'T' });
    await store.releaseLease();
    await expectRejects(store.rename(id, 'x'), 'CONFLICT', 'lease-required');
  });

  it('is held against a live foreign process', async () => {
    await leased(1);
    const rival = make(2, { isProcessAlive: () => true });
    await expectRejects(rival.acquireLease(), 'CONFLICT', 'lease-held');
    const lease = JSON.parse(await readFile(join(dir, '.lease'), 'utf8')) as { instanceId: string };
    expect(lease.instanceId).toBe('instance-1');
  });

  it('takes over a stale lease (dead pid) and the old holder cannot release the new one', async () => {
    const first = await leased(1);
    const second = make(2, { isProcessAlive: (pid) => pid !== 1001 });
    await second.acquireLease();
    await first.releaseLease();
    const lease = JSON.parse(await readFile(join(dir, '.lease'), 'utf8')) as { instanceId: string };
    expect(lease.instanceId).toBe('instance-2');
    await second.releaseLease();
    expect(await readdir(dir)).toEqual([]);
  });

  it('refuses an unverifiable lease without overwriting it', async () => {
    await mkdir(dir, { recursive: true });
    await writeFile(join(dir, '.lease'), 'not json');
    const store = make(2, { isProcessAlive: () => true });
    await expectRejects(store.acquireLease(), 'CONFLICT', 'lease-unverifiable');
    expect(store.holdsLease()).toBe(false);
    expect(await readFile(join(dir, '.lease'), 'utf8')).toBe('not json');
    expect((await readdir(dir)).sort()).toEqual(['.lease']);
  });

  it('can be re-acquired after release', async () => {
    const first = await leased(1);
    await first.releaseLease();
    const second = make(2, { isProcessAlive: () => true });
    await second.acquireLease();
    expect((await readdir(dir)).sort()).toEqual(['.lease']);
  });
});

describe('restart recovery', () => {
  it('interrupts running turns, keeps pending-confirmation, replays nothing', async () => {
    const first = await leased(1);
    const lane = {
      policy: 'lanes@1',
      mode: 'cowork' as const,
      requestedLane: 'code' as const,
      effectiveLane: 'code' as const,
    };
    const runningSession = await first.create({ projectId: 'demo', mode: 'code', title: 'R' });
    const startedRunning = await first.beginTurn(runningSession.id, {
      submissionKey: K1,
      text: 'running',
    });
    await first.linkTask(runningSession.id, startedRunning.turn.id, {
      taskId: 'task-1',
      state: 'running',
    });
    const pendingSession = await first.create({ projectId: 'demo', mode: 'cowork', title: 'P' });
    const pending = await first.beginTurn(pendingSession.id, {
      submissionKey: K2,
      text: 'pending',
      state: 'pending-confirmation',
      lane,
    });
    const idleSession = await first.create({ projectId: 'demo', mode: 'cowork', title: 'I' });
    const idleBefore = await readFile(join(dir, `${idleSession.id}.json`), 'utf8');
    const pendingBefore = await readFile(join(dir, `${pendingSession.id}.json`), 'utf8');

    // The first process "crashes": no release. Its pid is dead for the second one.
    const second = make(2, { isProcessAlive: () => false });
    expect(await second.acquireLease()).toEqual({ interruptedTurns: 1 });

    const recovered = await second.get(runningSession.id);
    expect(recovered).toMatchObject({ activeTurnId: null, revision: 4 });
    expect(recovered?.turns[0]).toEqual({
      ...startedRunning.turn,
      state: 'interrupted',
      tasks: [{ taskId: 'task-1', state: 'interrupted' }],
      updatedAt: recovered?.turns[0]?.updatedAt,
    });
    expect(await readFile(join(dir, `${pendingSession.id}.json`), 'utf8')).toBe(pendingBefore);
    expect((await second.get(pendingSession.id))?.turns[0]?.state).toBe('pending-confirmation');
    expect((await second.get(pendingSession.id))?.activeTurnId).toBe(pending.turn.id);
    expect(await readFile(join(dir, `${idleSession.id}.json`), 'utf8')).toBe(idleBefore);

    // Recovery is idempotent: nothing left to interrupt.
    await second.releaseLease();
    const third = make(3);
    expect(await third.acquireLease()).toEqual({ interruptedTurns: 0 });
  });

  it('keeps submissions idempotent across a new store instance without re-running them', async () => {
    const first = await leased(1);
    const { id } = await first.create({ projectId: 'demo', mode: 'code', title: 'T' });
    const begun = await first.beginTurn(id, { submissionKey: K1, text: 'do it once' });
    await first.releaseLease();

    const second = await leased(2);
    const replay = await second.beginTurn(id, { submissionKey: K1, text: 'do it once' });
    expect(replay.created).toBe(false);
    expect(replay.turn.id).toBe(begun.turn.id);
    expect(replay.turn.state).toBe('interrupted');
    expect((await second.get(id))?.turns).toHaveLength(1);
    await expectRejects(
      second.beginTurn(id, { submissionKey: K1, text: 'different' }),
      'VALIDATION_ERROR',
      'submission-key-reused',
    );
    const fresh = await second.beginTurn(id, { submissionKey: K2, text: 'next' });
    expect(fresh.created).toBe(true);
    expect(fresh.turn.index).toBe(1);
  });
});

describe('fails closed on unsafe or corrupt files', () => {
  const sid = (c: string): string => `ses_${c.repeat(32)}`;

  async function seed(): Promise<{ store: FileSessionStore; goodId: string; goodPath: string }> {
    const store = await leased(1);
    const good = await store.create({ projectId: 'demo', mode: 'code', title: 'Good' });
    await store.beginTurn(good.id, { submissionKey: K1, text: 'running' });
    await store.releaseLease();
    return { store, goodId: good.id, goodPath: join(dir, `${good.id}.json`) };
  }

  it('rejects corrupt json, oversized files and bad shapes, listing them unavailable', async () => {
    const { goodId } = await seed();
    await writeFile(join(dir, `${sid('c')}.json`), '{ nope');
    await writeFile(join(dir, `${sid('d')}.json`), Buffer.alloc(MAX_SESSION_BYTES + 1, 0x20));
    await writeFile(join(dir, `${sid('e')}.json`), JSON.stringify({ schemaVersion: 1 }));
    const reader = make(2);
    for (const c of ['c', 'd', 'e']) {
      await expectRejects(reader.get(sid(c)), 'VALIDATION_ERROR', 'corrupt-record');
    }
    const listing = await reader.list();
    expect(listing.filter((s) => 'unavailable' in s).map((s) => s.id)).toEqual([
      sid('c'),
      sid('d'),
      sid('e'),
    ]);
    expect(listing[0]?.id).toBe(goodId);
  });

  it('does not rewrite unreadable files during recovery', async () => {
    const { goodId } = await seed();
    const corruptPath = join(dir, `${sid('c')}.json`);
    const oversizePath = join(dir, `${sid('d')}.json`);
    const hardlinkSource = join(root, 'elsewhere.json');
    const hardlinkPath = join(dir, `${sid('b')}.json`);
    await writeFile(corruptPath, '{ nope');
    await writeFile(oversizePath, Buffer.alloc(MAX_SESSION_BYTES + 1, 0x20));
    await writeFile(hardlinkSource, await readFile(join(dir, `${goodId}.json`)));
    await link(hardlinkSource, hardlinkPath);
    const before = {
      corrupt: await readFile(corruptPath),
      oversize: await readFile(oversizePath),
      hardlink: await readFile(hardlinkPath),
    };
    const store = make(2);
    expect((await store.acquireLease()).interruptedTurns).toBe(1);
    expect((await readFile(corruptPath)).equals(before.corrupt)).toBe(true);
    expect((await readFile(oversizePath)).equals(before.oversize)).toBe(true);
    expect((await readFile(hardlinkPath)).equals(before.hardlink)).toBe(true);
    expect((await stat(hardlinkPath)).nlink).toBe(2);
  });

  it('refuses hard-linked session files', async () => {
    const { goodId, goodPath } = await seed();
    await link(goodPath, join(root, 'alias.json'));
    await expectRejects(make(2).get(goodId), 'VALIDATION_ERROR', 'corrupt-record');
  });

  it('refuses a record stored under another session id', async () => {
    const { goodPath } = await seed();
    await writeFile(join(dir, `${sid('a')}.json`), await readFile(goodPath));
    await expectRejects(make(2).get(sid('a')), 'VALIDATION_ERROR', 'corrupt-record');
  });

  it('refuses symlinked session files', async (ctx) => {
    await seed();
    const target = join(root, 'target.json');
    await writeFile(target, '{}');
    if (!(await trySymlink(target, join(dir, `${sid('9')}.json`), 'file'))) ctx.skip();
    await expectRejects(make(2).get(sid('9')), 'VALIDATION_ERROR', 'corrupt-record');
  });

  it('refuses a session directory that was swapped for a link', async (ctx) => {
    await seed();
    const real = join(root, 'real');
    await mkdir(real);
    const linked = join(root, 'linked');
    if (!(await trySymlink(real, linked, 'junction'))) ctx.skip();
    await expectRejects(make(2, {}, linked).get(sid('a')), 'POLICY_REJECTED', 'unsafe-directory');
    await expectRejects(make(2, {}, linked).acquireLease(), 'POLICY_REJECTED', 'unsafe-directory');
  });

  it('refuses a directory named like a session file', async () => {
    await seed();
    await mkdir(join(dir, `${sid('8')}.json`));
    await expectRejects(make(2).get(sid('8')), 'VALIDATION_ERROR', 'corrupt-record');
    expect(await make(2).has(sid('8'))).toBe(false);
  });
});

describe('error hygiene', () => {
  it('never puts the directory path or record text in errors', async () => {
    const store = await leased();
    const secret = 'top secret owner message';
    const { id } = await store.create({ projectId: 'demo', mode: 'code', title: 'T' });
    const { turn } = await store.beginTurn(id, { submissionKey: K1, text: secret });
    const errors = [
      await capture(store.beginTurn(id, { submissionKey: K2, text: 'x' })),
      await capture(store.beginTurn(id, { submissionKey: K1, text: 'other' })),
      await capture(store.rename(id, 'x', 999)),
      await capture(store.completeTurn(id, `turn_${'0'.repeat(32)}`, { state: 'failed' })),
      await capture(
        store
          .completeTurn(id, turn.id, { state: 'succeeded' })
          .then(() => store.completeTurn(id, turn.id, { state: 'failed' })),
      ),
    ];
    await writeFile(join(dir, `ses_${'c'.repeat(32)}.json`), secret);
    errors.push(await capture(store.get(`ses_${'c'.repeat(32)}`)));
    for (const error of errors) {
      const text = JSON.stringify(error.toJSON());
      expect(text).not.toContain(root);
      expect(text).not.toContain(secret);
    }
  });

  it('turns raw filesystem failures into path-free errors', async () => {
    const file = join(root, 'not-a-dir');
    await writeFile(file, 'x');
    const error = await expectRejects(make(1, {}, file).acquireLease(), 'INTERNAL_ERROR');
    expect(error.details?.reason).toBe('io-error');
    expect(error.cause).toBeUndefined();
  });
});
