import { mkdir, mkdtemp, readFile, realpath, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
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
  capabilities: ['text-generation', 'reasoning', 'knowledge-work', 'coding'],
  runtime: { adapter: 'echo', locality: 'local' },
  auth: { mode: 'none' },
  cost: { model: 'free' },
  dataLocality: 'local',
};
const second = { ...echo, id: 'second-echo', displayName: 'Second Echo' };

describe('nexar projects (in-process, offline)', () => {
  let dir: string;
  let work: string;
  let outside: string;

  beforeEach(async () => {
    dir = await realpath(await mkdtemp(join(tmpdir(), 'nexar-cli-proj-')));
    work = join(dir, 'work');
    outside = join(dir, 'private-target');
    await mkdir(join(work, 'docs'), { recursive: true });
    await mkdir(outside);
    await writeFile(join(work, 'README.md'), 'hello');
    await writeFile(join(work, 'docs', 'a.md'), 'a');
    await symlink(outside, join(work, 'link'), process.platform === 'win32' ? 'junction' : 'dir');
  });
  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  async function writeConfig(
    project: Record<string, unknown> = {},
    roots: string[] = ['work'],
  ): Promise<void> {
    await writeFile(
      join(dir, 'nexar.config.json'),
      JSON.stringify({
        version: 1,
        resources: [echo, second],
        routing: { policy: 'deterministic', defaultResourceId: 'local-echo' },
        telemetry: { jsonlPath: 'telemetry.jsonl' },
        projects: [
          {
            id: 'demo',
            displayName: 'Demo Project',
            roots,
            documentSets: { overview: ['README.md', 'docs'] },
            defaults: { capabilities: ['reasoning'] },
            ...project,
          },
        ],
      }),
    );
  }

  it('lists "no projects configured" with the default config', async () => {
    const c = capture(dir);
    expect(await runCli(['projects', 'list'], c.io)).toBe(0);
    expect(c.out()).toBe('no projects configured\n');
    const j = capture(dir);
    expect(await runCli(['--json', 'projects', 'list'], j.io)).toBe(0);
    expect(JSON.parse(j.out())).toEqual([]);
  });

  it('lists projects as text with canonical paths, document sets and defaults', async () => {
    await writeConfig();
    const c = capture(dir);
    expect(await runCli(['projects', 'list'], c.io)).toBe(0);
    expect(c.out()).toContain('demo  Demo Project');
    expect(c.out()).toContain(`roots:               ${work}`);
    expect(c.out()).toContain(`working directories: ${work}`);
    expect(c.out()).toContain('overview (2)');
    expect(c.out()).toContain('"capabilities":["reasoning"]');
  });

  it('lists projects as JSON', async () => {
    await writeConfig({ metadata: { owner: 'me' } });
    const c = capture(dir);
    expect(await runCli(['projects', 'list', '--json'], c.io)).toBe(0);
    expect(JSON.parse(c.out())).toEqual([
      {
        id: 'demo',
        displayName: 'Demo Project',
        roots: [work],
        workingDirectories: [work],
        documentSets: { overview: 2 },
        defaults: { capabilities: ['reasoning'] },
        metadata: { owner: 'me' },
      },
    ]);
  });

  it('exits 1 with CONFIGURATION_ERROR when a root cannot be canonicalized', async () => {
    await writeConfig({}, ['missing-root']);
    const c = capture(dir);
    expect(await runCli(['projects', 'list'], c.io)).toBe(1);
    expect(c.err()).toContain('error [CONFIGURATION_ERROR]');
  });

  it('requires the "list" subcommand', async () => {
    const c = capture(dir);
    expect(await runCli(['projects'], c.io)).toBe(2);
    expect(await runCli(['projects', 'remove'], capture(dir).io)).toBe(2);
  });

  it('run --project records the project id in telemetry', async () => {
    await writeConfig();
    const c = capture(dir);
    expect(await runCli(['run', '--kind', 'general', '--project', 'demo', 'hi'], c.io)).toBe(0);
    expect(c.out()).toBe('[echo:local-echo] hi\n');
    const events = (await readFile(join(dir, 'telemetry.jsonl'), 'utf8'))
      .trim()
      .split('\n')
      .map((l) => JSON.parse(l) as { type: string; record?: { projectId?: string } });
    expect(events.find((e) => e.type === 'execution.finished')?.record?.projectId).toBe('demo');
  });

  it('run --project --document-set attaches references; unknown set exits 1', async () => {
    await writeConfig();
    const ok = capture(dir);
    expect(
      await runCli(
        ['run', '--kind', 'general', '--project', 'demo', '--document-set', 'overview', 'hi'],
        ok.io,
      ),
    ).toBe(0);
    const bad = capture(dir);
    expect(
      await runCli(
        ['run', '--kind', 'general', '--project', 'demo', '--document-set', 'nope', 'hi'],
        bad.io,
      ),
    ).toBe(1);
    expect(bad.err()).toContain('Unknown document set "nope"');
  });

  it('--document-set without --project is a usage error', async () => {
    await writeConfig();
    const c = capture(dir);
    expect(
      await runCli(['run', '--kind', 'general', '--document-set', 'overview', 'hi'], c.io),
    ).toBe(2);
    expect(c.err()).toContain('--document-set requires --project');
  });

  it('an unknown --project is rejected without revealing known ids', async () => {
    await writeConfig();
    const c = capture(dir);
    expect(await runCli(['run', '--kind', 'general', '--project', 'nope', 'hi'], c.io)).toBe(1);
    expect(c.err()).toContain('error [POLICY_REJECTED]: Unknown project');
    expect(c.err()).not.toContain('demo');
  });

  it('run --project --cwd accepts a directory inside the project', async () => {
    await writeConfig();
    const c = capture(dir);
    expect(
      await runCli(
        ['run', '--kind', 'general', '--project', 'demo', '--cwd', 'work/docs', 'hi'],
        c.io,
      ),
    ).toBe(0);
  });

  it('run --project --cwd rejects the symlink attack and `..` escapes without echoing paths', async () => {
    await writeConfig();
    for (const cwd of ['work/link', 'work/../private-target']) {
      const c = capture(dir);
      expect(
        await runCli(['run', '--kind', 'general', '--project', 'demo', '--cwd', cwd, 'hi'], c.io),
      ).toBe(1);
      expect(c.err()).toContain('error [POLICY_REJECTED]');
      expect(c.err()).not.toContain('private-target');
      expect(c.out()).toBe('');
    }
  });

  it('run --cwd without a project is allowed (owner at their terminal)', async () => {
    await writeConfig();
    const c = capture(dir);
    expect(await runCli(['run', '--kind', 'general', '--cwd', 'work', 'hi'], c.io)).toBe(0);
    const missing = capture(dir);
    expect(await runCli(['run', '--kind', 'general', '--cwd', 'nope', 'hi'], missing.io)).toBe(1);
    expect(missing.err()).toContain('POLICY_REJECTED');
  });

  it('route --project merges defaults: an excluded resource is rejected with resource.excluded', async () => {
    await writeConfig({ defaults: { excludedResourceIds: ['local-echo'] } });
    const c = capture(dir);
    expect(await runCli(['route', '--kind', 'general', '--project', 'demo', 'hi'], c.io)).toBe(0);
    expect(c.out()).toContain('Selected resource: second-echo');
    expect(c.out()).toContain('resource.excluded');

    const all = capture(dir);
    expect(
      await runCli(
        ['route', '--kind', 'general', '--project', 'demo', '--exclude', 'second-echo', 'hi'],
        all.io,
      ),
    ).toBe(3);
    expect(all.out()).toContain('resource.excluded');
  });

  it('route --project with a local-only project routes without executing', async () => {
    await writeConfig({ defaults: { privacy: 'local-only' } });
    const c = capture(dir);
    expect(
      await runCli(['route', '--kind', 'general', '--project', 'demo', '--json', 'hi'], c.io),
    ).toBe(0);
    await expect(readFile(join(dir, 'telemetry.jsonl'), 'utf8')).resolves.toContain(
      'route.decided',
    );
  });
});
