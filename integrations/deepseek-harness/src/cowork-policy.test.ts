import { describe, expect, it } from 'vitest';
import { coworkPermissionMode, decideCoworkPermission } from './cowork-policy.js';
import type { CoworkPermission } from './cowork-policy.js';

const WIN_ROOT = 'C:\\Users\\me\\scratch\\turn-1';
const POSIX_ROOT = '/home/me/scratch/turn-1';

function write(
  scratchRoot: string,
  permission: CoworkPermission,
  rawInput: unknown,
  tool = 'write',
  bridgeTools?: readonly string[],
) {
  return decideCoworkPermission(
    { tool, kind: 'edit', rawInput, toolCallId: 'c1' },
    { scratchRoot, permission, ...(bridgeTools === undefined ? {} : { bridgeTools }) },
  );
}

describe.each([
  ['win32', WIN_ROOT, 'D:\\elsewhere\\x.md', 'C:\\Users\\me\\scratch\\turn-1\\inside.md'],
  ['posix', POSIX_ROOT, '/etc/passwd', '/home/me/scratch/turn-1/inside.md'],
])('decideCoworkPermission (%s paths)', (_name, root, outsideAbsolute, insideAbsolute) => {
  it('allows write and edit inside scratch for drafts-only', () => {
    for (const tool of ['write', 'edit']) {
      expect(write(root, 'drafts-only', { file_path: 'proposal.md' }, tool)).toEqual({
        decision: 'allow',
        reason: 'draft-in-scratch',
      });
    }
    expect(write(root, 'drafts-only', { file_path: 'sub/dir/a.md' }).decision).toBe('allow');
    expect(write(root, 'drafts-only', { file_path: insideAbsolute }).decision).toBe('allow');
    expect(
      write(root, 'drafts-only', {
        file_path: 'a.md',
        sandbox_permissions: 'workspace-write',
      }).decision,
    ).toBe('allow');
  });

  it('asks the owner for ask-before-write and rejects for read-only', () => {
    expect(write(root, 'ask-before-write', { file_path: 'a.md' })).toEqual({
      decision: 'ask-owner',
      reason: 'owner-approval-required',
    });
    expect(write(root, 'read-only', { file_path: 'a.md' })).toEqual({
      decision: 'reject',
      reason: 'read-only',
    });
  });

  it('rejects .. escapes and absolute paths outside scratch in every mode', () => {
    for (const permission of ['read-only', 'drafts-only', 'ask-before-write'] as const) {
      expect(write(root, permission, { file_path: '../outside.md' }).decision).toBe('reject');
      expect(write(root, permission, { file_path: 'a/../../outside.md' }).decision).toBe('reject');
      expect(write(root, permission, { file_path: outsideAbsolute }).reason).toBe(
        'outside-scratch',
      );
    }
  });

  it('rejects the scratch root itself', () => {
    expect(write(root, 'drafts-only', { file_path: '.' })).toEqual({
      decision: 'reject',
      reason: 'outside-scratch',
    });
    expect(write(root, 'drafts-only', { file_path: root }).decision).toBe('reject');
  });

  it('rejects sandbox escalation even for an inside path', () => {
    expect(
      write(root, 'drafts-only', { file_path: 'a.md', sandbox_permissions: 'danger-full-access' }),
    ).toEqual({ decision: 'reject', reason: 'escalation-denied' });
    expect(
      write(root, 'ask-before-write', { file_path: 'a.md', sandbox_permissions: 7 }).decision,
    ).toBe('reject');
  });

  it('rejects the escalation used to leave the workspace', () => {
    expect(
      write(root, 'drafts-only', {
        file_path: '../outside.md',
        sandbox_permissions: 'danger-full-access',
      }).decision,
    ).toBe('reject');
  });

  it('rejects missing or non-string paths and bad input shapes', () => {
    for (const rawInput of [
      {},
      { file_path: 3 },
      { file_path: null },
      { file_path: ['a.md'] },
      { file_path: '' },
      { file_path: 'a\0b.md' },
      { path: 'a.md' },
      { target: 'a.md' },
      { paths: ['a.md', '../outside.md'] },
      { patch: { file_path: 'a.md', content: 'x' } },
      'a.md',
      null,
      undefined,
      ['a.md'],
    ]) {
      expect(write(root, 'drafts-only', rawInput)).toEqual({
        decision: 'reject',
        reason: 'invalid-path',
      });
    }
  });

  it('rejects every other tool, even with a harmless path', () => {
    for (const tool of ['bash', 'pwsh', 'read', 'glob', 'web_fetch', 'subagent', 'unknown-tool']) {
      expect(write(root, 'drafts-only', { file_path: 'a.md' }, tool)).toEqual({
        decision: 'reject',
        reason: 'unsupported-tool',
      });
    }
  });

  it('allows exactly the named bridge tools, without inspecting arguments', () => {
    const bridge = ['mcp__nexar__nexar_intelligence_submit'];
    expect(write(root, 'read-only', undefined, bridge[0], bridge)).toEqual({
      decision: 'allow',
      reason: 'bridge-tool',
    });
    expect(write(root, 'read-only', {}, 'mcp__nexar__other', bridge).decision).toBe('reject');
  });
});

describe('Windows path hazards', () => {
  it.each([
    '\\\\?\\C:\\Users\\me\\scratch\\turn-1\\a.md',
    '\\\\.\\C:\\Users\\me\\scratch\\turn-1\\a.md',
    '\\\\server\\share\\a.md',
    '//server/share/a.md',
    'a.md:stream',
    'NUL',
    'sub\\con.txt',
    '.. \\outside.md',
    'a.md.',
    'C:a.md',
  ])('rejects %j', (file_path) => {
    expect(write(WIN_ROOT, 'drafts-only', { file_path }).decision).toBe('reject');
  });

  it('is case-insensitive about the scratch prefix and accepts forward slashes', () => {
    expect(
      write(WIN_ROOT, 'drafts-only', { file_path: 'c:\\users\\ME\\Scratch\\turn-1\\a.md' })
        .decision,
    ).toBe('allow');
    expect(write(WIN_ROOT, 'drafts-only', { file_path: 'sub/a.md' }).decision).toBe('allow');
  });

  it('does not treat a sibling with the same prefix as inside', () => {
    expect(
      write(WIN_ROOT, 'drafts-only', { file_path: 'C:\\Users\\me\\scratch\\turn-10\\a.md' })
        .decision,
    ).toBe('reject');
  });
});

describe('posix path hazards', () => {
  it('does not treat a sibling with the same prefix as inside', () => {
    expect(
      write(POSIX_ROOT, 'drafts-only', { file_path: '/home/me/scratch/turn-10/a.md' }).decision,
    ).toBe('reject');
  });
});

describe('unusable scratch roots', () => {
  it.each(['relative/scratch', '', '\\\\server\\share\\scratch', '\\\\?\\C:\\scratch'])(
    'rejects everything for %j',
    (root) => {
      expect(write(root, 'drafts-only', { file_path: 'a.md' }).decision).toBe('reject');
    },
  );
});

describe('coworkPermissionMode', () => {
  it('requires a Nexar decision for every mutation in every mode', () => {
    expect(coworkPermissionMode('drafts-only')).toBe('read-only');
    expect(coworkPermissionMode('read-only')).toBe('read-only');
    expect(coworkPermissionMode('ask-before-write')).toBe('read-only');
  });
});
