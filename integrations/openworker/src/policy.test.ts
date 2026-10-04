import { describe, expect, it } from 'vitest';
import { InMemoryApprovalStore } from '@nexar/approvals';
import {
  COWORK_RULES,
  DELEGATION_TOOLS,
  decidePermission,
  isWriteTool,
  recordCoworkDecision,
} from './policy.js';

const posix = { scratchRoot: '/data/scratch/t1', platform: 'linux' as const };
const win = { scratchRoot: 'C:\\Scratch\\T1', platform: 'win32' as const };

const SUBMIT = 'mcp__nexar__nexar_intelligence_submit';
const STATUS = 'mcp__nexar__nexar_intelligence_status';

describe('decidePermission: delegation tools', () => {
  const delegation = { delegationTools: DELEGATION_TOOLS };

  it.each([SUBMIT, STATUS])('allows the exact bridge tool %s, also in read only mode', (name) => {
    const allowed = { decision: 'allow', ruleId: COWORK_RULES.delegation };
    expect(DELEGATION_TOOLS).toEqual([SUBMIT, STATUS]);
    expect(decidePermission({ name }, { ...posix, ...delegation })).toEqual(allowed);
    expect(decidePermission({ name }, { ...posix, ...delegation, readOnly: true })).toEqual(
      allowed,
    );
  });

  it.each([
    `${SUBMIT}2`,
    `${SUBMIT} `,
    SUBMIT.toUpperCase(),
    'mcp__nexar__nexar_route',
    'mcp__other__nexar_intelligence_submit',
    'mcp__nexar__nexar_intelligence_cancel',
    'nexar.intelligence_submit',
    'run_shell',
  ])('denies the look-alike or other tool %s', (name) => {
    expect(decidePermission({ name }, { ...posix, ...delegation })).toMatchObject({
      decision: 'deny',
    });
    expect(decidePermission({ name }, { ...posix, ...delegation, readOnly: true })).toMatchObject({
      decision: 'deny',
      ruleId: COWORK_RULES.readOnly,
    });
  });

  it('allows nothing without the option, and never reads arguments or target', () => {
    expect(decidePermission({ name: SUBMIT }, posix)).toEqual({
      decision: 'deny',
      ruleId: COWORK_RULES.toolNotAllowed,
    });
    const hostile = {
      name: SUBMIT,
      target: '/etc/passwd',
      get arguments(): never {
        throw new Error('arguments were read');
      },
    };
    expect(decidePermission(hostile, { ...posix, ...delegation }).decision).toBe('allow');
  });
});

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
    ['write_file', '/data/scratch/t1/out.md'],
    ['apply_patch', 'out.md'],
    ['run_shell', 'echo hi'],
    ['read_file', '/data/scratch/t1/out.md'],
  ])('denies everything in read only mode: %s', (name, target) => {
    expect(decidePermission({ name, target }, { ...posix, readOnly: true })).toEqual({
      decision: 'deny',
      ruleId: COWORK_RULES.readOnly,
    });
    expect(isWriteTool('write_file')).toBe(true);
    expect(isWriteTool('run_shell')).toBe(false);
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
