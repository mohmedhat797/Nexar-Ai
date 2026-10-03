import { describe, expect, it } from 'vitest';
import { InMemoryApprovalStore } from '@nexar/approvals';
import { COWORK_RULES, decidePermission, recordCoworkDecision } from './policy.js';

const posix = { scratchRoot: '/data/scratch/t1', platform: 'linux' as const };
const win = { scratchRoot: 'C:\\Scratch\\T1', platform: 'win32' as const };

describe('decidePermission', () => {
  it.each([
    ['write_file', '/data/scratch/t1/out.md', posix],
    ['replace_in_file', '/data/scratch/t1/a/b/out.md', posix],
    ['apply_patch', 'out.md', posix],
    ['apply_unified_diff', './sub/../out.md', posix],
    ['write_file', 'C:\\Scratch\\T1\\out.md', win],
    ['write_file', 'c:\\scratch\\t1\\OUT.md', win],
    ['write_file', 'c:/scratch/t1/out.md', win],
  ])('allows %s -> %s', (name, target, options) => {
    expect(decidePermission({ name, target }, options)).toEqual({
      decision: 'allow',
      ruleId: COWORK_RULES.scratchWrite,
    });
  });

  it.each([
    ['/data/scratch/t1/../t2/out.md', posix],
    ['../out.md', posix],
    ['/data/scratch/t10/out.md', posix],
    ['/data/scratch/T1/out.md', posix],
    ['/etc/passwd', posix],
    ['/data/scratch/t1', posix],
    ['/data/scratch/t1/', posix],
    ['..', posix],
    ['/data/scratch/t1/\0x', posix],
    ['C:\\Scratch\\T1\\..\\T2\\out.md', win],
    ['C:\\Scratch\\T10\\out.md', win],
    ['D:\\Scratch\\T1\\out.md', win],
    ['\\\\server\\share\\out.md', win],
  ])('denies write outside the scratch root: %s', (target, options) => {
    expect(decidePermission({ name: 'write_file', target }, options)).toEqual({
      decision: 'deny',
      ruleId: COWORK_RULES.targetOutsideScratch,
    });
  });

  it('denies a missing or empty target', () => {
    expect(decidePermission({ name: 'write_file' }, posix).ruleId).toBe(COWORK_RULES.targetMissing);
    expect(decidePermission({ name: 'write_file', target: '' }, posix).ruleId).toBe(
      COWORK_RULES.targetMissing,
    );
  });

  it.each(['run_shell', 'web_fetch', 'send_email', 'schedule_task', 'mcp__x__tool', 'unknown', ''])(
    'denies tool %j even with a scratch target',
    (name) => {
      expect(decidePermission({ name, target: '/data/scratch/t1/out.md' }, posix)).toEqual({
        decision: 'deny',
        ruleId: COWORK_RULES.toolNotAllowed,
      });
    },
  );

  it('denies a relative scratch root', () => {
    expect(
      decidePermission(
        { name: 'write_file', target: 'a' },
        { scratchRoot: 'rel', platform: 'linux' },
      ),
    ).toMatchObject({ decision: 'deny' });
  });
});

describe('recordCoworkDecision', () => {
  const ctx = { sessionId: 's1', turnId: 'u1', taskId: 'task-1' };

  it('stores a terminal policy record with a fingerprint and no arguments or paths', async () => {
    const store = new InMemoryApprovalStore();
    const allowed = await recordCoworkDecision(
      store,
      ctx,
      { name: 'write_file', target: '/data/scratch/t1/secret-name.md' },
      { decision: 'allow', ruleId: COWORK_RULES.scratchWrite },
    );
    const denied = await recordCoworkDecision(
      store,
      ctx,
      { name: 'run_shell', target: 'echo SECRET' },
      { decision: 'deny', ruleId: COWORK_RULES.toolNotAllowed },
    );
    expect(allowed).toMatchObject({ status: 'consumed', decidedBy: 'policy', taskId: 'task-1' });
    expect(denied).toMatchObject({ status: 'denied', decidedBy: 'policy' });
    expect(allowed.fingerprint).toMatch(/^[0-9a-f]{64}$/);
    expect(allowed.fingerprint).not.toBe(denied.fingerprint);
    const stored = JSON.stringify([allowed, denied]);
    expect(stored).not.toContain('secret-name');
    expect(stored).not.toContain('SECRET');
    expect(allowed.metadata).toEqual({ ruleId: COWORK_RULES.scratchWrite, tool: 'write_file' });
  });

  it('is deterministic per session, turn, tool and target', async () => {
    const store = new InMemoryApprovalStore();
    const request = { name: 'write_file', target: '/a/b' };
    const decision = { decision: 'allow' as const, ruleId: COWORK_RULES.scratchWrite };
    const one = await recordCoworkDecision(store, ctx, request, decision);
    const two = await recordCoworkDecision(store, ctx, request, decision);
    const other = await recordCoworkDecision(store, { ...ctx, turnId: 'u2' }, request, decision);
    expect(one.fingerprint).toBe(two.fingerprint);
    expect(other.fingerprint).not.toBe(one.fingerprint);
  });

  it('does not put an unsafe upstream tool name into the summary', async () => {
    const record = await recordCoworkDecision(
      new InMemoryApprovalStore(),
      ctx,
      { name: 'bad name\nwith "stuff"' },
      { decision: 'deny', ruleId: COWORK_RULES.toolNotAllowed },
    );
    expect(record.summary).toBe('Cowork unknown: denied by policy');
  });
});
