import { mkdir, mkdtemp, realpath, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { projectId } from '@nexar/contracts';
import { MAX_DOCUMENT_SET_FILES, ProjectRegistry } from './registry.js';
import type { ProjectDefinition } from './project.js';

const pid = projectId('demo');

describe('ProjectRegistry', () => {
  let base: string;
  let root: string;
  let outside: string;

  beforeEach(async () => {
    base = await realpath(await mkdtemp(join(tmpdir(), 'nexar-registry-')));
    root = join(base, 'allowed');
    outside = join(base, 'private-target');
    await mkdir(join(root, 'sub'), { recursive: true });
    await mkdir(outside);
    await writeFile(join(outside, 'secret.txt'), 'secret');
  });
  afterEach(async () => {
    await rm(base, { recursive: true, force: true });
  });

  const define = (extra: Partial<ProjectDefinition> = {}): ProjectDefinition => ({
    id: pid,
    displayName: 'Demo',
    roots: [root],
    ...extra,
  });

  async function rejectsWith(promise: Promise<unknown>, code: string): Promise<Error> {
    const error = await promise.then(
      () => undefined,
      (e: unknown) => e,
    );
    expect(error).toMatchObject({ code });
    const message = (error as Error).message;
    // Config errors name the configured path on purpose; policy rejections never do.
    if (code === 'POLICY_REJECTED') expect(message).not.toContain(base);
    return error as Error;
  }

  describe('create', () => {
    it('canonicalizes roots and defaults working directories to the roots', async () => {
      const reg = await ProjectRegistry.create([define()]);
      const project = reg.require(pid);
      expect(project.realRoots).toEqual([root]);
      expect(project.realWorkingDirectories).toEqual([root]);
    });

    it('accepts a root that is itself a symlink and stores its real path', async () => {
      await symlink(
        root,
        join(base, 'rootlink'),
        process.platform === 'win32' ? 'junction' : 'dir',
      );
      const reg = await ProjectRegistry.create([define({ roots: [join(base, 'rootlink')] })]);
      expect(reg.require(pid).realRoots).toEqual([root]);
      expect(await reg.resolveWorkingDirectory(reg.require(pid), join(root, 'sub'))).toBe(
        join(root, 'sub'),
      );
    });

    it('rejects a missing root with CONFIGURATION_ERROR', async () => {
      await expect(
        ProjectRegistry.create([define({ roots: [join(base, 'missing')] })]),
      ).rejects.toMatchObject({ code: 'CONFIGURATION_ERROR' });
    });

    it('rejects a working directory outside the roots (also via symlink)', async () => {
      await rejectsWith(
        ProjectRegistry.create([define({ workingDirectories: [outside] })]),
        'CONFIGURATION_ERROR',
      );
      await symlink(outside, join(root, 'link'), process.platform === 'win32' ? 'junction' : 'dir');
      await rejectsWith(
        ProjectRegistry.create([define({ workingDirectories: [join(root, 'link')] })]),
        'CONFIGURATION_ERROR',
      );
    });

    it('rejects duplicate ids and empty roots', async () => {
      await rejectsWith(ProjectRegistry.create([define(), define()]), 'CONFIGURATION_ERROR');
      await rejectsWith(ProjectRegistry.create([define({ roots: [] })]), 'CONFIGURATION_ERROR');
    });
  });

  describe('lookup', () => {
    it('get/list/empty', async () => {
      const reg = await ProjectRegistry.create([define()]);
      expect(reg.get(pid)?.displayName).toBe('Demo');
      expect(reg.get(projectId('other'))).toBeUndefined();
      expect(reg.list().map((p) => p.id)).toEqual([pid]);
      expect(ProjectRegistry.empty().list()).toEqual([]);
    });

    it('require rejects unknown projects without listing valid ids', async () => {
      const reg = await ProjectRegistry.create([define()]);
      expect(() => reg.require(projectId('nope'))).toThrow(
        expect.objectContaining({ code: 'POLICY_REJECTED', message: 'Unknown project' }) as Error,
      );
    });
  });

  describe('resolveWorkingDirectory', () => {
    it('defaults to the first real working directory', async () => {
      const reg = await ProjectRegistry.create([
        define({ workingDirectories: [join(root, 'sub')] }),
      ]);
      expect(await reg.resolveWorkingDirectory(reg.require(pid))).toBe(join(root, 'sub'));
    });

    it('accepts directories inside a working directory, absolute or relative', async () => {
      const reg = await ProjectRegistry.create([define()]);
      const project = reg.require(pid);
      expect(await reg.resolveWorkingDirectory(project, join(root, 'sub'))).toBe(join(root, 'sub'));
      expect(await reg.resolveWorkingDirectory(project, 'sub')).toBe(join(root, 'sub'));
      expect(await reg.resolveWorkingDirectory(project, root)).toBe(root);
    });

    it('allows a symlink inside pointing inside, returning the canonical path', async () => {
      await symlink(
        join(root, 'sub'),
        join(root, 'inner'),
        process.platform === 'win32' ? 'junction' : 'dir',
      );
      const reg = await ProjectRegistry.create([define()]);
      expect(await reg.resolveWorkingDirectory(reg.require(pid), join(root, 'inner'))).toBe(
        join(root, 'sub'),
      );
    });

    it('rejects the symlink attack, `..`, absolute outside, missing, dangling and loops', async () => {
      await symlink(outside, join(root, 'link'), process.platform === 'win32' ? 'junction' : 'dir');
      await symlink(
        join(base, 'gone'),
        join(root, 'dangling'),
        process.platform === 'win32' ? 'junction' : 'dir',
      );
      await symlink(
        join(root, 'l2'),
        join(root, 'l1'),
        process.platform === 'win32' ? 'junction' : 'dir',
      );
      await symlink(
        join(root, 'l1'),
        join(root, 'l2'),
        process.platform === 'win32' ? 'junction' : 'dir',
      );
      const reg = await ProjectRegistry.create([define()]);
      const project = reg.require(pid);
      for (const bad of [
        join(root, 'link'),
        join(root, '..', 'private-target'),
        outside,
        join(root, 'missing'),
        join(root, 'dangling'),
        join(root, 'l1'),
      ]) {
        await rejectsWith(reg.resolveWorkingDirectory(project, bad), 'POLICY_REJECTED');
      }
    });

    it('requires a directory, not a file', async () => {
      await writeFile(join(root, 'file.txt'), 'x');
      const reg = await ProjectRegistry.create([define()]);
      await rejectsWith(
        reg.resolveWorkingDirectory(reg.require(pid), join(root, 'file.txt')),
        'POLICY_REJECTED',
      );
    });

    it('is bounded by workingDirectories, not the wider roots', async () => {
      const reg = await ProjectRegistry.create([
        define({ workingDirectories: [join(root, 'sub')] }),
      ]);
      await rejectsWith(reg.resolveWorkingDirectory(reg.require(pid), root), 'POLICY_REJECTED');
    });
  });

  describe('resolveDocumentSet', () => {
    const setup = async (documentSets: Record<string, string[]>) => {
      const reg = await ProjectRegistry.create([define({ documentSets })]);
      return { reg, project: reg.require(pid) };
    };

    it('resolves files to references without content, with media types and labels', async () => {
      await writeFile(join(root, 'a.md'), '# secret body');
      await writeFile(join(root, 'b.unknown'), 'x');
      const { reg, project } = await setup({ docs: [join(root, 'a.md'), join(root, 'b.unknown')] });
      const refs = await reg.resolveDocumentSet(project, 'docs');
      expect(refs).toEqual([
        {
          uri: pathToFileURL(join(root, 'a.md')).href,
          label: 'a.md',
          mediaType: 'text/markdown',
        },
        { uri: pathToFileURL(join(root, 'b.unknown')).href, label: 'b.unknown' },
      ]);
      for (const ref of refs) {
        expect(Object.keys(ref).sort()).not.toContain('content');
        expect(JSON.stringify(ref)).not.toContain('secret body');
      }
    });

    it('maps the known extensions', async () => {
      const names = ['a.md', 'a.txt', 'a.pdf', 'a.docx', 'a.json', 'a.csv'];
      for (const name of names) await writeFile(join(root, name), '');
      const { reg, project } = await setup({ docs: names.map((n) => join(root, n)) });
      const refs = await reg.resolveDocumentSet(project, 'docs');
      const byName: Record<string, string | undefined> = {};
      for (const ref of refs) byName[ref.label ?? ''] = ref.mediaType;
      expect(byName).toEqual({
        'a.md': 'text/markdown',
        'a.txt': 'text/plain',
        'a.pdf': 'application/pdf',
        'a.docx': 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
        'a.json': 'application/json',
        'a.csv': 'text/csv',
      });
    });

    it('expands directories recursively, skipping dot-entries, sorted by uri, deduplicated', async () => {
      await mkdir(join(root, 'd', 'nested'), { recursive: true });
      await mkdir(join(root, 'd', '.git'));
      await writeFile(join(root, 'd', 'z.txt'), '');
      await writeFile(join(root, 'd', 'nested', 'a.txt'), '');
      await writeFile(join(root, 'd', '.hidden.txt'), '');
      await writeFile(join(root, 'd', '.git', 'config'), '');
      const { reg, project } = await setup({ docs: [join(root, 'd'), join(root, 'd', 'z.txt')] });
      const refs = await reg.resolveDocumentSet(project, 'docs');
      expect(refs.map((r) => r.label)).toEqual([join('d', 'nested', 'a.txt'), join('d', 'z.txt')]);
      expect(refs.map((r) => r.uri)).toEqual([...refs.map((r) => r.uri)].sort());
    });

    it('rejects a symlink inside a set directory that escapes the root', async (context) => {
      await mkdir(join(root, 'd'));
      try {
        await symlink(join(outside, 'secret.txt'), join(root, 'd', 'leak.txt'), 'file');
      } catch (error) {
        if (process.platform === 'win32' && (error as NodeJS.ErrnoException).code === 'EPERM') {
          context.skip(
            'Windows file symlinks require Developer Mode or SeCreateSymbolicLinkPrivilege',
          );
        }
        throw error;
      }
      const { reg, project } = await setup({ docs: [join(root, 'd')] });
      await rejectsWith(reg.resolveDocumentSet(project, 'docs'), 'POLICY_REJECTED');
    });

    it('rejects a symlinked directory escaping the root and does not follow one inside', async () => {
      await mkdir(join(root, 'd'));
      await symlink(
        outside,
        join(root, 'd', 'outlink'),
        process.platform === 'win32' ? 'junction' : 'dir',
      );
      const escaping = await setup({ docs: [join(root, 'd')] });
      await rejectsWith(
        escaping.reg.resolveDocumentSet(escaping.project, 'docs'),
        'POLICY_REJECTED',
      );

      await rm(join(root, 'd', 'outlink'), { recursive: true });
      await symlink(
        join(root, 'sub'),
        join(root, 'd', 'inlink'),
        process.platform === 'win32' ? 'junction' : 'dir',
      );
      await writeFile(join(root, 'sub', 'in-sub.txt'), '');
      const inside = await setup({ docs: [join(root, 'd')] });
      expect(await inside.reg.resolveDocumentSet(inside.project, 'docs')).toEqual([]);
    });

    it('rejects an entry outside the roots (configured path escaping)', async () => {
      const { reg, project } = await setup({ docs: [join(outside, 'secret.txt')] });
      await rejectsWith(reg.resolveDocumentSet(project, 'docs'), 'POLICY_REJECTED');
    });

    it('reports a missing entry as CONFIGURATION_ERROR naming the set and index, not the path', async () => {
      await writeFile(join(root, 'ok.md'), '');
      const { reg, project } = await setup({ docs: [join(root, 'ok.md'), join(root, 'gone.md')] });
      const error = await rejectsWith(
        reg.resolveDocumentSet(project, 'docs'),
        'CONFIGURATION_ERROR',
      );
      expect(error.message).toContain('"docs"');
      expect(error.message).toContain('entry 1');
      expect(error.message).not.toContain('gone.md');
    });

    it('rejects unknown sets (echoing the set name) including prototype keys', async () => {
      const { reg, project } = await setup({ docs: [root] });
      const error = await rejectsWith(reg.resolveDocumentSet(project, 'nope'), 'VALIDATION_ERROR');
      expect(error.message).toBe('Unknown document set "nope"');
      await rejectsWith(reg.resolveDocumentSet(project, 'constructor'), 'VALIDATION_ERROR');
    });

    it(`caps a set at ${String(MAX_DOCUMENT_SET_FILES)} files`, async () => {
      await mkdir(join(root, 'many'));
      await Promise.all(
        Array.from({ length: MAX_DOCUMENT_SET_FILES + 1 }, (_, i) =>
          writeFile(join(root, 'many', `f${String(i)}.txt`), ''),
        ),
      );
      const { reg, project } = await setup({ docs: [join(root, 'many')] });
      await rejectsWith(reg.resolveDocumentSet(project, 'docs'), 'VALIDATION_ERROR');
    });

    it('allows exactly the cap', async () => {
      await mkdir(join(root, 'many'));
      await Promise.all(
        Array.from({ length: MAX_DOCUMENT_SET_FILES }, (_, i) =>
          writeFile(join(root, 'many', `f${String(i)}.txt`), ''),
        ),
      );
      const { reg, project } = await setup({ docs: [join(root, 'many')] });
      expect(await reg.resolveDocumentSet(project, 'docs')).toHaveLength(MAX_DOCUMENT_SET_FILES);
    });
  });
});
