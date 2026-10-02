import { cp, mkdir, mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { NexarError } from '@nexar/contracts';
import { PlanCatalog } from './plan.js';

const SHIPPED = fileURLToPath(new URL('../../../engineering/plans', import.meta.url));

describe('PlanCatalog (shipped plans)', () => {
  it('loads the three plans with the documented lane order', async () => {
    const catalog = await PlanCatalog.load(SHIPPED);
    expect(catalog.list().map((p) => p.id)).toEqual([
      'implement-review',
      'implement-test-review',
      'plan-implement-review',
    ]);
    const roles = (id: string) => catalog.require(id).lanes.map((l) => `${l.role}:${l.access}`);
    expect(roles('implement-review')).toEqual(['feature:read-write', 'review:read-only']);
    expect(roles('implement-test-review')).toEqual([
      'feature:read-write',
      'tests:read-write',
      'review:read-only',
    ]);
    expect(roles('plan-implement-review')).toEqual([
      'architecture:read-only',
      'feature:read-write',
      'review:read-only',
    ]);
  });

  it('gives every plan the shared debugging lane and trusted system prompts', async () => {
    const catalog = await PlanCatalog.load(SHIPPED);
    for (const plan of catalog.list()) {
      expect(plan.debugging.system).toMatch(/debugging lane/);
      expect(plan.lanes.every((l) => !l.system.includes('{{'))).toBe(true);
      expect(plan.lanes.at(-1)?.capabilities).toEqual(['code-review']);
    }
  });

  it('rejects an unknown plan id', async () => {
    const catalog = await PlanCatalog.load(SHIPPED);
    expect(catalog.get('nope')).toBeUndefined();
    expect(() => catalog.require('nope')).toThrow(/Unknown plan/);
  });
});

describe('PlanCatalog (validation)', () => {
  let dir: string;

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'nexar-plans-'));
    await cp(SHIPPED, dir, { recursive: true });
  });
  afterEach(() => rm(dir, { recursive: true, force: true }));

  const lane = (id: string, role: string, access: string, extra: Record<string, unknown> = {}) => ({
    id,
    role,
    access,
    taskKind: role === 'review' ? 'review' : 'coding',
    capabilities: ['coding'],
    system: 'feature.system.md',
    brief: 'feature.md',
    ...extra,
  });

  async function writePlan(lanes: unknown[], extra: Record<string, unknown> = {}): Promise<void> {
    await rm(join(dir, 'implement-review'), { recursive: true, force: true });
    await mkdir(join(dir, 'implement-review'));
    for (const f of ['feature.system.md', 'feature.md']) {
      await cp(join(SHIPPED, 'implement-review', f), join(dir, 'implement-review', f));
    }
    await writeFile(
      join(dir, 'implement-review', 'plan.json'),
      JSON.stringify({
        schemaVersion: 1,
        id: 'implement-review',
        displayName: 'x',
        description: 'y',
        lanes,
        ...extra,
      }),
    );
  }

  async function failure(): Promise<string> {
    try {
      await PlanCatalog.load(dir);
    } catch (error) {
      expect(error).toBeInstanceOf(NexarError);
      expect(error).toMatchObject({ code: 'CONFIGURATION_ERROR' });
      return (error as Error).message;
    }
    throw new Error('expected PlanCatalog.load to throw');
  }

  it('accepts a minimal valid plan', async () => {
    await writePlan([
      lane('feature', 'feature', 'read-write'),
      lane('review', 'review', 'read-only'),
    ]);
    expect((await PlanCatalog.load(dir)).require('implement-review').lanes).toHaveLength(2);
  });

  it('requires exactly one review lane', async () => {
    await writePlan([lane('feature', 'feature', 'read-write')]);
    expect(await failure()).toMatch(/exactly one review lane/);
    await writePlan([
      lane('feature', 'feature', 'read-write'),
      lane('r1', 'review', 'read-only'),
      lane('r2', 'review', 'read-only'),
    ]);
    expect(await failure()).toMatch(/exactly one review lane/);
  });

  it('requires the review lane to be last', async () => {
    await writePlan([
      lane('review', 'review', 'read-only'),
      lane('feature', 'feature', 'read-write'),
    ]);
    expect(await failure()).toMatch(/review lane must be last/);
  });

  it('requires at least one read-write lane', async () => {
    await writePlan([lane('review', 'review', 'read-only')]);
    expect(await failure()).toMatch(/at least one read-write lane/);
    await writePlan([
      lane('architecture', 'architecture', 'read-only'),
      lane('review', 'review', 'read-only'),
    ]);
    expect(await failure()).toMatch(/at least one read-write lane/);
  });

  it('requires the architecture lane to be first and unique', async () => {
    await writePlan([
      lane('feature', 'feature', 'read-write'),
      lane('architecture', 'architecture', 'read-only'),
      lane('review', 'review', 'read-only'),
    ]);
    expect(await failure()).toMatch(/architecture lane must be first/);
    await writePlan([
      lane('a1', 'architecture', 'read-only'),
      lane('a2', 'architecture', 'read-only'),
      lane('feature', 'feature', 'read-write'),
      lane('review', 'review', 'read-only'),
    ]);
    expect(await failure()).toMatch(/at most one architecture lane/);
  });

  it('does not allow debugging to be listed', async () => {
    await writePlan([
      lane('feature', 'feature', 'read-write'),
      lane('debugging', 'debugging', 'read-write'),
      lane('review', 'review', 'read-only'),
    ]);
    expect(await failure()).toMatch(/built-in rework lane/);
  });

  it('enforces the access mode of each role', async () => {
    await writePlan([
      lane('feature', 'feature', 'read-only'),
      lane('review', 'review', 'read-only'),
    ]);
    expect(await failure()).toMatch(/feature lane must be read-write/);
    await writePlan([
      lane('feature', 'feature', 'read-write'),
      lane('review', 'review', 'read-write'),
    ]);
    expect(await failure()).toMatch(/review lane must be read-only/);
  });

  it.each([
    ['an unknown role', lane('x', 'deploy', 'read-write'), /role must be one of/],
    [
      'an unknown key',
      lane('feature', 'feature', 'read-write', { shell: 'sh' }),
      /unknown key "shell"/,
    ],
    [
      'empty capabilities',
      lane('feature', 'feature', 'read-write', { capabilities: [] }),
      /capabilities/,
    ],
    ['a bad lane id', lane('Bad Id', 'feature', 'read-write'), /invalid lane id/],
    [
      'a missing template',
      lane('feature', 'feature', 'read-write', { brief: 'missing.md' }),
      /does not exist/,
    ],
    [
      'a path as template',
      lane('feature', 'feature', 'read-write', { brief: '../x.md' }),
      /plain Markdown file name/,
    ],
  ])('rejects %s', async (_name, bad, message) => {
    await writePlan([bad, lane('review', 'review', 'read-only')]);
    expect(await failure()).toMatch(message);
  });

  it('rejects duplicate lane ids, a wrong plan id and unknown plan keys', async () => {
    await writePlan([
      lane('feature', 'feature', 'read-write'),
      lane('feature', 'tests', 'read-write'),
      lane('review', 'review', 'read-only'),
    ]);
    expect(await failure()).toMatch(/duplicate lane id/);
    await writePlan(
      [lane('feature', 'feature', 'read-write'), lane('review', 'review', 'read-only')],
      {
        id: 'other',
      },
    );
    expect(await failure()).toMatch(/must equal its directory name/);
    await writePlan(
      [lane('feature', 'feature', 'read-write'), lane('review', 'review', 'read-only')],
      {
        hooks: [],
      },
    );
    expect(await failure()).toMatch(/unknown key "hooks"/);
    await writePlan(
      [lane('feature', 'feature', 'read-write'), lane('review', 'review', 'read-only')],
      {
        schemaVersion: 2,
      },
    );
    expect(await failure()).toMatch(/schemaVersion must be 1/);
  });

  it('rejects variables in a system template and unknown variables in a brief', async () => {
    await writePlan([
      lane('feature', 'feature', 'read-write'),
      lane('review', 'review', 'read-only'),
    ]);
    const system = join(dir, 'implement-review', 'feature.system.md');
    await writeFile(system, `${await readFile(system, 'utf8')}\n{{goal}}\n`);
    expect(await failure()).toMatch(/system template is trusted/);
    await cp(join(SHIPPED, 'implement-review', 'feature.system.md'), system);
    await writeFile(join(dir, 'implement-review', 'feature.md'), 'Do {{secrets}}');
    expect(await failure()).toMatch(/unknown variable "secrets"/);
  });

  it('rejects a template symlinked outside the plan directory', async (context) => {
    await writePlan([
      lane('feature', 'feature', 'read-write'),
      lane('review', 'review', 'read-only'),
    ]);
    const outside = join(dir, 'outside.md');
    await writeFile(outside, 'x');
    await rm(join(dir, 'implement-review', 'feature.md'));
    try {
      await symlink(outside, join(dir, 'implement-review', 'feature.md'), 'file');
    } catch (error) {
      if (process.platform === 'win32' && (error as NodeJS.ErrnoException).code === 'EPERM') {
        context.skip(
          'Windows file symlinks require Developer Mode or SeCreateSymbolicLinkPrivilege',
        );
      }
      throw error;
    }
    expect(await failure()).toMatch(/outside the plan directory/);
  });

  it('rejects invalid JSON, a missing _shared directory and a missing plans directory', async () => {
    await writePlan([
      lane('feature', 'feature', 'read-write'),
      lane('review', 'review', 'read-only'),
    ]);
    await writeFile(join(dir, 'implement-review', 'plan.json'), '{nope');
    expect(await failure()).toMatch(/not valid JSON/);
    await rm(join(dir, '_shared'), { recursive: true });
    expect(await failure()).toMatch(/_shared/);
    await expect(PlanCatalog.load(join(dir, 'absent'))).rejects.toMatchObject({
      code: 'CONFIGURATION_ERROR',
    });
  });
});
