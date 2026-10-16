import { createHash } from 'node:crypto';
import { link, mkdir, mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  collectCoworkOutputs,
  parseCoworkFiles,
  readCoworkFile,
  stageCoworkFiles,
} from './cowork-files.js';

const dirs: string[] = [];
const file = (name = 'input.md', data = 'synthetic input') => ({
  name,
  data: Buffer.from(data).toString('base64'),
  sha256: createHash('sha256').update(data).digest('hex'),
});
async function fixture() {
  const dir = await mkdtemp(join(tmpdir(), 'nexar-sec02-files-'));
  dirs.push(dir);
  return dir;
}
afterEach(async () => {
  await Promise.all(dirs.splice(0).map((d) => rm(d, { recursive: true, force: true })));
});
describe('Cowork content transfer', () => {
  it('copies only content and preserves digest without overwriting a destination', async () => {
    const root = await fixture();
    const input = file();
    await stageCoworkFiles(root, [input]);
    expect(await readCoworkFile(root, input.name)).toEqual(input);
    await expect(stageCoworkFiles(root, [input])).rejects.toThrow();
    expect(await readFile(join(root, input.name), 'utf8')).toBe('synthetic input');
  });
  it.each([
    '../outside.md',
    '/etc/passwd',
    'C:\\outside.md',
    'sub/file.md',
    '.env',
    'CON.txt',
    'a.md:stream',
    'a.md.',
    'a.md ',
  ])('rejects remote path %s', (name) => {
    expect(() => parseCoworkFiles([file(name)])).toThrow();
  });
  it('rejects hash mismatch, extra fields, case collisions, malformed base64 and excess data', () => {
    expect(() => parseCoworkFiles([{ ...file(), sha256: '0'.repeat(64) }])).toThrow();
    expect(() => parseCoworkFiles([{ ...file(), path: '/outside' }])).toThrow();
    expect(() => parseCoworkFiles([file('a.md'), file('A.md')])).toThrow();
    expect(() => parseCoworkFiles([{ ...file(), data: file().data + '!' }])).toThrow();
    expect(() => parseCoworkFiles(Array.from({ length: 33 }, (_, i) => file(`${i}.md`)))).toThrow();
    expect(() => parseCoworkFiles([file('large.md', 'x'.repeat(2 * 1024 * 1024 + 1))])).toThrow();
  });
  it('refuses hard-linked output and directories', async () => {
    const dir = await fixture();
    await writeFile(join(dir, 'source.md'), 'synthetic');
    await link(join(dir, 'source.md'), join(dir, 'alias.md'));
    await expect(readCoworkFile(dir, 'alias.md')).rejects.toMatchObject({
      code: 'POLICY_REJECTED',
    });
    await mkdir(join(dir, 'folder.md'));
    await expect(readCoworkFile(dir, 'folder.md')).rejects.toMatchObject({
      code: 'POLICY_REJECTED',
    });
  });
  it('collects flat top-level outputs, ignores internal DSH folders, and rejects nested output directories with a diagnostic', async () => {
    const dir = await fixture();
    await writeFile(join(dir, 'draft.md'), '# Draft');
    await mkdir(join(dir, 'tool-output'));
    await mkdir(join(dir, 'workers'));
    const collected = await collectCoworkOutputs(dir);
    expect(collected).toHaveLength(1);
    expect(collected[0]?.name).toBe('draft.md');

    await mkdir(join(dir, 'sub'));
    await writeFile(join(dir, 'sub', 'nested.md'), '# Nested');
    const warnings: { msg: string; fields?: Record<string, unknown> }[] = [];
    await expect(
      collectCoworkOutputs(dir, {
        warn: (msg, fields) => {
          warnings.push({ msg, ...(fields === undefined ? {} : { fields }) });
        },
      }),
    ).rejects.toMatchObject({
      code: 'POLICY_REJECTED',
      message: 'Cowork outputs must be flat top-level files in /work',
    });
    expect(warnings).toEqual([
      { msg: 'cowork nested scratch directory rejected', fields: { entry: 'sub' } },
    ]);
  });
  it.skipIf(process.platform === 'win32')(
    'refuses an output symlink to a synthetic host file',
    async () => {
      const dir = await fixture();
      const outside = await fixture();
      await writeFile(join(outside, 'secret.md'), 'synthetic');
      await symlink(join(outside, 'secret.md'), join(dir, 'draft.md'));
      await expect(readCoworkFile(dir, 'draft.md')).rejects.toMatchObject({
        code: 'POLICY_REJECTED',
      });
    },
  );
});
