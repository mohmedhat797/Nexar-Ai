import { mkdir, mkdtemp, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { FileApprovalStore, type ApprovalRequest } from '@nexar/approvals';
import { runCli } from './cli.js';
import type { CliIo } from './io.js';

function capture(cwd: string, confirm?: (question: string) => Promise<boolean>) {
  let out = '';
  let err = '';
  const io: CliIo = {
    stdout: (s) => (out += s),
    stderr: (s) => (err += s),
    env: { PATH: process.env['PATH'] ?? '' },
    cwd,
    ...(confirm === undefined ? {} : { confirm }),
  };
  return { io, out: () => out, err: () => err };
}

const FINGERPRINT = 'f'.repeat(64);

function request(n: number, over: Partial<ApprovalRequest> = {}): ApprovalRequest {
  const id = `apr_${n.toString(16).padStart(32, '0')}`;
  return {
    id,
    createdAt: '2026-09-30T10:00:00.000Z',
    expiresAt: new Date(Date.now() + 3_600_000).toISOString(),
    instanceId: 'inst',
    taskId: 'task_1',
    projectId: 'demo',
    clientId: 'openworker',
    actionType: 'email.send',
    summary: 'Send the proposal to Acme',
    risk: 'high',
    fingerprint: FINGERPRINT,
    status: 'pending',
    ...over,
  };
}

describe('nexar approvals (in-process, offline)', () => {
  let dir: string;
  let store: FileApprovalStore;

  beforeEach(async () => {
    dir = await realpath(await mkdtemp(join(tmpdir(), 'nexar-cli-apr-')));
    await mkdir(join(dir, '.nexar'), { recursive: true });
    store = new FileApprovalStore(join(dir, '.nexar', 'approvals'));
    await writeFile(join(dir, 'unrelated.txt'), 'x');
  });
  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  const id1 = request(1).id;
  const id2 = request(2).id;

  it('lists pending requests by default, all with --all, and as json', async () => {
    await store.create(request(1));
    await store.create(request(2, { status: 'denied' }));

    const pending = capture(dir);
    expect(await runCli(['approvals', 'list'], pending.io)).toBe(0);
    expect(pending.out()).toContain(id1);
    expect(pending.out()).toContain('email.send');
    expect(pending.out()).toContain('Send the proposal to Acme');
    expect(pending.out()).toContain('openworker');
    expect(pending.out()).not.toContain(id2);

    const all = capture(dir);
    expect(await runCli(['approvals', 'list', '--all'], all.io)).toBe(0);
    expect(all.out()).toContain(id2);
    expect(all.out()).toContain('denied');

    const json = capture(dir);
    expect(await runCli(['approvals', 'list', '--json'], json.io)).toBe(0);
    const rows = JSON.parse(json.out()) as Record<string, unknown>[];
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ id: id1, risk: 'high', clientId: 'openworker' });
    expect(rows[0]).not.toHaveProperty('fingerprint');
    expect(rows[0]).not.toHaveProperty('parameters');
  });

  it('says so when nothing is pending', async () => {
    const c = capture(dir);
    expect(await runCli(['approvals', 'list'], c.io)).toBe(0);
    expect(c.out()).toBe('no pending approvals\n');
  });

  it('strips control characters from summaries', async () => {
    await store.create(request(1, { summary: 'safe\u001b[31mred\nnext' }));
    const c = capture(dir);
    await runCli(['approvals', 'list'], c.io);
    expect(c.out()).not.toContain('\u001b');
    expect(c.out().trimEnd().split('\n')).toHaveLength(2);
  });

  it('approves with --yes, showing summary, risk and fingerprint prefix', async () => {
    await store.create(request(1));
    const c = capture(dir);
    expect(await runCli(['approvals', 'approve', id1, '--yes', '--reason', 'ok'], c.io)).toBe(0);
    expect(c.err()).toContain('Send the proposal to Acme');
    expect(c.err()).toContain('risk:        high');
    expect(c.err()).toContain(`fingerprint: ${FINGERPRINT.slice(0, 12)}`);
    expect(c.err()).not.toContain(FINGERPRINT);
    expect(c.out()).toBe(`${id1} approved\n`);
    expect(await store.get(id1)).toMatchObject({
      status: 'approved',
      reason: 'ok',
      decidedBy: expect.stringMatching(/^cli:.+/) as string,
    });
  });

  it('approves after an interactive yes and stops on no', async () => {
    await store.create(request(1));
    await store.create(request(2));
    const no = capture(dir, () => Promise.resolve(false));
    expect(await runCli(['approvals', 'approve', id1], no.io)).toBe(1);
    expect((await store.get(id1))?.status).toBe('pending');

    const yes = capture(dir, () => Promise.resolve(true));
    expect(await runCli(['approvals', 'approve', id2], yes.io)).toBe(0);
    expect((await store.get(id2))?.status).toBe('approved');
  });

  it('refuses to approve without --yes when there is no terminal', async () => {
    await store.create(request(1));
    const c = capture(dir);
    expect(await runCli(['approvals', 'approve', id1], c.io)).toBe(2);
    expect(c.err()).toContain('--yes');
    expect((await store.get(id1))?.status).toBe('pending');
  });

  it('denies without confirmation and records the reason', async () => {
    await store.create(request(1));
    const c = capture(dir);
    expect(await runCli(['approvals', 'deny', id1, '--reason', 'not now'], c.io)).toBe(0);
    expect(c.out()).toBe(`${id1} denied\n`);
    expect(await store.get(id1)).toMatchObject({ status: 'denied', reason: 'not now' });
  });

  it('fails with APPROVAL_DENIED for an unknown id', async () => {
    const c = capture(dir);
    expect(await runCli(['approvals', 'approve', id1, '--yes'], c.io)).toBe(1);
    expect(c.err()).toContain('APPROVAL_DENIED');
    const d = capture(dir);
    expect(await runCli(['approvals', 'deny', id1], d.io)).toBe(1);
    expect(d.err()).toContain('APPROVAL_DENIED');
  });

  it('fails for a malformed id', async () => {
    const c = capture(dir);
    expect(await runCli(['approvals', 'deny', '../../etc/passwd'], c.io)).toBe(1);
    expect(c.err()).toContain('APPROVAL_DENIED');
  });

  it('cannot approve an expired request, even without a terminal', async () => {
    await store.create(request(1, { expiresAt: new Date(Date.now() - 1000).toISOString() }));
    const c = capture(dir);
    expect(await runCli(['approvals', 'approve', id1, '--yes'], c.io)).toBe(1);
    expect(c.err()).toContain('APPROVAL_DENIED');
    expect(c.err()).toContain('expired');
    expect((await store.get(id1))?.status).toBe('expired');
  });

  it('cannot decide a request that is no longer pending', async () => {
    await store.create(request(1, { status: 'denied' }));
    const c = capture(dir);
    expect(await runCli(['approvals', 'approve', id1, '--yes'], c.io)).toBe(1);
    expect(c.err()).toContain('invalid-state');
  });

  it('rejects bad usage', async () => {
    const c = capture(dir);
    expect(await runCli(['approvals'], c.io)).toBe(2);
    expect(await runCli(['approvals', 'approve'], capture(dir).io)).toBe(2);
  });
});
