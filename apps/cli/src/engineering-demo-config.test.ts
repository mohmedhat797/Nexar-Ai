import { mkdtemp, readFile, realpath, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { parseConfig } from '@nexar/core';
import { ProjectRegistry } from '@nexar/projects';

const templatePath = fileURLToPath(
  new URL('../../../examples/engineering-demo/nexar.config.template.json', import.meta.url),
);

describe('examples/engineering-demo/nexar.config.template.json', () => {
  let repo: string;
  beforeEach(async () => {
    repo = await realpath(await mkdtemp(join(tmpdir(), 'nexar-demo-repo-')));
  });
  afterEach(async () => {
    await rm(repo, { recursive: true, force: true });
  });

  async function parsed() {
    // The same substitution `setup.sh` does.
    const text = (await readFile(templatePath, 'utf8')).replaceAll('__REPO__', repo);
    return parseConfig(JSON.parse(text), templatePath, { baseDir: repo });
  }

  it('parses with core once the repository path is substituted', async () => {
    const config = await parsed();
    expect(config.resources.map((r) => r.id)).toEqual(['claude-code', 'codex']);
    expect(config.resources.some((r) => r.runtime.adapter === 'echo')).toBe(false);
    expect(config.routing.defaultResourceId).toBe('claude-code');
    expect(config.engineering).toEqual({
      toolchainPaths: ['/opt/node22'],
      author: { name: 'Nexar', email: 'nexar@localhost' },
      approvalTtlMs: 1_800_000,
    });
  });

  it('leaves the credential mounts empty and holds credential references only', async () => {
    const config = await parsed();
    const claude = config.resources.find((r) => r.id === 'claude-code');
    expect(claude?.runtime.options).toEqual({ sandbox: { mounts: [] } });
    expect(
      config.resources.flatMap((r) => ('credential' in r.auth ? [r.auth.credential.source] : [])),
    ).toEqual(['runtime-managed', 'runtime-managed']);
  });

  it('declares the engineering-demo project with a gate, diverse review and owner approval', async () => {
    const config = await parsed();
    const registry = await ProjectRegistry.create(config.projects);
    const project = registry.require(config.projects[0]?.id ?? ('' as never));
    expect(project.id).toBe('engineering-demo');
    expect(project.realRoots).toEqual([repo]);
    expect(project.engineering).toMatchObject({
      baseBranch: 'main',
      repository: repo,
      gates: [{ name: 'test', command: ['node', '--test'], timeoutMs: 120_000 }],
      reviewDiversity: 'required',
      ownerApproval: 'always',
      maxReworkRounds: 1,
      lanePreferences: { feature: ['codex'], review: ['claude-code'] },
    });
  });
});
