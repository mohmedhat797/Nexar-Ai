import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { projectId } from '@nexar/contracts';
import { ProjectRegistry } from '@nexar/projects';
import type { CoworkRequest } from '@nexar/operating';
import type { FileSessionStore } from '@nexar/sessions';
import type { EngineHost } from './engine-host.js';
import { loadCoworkInputs } from './cowork-inputs.js';

const dirs: string[] = [];
afterEach(async () => {
  await Promise.all(dirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});
describe('owner-approved Cowork inputs', () => {
  async function fixture() {
    const root = await mkdtemp(join(tmpdir(), 'sec02-inputs-'));
    dirs.push(root);
    const a = join(root, 'a'),
      b = join(root, 'b');
    await mkdir(a);
    await mkdir(b);
    await writeFile(join(a, 'approved.md'), 'APPROVED-SYNTHETIC');
    await writeFile(join(a, 'Project brief.md'), 'SPACE-NAME-SYNTHETIC');
    await writeFile(join(a, 'unselected.md'), 'UNSELECTED-SYNTHETIC');
    await writeFile(join(b, 'private.md'), 'OTHER-PROJECT-SYNTHETIC');
    const projects = await ProjectRegistry.create([
      {
        id: projectId('a'),
        displayName: 'A',
        roots: [a],
        documentSets: { cowork: [join(a, 'approved.md'), join(a, 'Project brief.md')] },
      },
      { id: projectId('b'), displayName: 'B', roots: [b] },
    ]);
    const engine = { composition: () => ({ runtime: { projects } }) } as unknown as EngineHost;
    return { engine, request: { projectId: 'a', sessionId: 's', turnId: 't' } as CoworkRequest };
  }
  it('copies only the configured document set, without mounting or including adjacent project files', async () => {
    const { engine, request } = await fixture();
    const files = await loadCoworkInputs(engine, undefined, request);
    expect(files).toHaveLength(2);
    expect(
      Buffer.from(
        files.find((file) => file.name.endsWith('-approved.md'))?.data ?? '',
        'base64',
      ).toString(),
    ).toBe('APPROVED-SYNTHETIC');
    expect(files.map((file) => file.name)).toEqual([
      'input-1-Project_brief.md',
      'input-2-approved.md',
    ]);
  });
  it('rejects a canonical session belonging to another project', async () => {
    const { engine, request } = await fixture();
    const sessions = {
      get: () => Promise.resolve({ projectId: 'b', turns: [] }),
    } as unknown as FileSessionStore;
    await expect(loadCoworkInputs(engine, sessions, request)).rejects.toMatchObject({
      code: 'POLICY_REJECTED',
    });
  });
});
