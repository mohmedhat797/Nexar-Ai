import { mkdir, mkdtemp, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { LocalArtifactStore } from '@nexar/artifacts';
import { projectId, taskId } from '@nexar/contracts';
import { ProjectRegistry } from '@nexar/projects';
import { runCli } from './cli.js';
import type { CliIo } from './io.js';

function capture(cwd: string) {
  let out = '';
  let err = '';
  const io: CliIo = {
    stdout: (s) => (out += s),
    stderr: (s) => (err += s),
    env: { PATH: process.env['PATH'] ?? '' },
    cwd,
  };
  return { io, out: () => out, err: () => err };
}

const echo = {
  id: 'local-echo',
  displayName: 'Local Echo',
  kind: { type: 'model', provider: 'nexar', model: 'echo', access: 'local' },
  capabilities: ['text-generation'],
  runtime: { adapter: 'echo', locality: 'local' },
  auth: { mode: 'none' },
  cost: { model: 'free' },
  dataLocality: 'local',
};

describe('nexar artifacts list (in-process, offline)', () => {
  let dir: string;
  let work: string;

  beforeEach(async () => {
    dir = await realpath(await mkdtemp(join(tmpdir(), 'nexar-cli-art-')));
    work = join(dir, 'work');
    await mkdir(work);
    await writeFile(
      join(dir, 'nexar.config.json'),
      JSON.stringify({
        version: 1,
        resources: [echo],
        routing: { policy: 'deterministic', defaultResourceId: 'local-echo' },
        projects: [{ id: 'demo', displayName: 'Demo', roots: ['work'] }],
      }),
    );
    const projects = await ProjectRegistry.create([
      { id: projectId('demo'), displayName: 'Demo', roots: [work] },
    ]);
    const store = new LocalArtifactStore({ projects });
    const base = { projectId: projectId('demo'), taskId: taskId('task_1') };
    await store.store({
      ...base,
      filename: 'sow.md',
      content: '# SOW',
      mediaType: 'text/markdown',
    });
    await store.store({
      ...base,
      filename: 'email.txt',
      content: 'Hi',
      mediaType: 'text/plain',
      draft: true,
    });
  });
  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it('prints a table', async () => {
    const c = capture(dir);
    expect(await runCli(['artifacts', 'list', '--project', 'demo', '--task', 'task_1'], c.io)).toBe(
      0,
    );
    const lines = c.out().trimEnd().split('\n');
    expect(lines[0]).toMatch(/^LABEL\s+MEDIA TYPE\s+SIZE\s+DRAFT\s+SHA256\s+URI$/);
    expect(lines).toHaveLength(3);
    expect(lines[1]).toMatch(/drafts\/email\.md|drafts\/email\.txt/);
    expect(lines[1]).toMatch(/text\/plain\s+2\s+yes\s+[0-9a-f]{12}\s+file:\/\//);
    expect(lines[2]).toMatch(/text\/markdown\s+5\s+no\s+[0-9a-f]{12}\s+file:\/\//);
  });

  it('prints json', async () => {
    const c = capture(dir);
    expect(
      await runCli(['artifacts', 'list', '--project', 'demo', '--task', 'task_1', '--json'], c.io),
    ).toBe(0);
    const refs = JSON.parse(c.out()) as { label: string; sha256: string; draft: boolean }[];
    expect(refs).toHaveLength(2);
    expect(refs[1]?.sha256).toHaveLength(64);
    expect(refs.map((r) => r.draft)).toEqual([true, false]);
  });

  it('says so when there are no artifacts', async () => {
    const c = capture(dir);
    expect(await runCli(['artifacts', 'list', '--project', 'demo', '--task', 'other'], c.io)).toBe(
      0,
    );
    expect(c.out()).toBe('no artifacts\n');
  });

  it('fails with the error for an unknown project', async () => {
    const c = capture(dir);
    expect(await runCli(['artifacts', 'list', '--project', 'nope', '--task', 'task_1'], c.io)).toBe(
      1,
    );
    expect(c.err()).toContain('POLICY_REJECTED');
  });

  it('requires --project and --task', async () => {
    const c = capture(dir);
    expect(await runCli(['artifacts', 'list', '--project', 'demo'], c.io)).toBe(2);
    expect(c.err()).toContain('--task');
  });
});
