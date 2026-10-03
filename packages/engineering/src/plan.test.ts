import { cp, mkdir, mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { NexarError } from '@nexar/contracts';
import { PlanCatalog } from './plan.js';

const SHIPPED = fileURLToPath(new URL('../../../engineering/plans', import.meta.url));

describe('PlanCatalog (shipped plans)', () => {
  it('loads the five plans with the documented lane order', async () => {
    const catalog = await PlanCatalog.load(SHIPPED);
    expect(catalog.list().map((p) => p.id)).toEqual([
      'implement-review',
      'implement-test-review',
      'implementation-plan',
      'plan-implement-review',
      'repository-report',
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
    expect(roles('repository-report')).toEqual(['report:read-only']);
    expect(roles('implementation-plan')).toEqual(['report:read-only']);
  });

  it('defaults to change mode; the shipped report plan is mode report', async () => {
    const catalog = await PlanCatalog.load(SHIPPED);
    expect(catalog.require('implement-review').mode).toBe('change');
    const report = catalog.require('repository-report');
    expect(report.mode).toBe('report');
    expect(report).not.toHaveProperty('debugging');
    expect(report.lanes[0]).toMatchObject({ taskKind: 'review', capabilities: ['code-review'] });
  });

  it('gives every change plan the shared debugging lane and every plan trusted system prompts', async () => {
    const catalog = await PlanCatalog.load(SHIPPED);
    for (const plan of catalog.list()) {
      if (plan.mode === 'change') expect(plan.debugging.system).toMatch(/debugging lane/);
      expect(plan.lanes.every((l) => !l.system.includes('{{'))).toBe(true);
      expect(plan.lanes.at(-1)?.capabilities).toEqual(
        plan.id === 'implementation-plan' ? ['coding', 'code-review'] : ['code-review'],
      );
    }
  });

  it('ships a read-only implementation-plan report plan for coding goals', async () => {
    const plan = (await PlanCatalog.load(SHIPPED)).require('implementation-plan');
    expect(plan.mode).toBe('report');
    expect(plan.lanes).toHaveLength(1);
    expect(plan.lanes[0]).toMatchObject({
      role: 'report',
      access: 'read-only',
      taskKind: 'coding',
      capabilities: ['coding', 'code-review'],
    });
    expect(plan.lanes[0]?.system).toMatch(/never modify/i);
    expect(plan.lanes[0]?.system).toMatch(/implementation plan/i);
    expect(plan.lanes[0]?.system).toMatch(/Files to touch/);
    expect(plan.lanes[0]?.brief.nodes.some((n) => n.kind === 'var' && n.name === 'goal')).toBe(
      true,
    );
  });

  it('keeps the report lane untrusted-input wrapping and read-only instructions', async () => {
    const plan = (await PlanCatalog.load(SHIPPED)).require('repository-report');
    expect(plan.lanes[0]?.system).toMatch(/never modify/i);
    expect(plan.lanes[0]?.system).toMatch(/untrusted/i);
    expect(plan.lanes[0]?.brief.nodes.some((n) => n.kind === 'var' && n.name === 'goal')).toBe(
      true,
    );
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

  describe('report mode', () => {
    const reportPlan = (lanes: unknown[], extra: Record<string, unknown> = {}) =>
      writePlan(lanes, { mode: 'report', ...extra });

    it('accepts an optional architecture lane followed by one report lane', async () => {
      await reportPlan([lane('report', 'report', 'read-only')]);
      const only = (await PlanCatalog.load(dir)).require('implement-review');
      expect(only.mode).toBe('report');
      await reportPlan([
        lane('architecture', 'architecture', 'read-only'),
        lane('report', 'report', 'read-only'),
      ]);
      expect((await PlanCatalog.load(dir)).require('implement-review').lanes).toHaveLength(2);
    });

    it('rejects read-write, feature, tests and review lanes', async () => {
      for (const bad of [
        lane('feature', 'feature', 'read-write'),
        lane('tests', 'tests', 'read-write'),
        lane('review', 'review', 'read-only'),
      ]) {
        await reportPlan([bad, lane('report', 'report', 'read-only')]);
        expect(await failure()).toMatch(/only have architecture and report lanes/);
      }
      await reportPlan([lane('report', 'report', 'read-write')]);
      expect(await failure()).toMatch(/report lane must be read-only/);
      await reportPlan([lane('architecture', 'architecture', 'read-write')]);
      expect(await failure()).toMatch(/architecture lane must be read-only/);
    });

    it('requires exactly one report lane, last', async () => {
      await reportPlan([lane('architecture', 'architecture', 'read-only')]);
      expect(await failure()).toMatch(/exactly one report lane/);
      await reportPlan([lane('r1', 'report', 'read-only'), lane('r2', 'report', 'read-only')]);
      expect(await failure()).toMatch(/exactly one report lane/);
      await reportPlan([
        lane('report', 'report', 'read-only'),
        lane('architecture', 'architecture', 'read-only'),
      ]);
      expect(await failure()).toMatch(/report lane must be last/);
    });

    it('rejects a change plan with a report lane, and an unknown mode', async () => {
      await writePlan([
        lane('feature', 'feature', 'read-write'),
        lane('report', 'report', 'read-only'),
        lane('review', 'review', 'read-only'),
      ]);
      expect(await failure()).toMatch(/only a report plan may have a report lane/);
      await writePlan([lane('report', 'report', 'read-only')], { mode: 'change' });
      expect(await failure()).toMatch(/only a report plan may have a report lane/);
      await writePlan([lane('report', 'report', 'read-only')], { mode: 'both' });
      expect(await failure()).toMatch(/mode must be "change" or "report"/);
    });
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
