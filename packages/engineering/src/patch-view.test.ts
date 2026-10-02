import { createHash } from 'node:crypto';
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { readTaskPatch, type EngineeringRecord } from './index.js';
import { writeEngineeringRecord } from './record.js';

const TASK = 'eng-0123456789ab';

function diffFor(path: string, body = 'one'): string {
  return [
    `diff --git a/${path} b/${path}`,
    'new file mode 100644',
    `index 0000000000000000000000000000000000000000..${'1'.repeat(40)}`,
    '--- /dev/null',
    `+++ b/${path}`,
    '@@ -0,0 +1 @@',
    `+${body}`,
    '',
  ].join('\n');
}

const sha = (text: string | Buffer): string => createHash('sha256').update(text).digest('hex');

const roots: string[] = [];
afterEach(() => {
  for (const dir of roots.splice(0)) rmSync(dir, { recursive: true, force: true });
});

interface Fixture {
  readonly stateDir: string;
  readonly worktreesDir: string;
  readonly outDir: string;
}

async function fixture(
  patches: EngineeringRecord['patches'],
  files: Readonly<Record<string, string>> = {},
): Promise<Fixture> {
  const base = mkdtempSync(join(tmpdir(), 'nexar-patch-view-'));
  roots.push(base);
  const stateDir = join(base, 'state');
  const worktreesDir = join(base, 'worktrees');
  const outDir = join(worktreesDir, 'demo', TASK, 'out');
  mkdirSync(outDir, { recursive: true });
  for (const [name, text] of Object.entries(files)) writeFileSync(join(outDir, name), text);
  await writeEngineeringRecord(stateDir, {
    schemaVersion: 1,
    taskId: TASK,
    projectId: 'demo',
    planId: 'implement-review',
    status: 'running',
    startedAt: '2026-10-03T10:00:00.000Z',
    baseBranch: 'main',
    branch: `nexar/${TASK}`,
    round: 0,
    lanes: [],
    commands: [],
    patches,
    reviews: [],
  });
  return { stateDir, worktreesDir, outDir };
}

const patchRecord = (text: string, over: Partial<EngineeringRecord['patches'][number]> = {}) => ({
  round: 0,
  sha256: sha(text),
  bytes: Buffer.byteLength(text),
  files: 1,
  valid: true,
  violations: [],
  ...over,
});

const options = (f: Fixture, over: { maxBytes?: number; maxFiles?: number } = {}) => ({
  stateDir: f.stateDir,
  worktreesDir: f.worktreesDir,
  taskId: TASK,
  maxBytes: over.maxBytes ?? 256 * 1024,
  maxFiles: over.maxFiles ?? 500,
});

describe('readTaskPatch', () => {
  it('returns the validated patch text and repository-relative files', async () => {
    const text = diffFor('src/a.ts') + diffFor('docs/b.md');
    const f = await fixture([patchRecord(text)], { 'patch-0.diff': text });
    await expect(readTaskPatch(options(f))).resolves.toEqual({
      text,
      truncated: false,
      files: ['src/a.ts', 'docs/b.md'],
      fileCount: 2,
    });
  });

  it('serves the patch named by the last valid record, not a newer unrecorded file', async () => {
    const good = diffFor('good.ts');
    const f = await fixture(
      [patchRecord(good), patchRecord('x', { valid: false, round: 1, sha256: 'f'.repeat(64) })],
      { 'patch-0.diff': good, 'patch-1.diff': diffFor('other.ts') },
    );
    expect((await readTaskPatch(options(f))).files).toEqual(['good.ts']);
  });

  it('truncates at the byte bound without splitting a character', async () => {
    const text = diffFor('a.txt', 'é'.repeat(100));
    const f = await fixture([patchRecord(text)], { 'patch-0.diff': text });
    const cut = text.indexOf('é');
    const view = await readTaskPatch(
      options(f, { maxBytes: Buffer.byteLength(text.slice(0, cut)) + 3 }),
    );
    expect(view.truncated).toBe(true);
    expect(view.text).not.toContain('�');
    expect(Buffer.byteLength(view.text)).toBeLessThanOrEqual(
      Buffer.byteLength(text.slice(0, cut)) + 3,
    );
    expect(text.startsWith(view.text)).toBe(true);
  });

  it('is not truncated at exactly the bound', async () => {
    const text = diffFor('a.txt');
    const f = await fixture([patchRecord(text)], { 'patch-0.diff': text });
    const view = await readTaskPatch(options(f, { maxBytes: Buffer.byteLength(text) }));
    expect(view).toMatchObject({ truncated: false, text });
  });

  it('bounds the file list but reports the real count', async () => {
    const text = ['a', 'b', 'c'].map((n) => diffFor(`${n}.ts`)).join('');
    const f = await fixture([patchRecord(text)], { 'patch-0.diff': text });
    const view = await readTaskPatch(options(f, { maxFiles: 2 }));
    expect(view.files).toEqual(['a.ts', 'b.ts']);
    expect(view.fileCount).toBe(3);
  });

  it('refuses a patch whose bytes no longer match the recorded hash', async () => {
    const text = diffFor('a.ts', 'one');
    const swapped = diffFor('a.ts', 'two');
    expect(swapped.length).toBe(text.length);
    const f = await fixture([patchRecord(text)], { 'patch-0.diff': swapped });
    await expect(readTaskPatch(options(f))).rejects.toMatchObject({ code: 'VALIDATION_ERROR' });
  });

  it.each([
    ['an unknown task', async () => ({ ...(await fixture([])), taskId: 'eng-unknown00000' })],
    ['a task without a valid patch', async () => fixture([patchRecord('x', { valid: false })])],
    ['a removed worktree', async () => fixture([patchRecord(diffFor('a.ts'))])],
  ])('reports %s without a path', async (_name, make) => {
    const f = (await make()) as Fixture & { taskId?: string };
    const error = await readTaskPatch({
      ...options(f),
      ...(f.taskId ? { taskId: f.taskId } : {}),
    }).catch((e: unknown) => e as Error);
    expect(error).toMatchObject({ code: 'VALIDATION_ERROR' });
    expect((error as Error).message).not.toContain(f.stateDir);
    expect((error as Error).message).not.toContain(f.worktreesDir);
  });

  it.skipIf(process.platform === 'win32')(
    'never follows a symlink named like a patch',
    async () => {
      const text = diffFor('a.ts');
      const f = await fixture([patchRecord(text)]);
      const outside = join(f.stateDir, 'outside.diff');
      writeFileSync(outside, text);
      symlinkSync(outside, join(f.outDir, 'patch-0.diff'));
      await expect(readTaskPatch(options(f))).rejects.toMatchObject({ code: 'VALIDATION_ERROR' });
    },
  );
});
