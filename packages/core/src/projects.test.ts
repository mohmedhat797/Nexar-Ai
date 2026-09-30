import { mkdir, mkdtemp, realpath, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  resourceId,
  type ExecutionContext,
  type ExecutionRequest,
  type ExecutionResult,
} from '@nexar/contracts';
import { EchoExecutionAdapter, echoResource } from '@nexar/integration-echo';
import { InMemoryTelemetrySink } from '@nexar/telemetry';
import { ProjectRegistry } from '@nexar/projects';
import { loadConfig, parseConfig, type NexarConfig } from './config.js';
import { createNexar, createNexarWithProjects } from './create-nexar.js';
import type { NexarDependencies } from './engine.js';

class SpyAdapter extends EchoExecutionAdapter {
  readonly executed: ExecutionRequest[] = [];
  override execute(request: ExecutionRequest, context: ExecutionContext): Promise<ExecutionResult> {
    this.executed.push(request);
    return super.execute(request, context);
  }
}

const baseConfig = {
  version: 1,
  resources: [
    echoResource(),
    echoResource({ id: resourceId('second-echo'), displayName: 'Second echo' }),
  ],
  routing: { policy: 'deterministic', defaultResourceId: 'local-echo' },
};

describe('config: projects', () => {
  const parse = (projects: unknown, baseDir = '/cfg') =>
    parseConfig({ ...baseConfig, projects }, 'test', { baseDir });
  const project = (extra: Record<string, unknown> = {}) => ({
    id: 'demo',
    displayName: 'Demo',
    roots: ['p'],
    ...extra,
  });

  it('defaults to no projects', () => {
    expect(parseConfig(baseConfig, 'test').projects).toEqual([]);
  });

  it('resolves relative paths against baseDir and keeps absolute ones', () => {
    const [p] = parse(
      [
        project({
          roots: ['p', '/abs/root', '../up'],
          workingDirectories: ['p/w'],
          documentSets: { docs: ['p/a.md', '/abs/b.md'] },
        }),
      ],
      '/cfg/dir',
    ).projects;
    expect(p?.roots).toEqual(['/cfg/dir/p', '/abs/root', '/cfg/up']);
    expect(p?.workingDirectories).toEqual(['/cfg/dir/p/w']);
    expect(p?.documentSets).toEqual({ docs: ['/cfg/dir/p/a.md', '/abs/b.md'] });
  });

  it('carries defaults and metadata', () => {
    const [p] = parse([
      project({
        defaults: { privacy: 'local-only', excludedResourceIds: ['second-echo'], maxCostUsd: 1 },
        metadata: { owner: 'me', n: 1, flag: true },
      }),
    ]).projects;
    expect(p?.defaults).toEqual({
      privacy: 'local-only',
      excludedResourceIds: ['second-echo'],
      maxCostUsd: 1,
    });
    expect(p?.metadata).toEqual({ owner: 'me', n: 1, flag: true });
  });

  it('rejects duplicate project ids', () => {
    expect(() => parse([project(), project()])).toThrow(
      expect.objectContaining({ code: 'CONFIGURATION_ERROR' }) as Error,
    );
  });

  it('rejects an invalid project id slug and document set name', () => {
    expect(() => parse([project({ id: 'Bad Id' })])).toThrow(/invalid project id/);
    expect(() => parse([project({ documentSets: { 'Bad Name': ['x'] } })])).toThrow(
      /CONFIGURATION|Invalid Nexar config/,
    );
  });

  it('rejects unknown keys, empty roots and empty document sets', () => {
    expect(() => parse([project({ extra: 1 })])).toThrow(/Invalid Nexar config/);
    expect(() => parse([project({ roots: [] })])).toThrow(/Invalid Nexar config/);
    expect(() => parse([project({ documentSets: { docs: [] } })])).toThrow(/Invalid Nexar config/);
    expect(() => parse([project({ defaults: { bogus: 1 } })])).toThrow(/Invalid Nexar config/);
  });

  it('rejects dangling resource ids in defaults', () => {
    expect(() => parse([project({ defaults: { preferredResourceIds: ['ghost'] } })])).toThrow(
      /unknown resource "ghost"/,
    );
    expect(() => parse([project({ defaults: { excludedResourceIds: ['ghost'] } })])).toThrow(
      /unknown resource "ghost"/,
    );
  });

  describe('loadConfig', () => {
    let dir: string;
    beforeEach(async () => {
      dir = await mkdtemp(join(tmpdir(), 'nexar-cfg-'));
    });
    afterEach(async () => {
      await rm(dir, { recursive: true, force: true });
    });

    it("resolves project paths against the config file's directory, not the cwd", async () => {
      await mkdir(join(dir, 'conf'));
      await writeFile(
        join(dir, 'conf', 'nexar.config.json'),
        JSON.stringify({ ...baseConfig, projects: [project({ roots: ['../work'] })] }),
      );
      const { config } = await loadConfig({
        explicitPath: join(dir, 'conf', 'nexar.config.json'),
        cwd: '/somewhere/else',
        env: {},
      });
      expect(config.projects[0]?.roots).toEqual([join(dir, 'work')]);
    });
  });
});

describe('engine: projects and working-directory policy', () => {
  let base: string;
  let root: string;
  let outside: string;

  beforeEach(async () => {
    base = await realpath(await mkdtemp(join(tmpdir(), 'nexar-engine-')));
    root = join(base, 'allowed');
    outside = join(base, 'private-target');
    await mkdir(join(root, 'sub'), { recursive: true });
    await mkdir(outside);
  });
  afterEach(async () => {
    await rm(base, { recursive: true, force: true });
  });

  async function setup(
    options: {
      policy?: NexarDependencies['workingDirectoryPolicy'];
      defaults?: Record<string, unknown>;
    } = {},
  ) {
    const config: NexarConfig = parseConfig(
      {
        ...baseConfig,
        projects: [
          {
            id: 'demo',
            displayName: 'Demo',
            roots: [root],
            ...(options.defaults === undefined ? {} : { defaults: options.defaults }),
          },
        ],
      },
      'test',
    );
    const adapter = new SpyAdapter();
    const sink = new InMemoryTelemetrySink();
    const runtime = await createNexarWithProjects(config, {
      adapters: [adapter],
      telemetry: sink,
      ...(options.policy === undefined ? {} : { workingDirectoryPolicy: options.policy }),
    });
    return { ...runtime, adapter, sink };
  }

  describe('createTask', () => {
    it('sets projectId, merges defaults and keeps workingDirectory unvalidated', async () => {
      const { nexar } = await setup({
        defaults: { capabilities: ['reasoning'], privacy: 'local-only', maxCostUsd: 2 },
      });
      const task = nexar.createTask({
        kind: 'general',
        prompt: 'p',
        projectId: 'demo',
        workingDirectory: '/not/checked/yet',
        requirements: { capabilities: ['coding'], privacy: 'standard', maxCostUsd: 5 },
        attachments: [{ uri: 'file:///x' }],
      });
      expect(task.projectId).toBe('demo');
      expect(task.requirements).toEqual({
        capabilities: ['reasoning', 'coding'],
        privacy: 'local-only',
        maxCostUsd: 2,
      });
      expect(task.input.workingDirectory).toBe('/not/checked/yet');
      expect(task.input.attachments).toEqual([{ uri: 'file:///x' }]);
    });

    it('throws POLICY_REJECTED for an unknown project', async () => {
      const { nexar } = await setup();
      expect(() => nexar.createTask({ kind: 'general', prompt: 'p', projectId: 'nope' })).toThrow(
        expect.objectContaining({ code: 'POLICY_REJECTED' }) as Error,
      );
    });

    it('leaves requirements untouched without a project', async () => {
      const { nexar } = await setup();
      const task = nexar.createTask({ kind: 'general', prompt: 'p' });
      expect(task.projectId).toBeUndefined();
      expect(task.requirements).toEqual({ capabilities: [] });
    });

    it('a project that excludes a resource makes route skip it', async () => {
      const { nexar } = await setup({ defaults: { excludedResourceIds: ['local-echo'] } });
      const decision = await nexar.route(
        nexar.createTask({ kind: 'general', prompt: 'p', projectId: 'demo' }),
      );
      expect(decision.outcome).toBe('selected');
      if (decision.outcome === 'selected') {
        expect(decision.selected.resourceId).toBe('second-echo');
      }
    });
  });

  describe('run with a project', () => {
    it('defaults to the first working directory and records the project id', async () => {
      const { nexar, adapter, sink } = await setup();
      const outcome = await nexar.run(
        nexar.createTask({ kind: 'general', prompt: 'p', projectId: 'demo' }),
      );
      expect(adapter.executed[0]?.task.input.workingDirectory).toBe(root);
      expect(outcome.record.projectId).toBe('demo');
      expect(sink.records()[0]?.projectId).toBe('demo');
    });

    it('passes the canonical path onward, not the input', async () => {
      await symlink(join(root, 'sub'), join(root, 'inner'));
      const { nexar, adapter } = await setup();
      const task = nexar.createTask({
        kind: 'general',
        prompt: 'p',
        projectId: 'demo',
        workingDirectory: join(root, 'inner'),
      });
      const outcome = await nexar.run(task);
      expect(adapter.executed[0]?.task.input.workingDirectory).toBe(join(root, 'sub'));
      expect(outcome.task.input.workingDirectory).toBe(join(root, 'sub'));
      expect(task.input.workingDirectory).toBe(join(root, 'inner'));
    });

    it('rejects the symlink attack and never calls the adapter or emits events', async () => {
      await symlink(outside, join(root, 'link'));
      const { nexar, adapter, sink } = await setup();
      const task = nexar.createTask({
        kind: 'general',
        prompt: 'p',
        projectId: 'demo',
        workingDirectory: join(root, 'link'),
      });
      const error = await nexar.run(task).then(
        () => undefined,
        (e: unknown) => e,
      );
      expect(error).toMatchObject({ code: 'POLICY_REJECTED' });
      expect(
        JSON.stringify({
          m: (error as Error).message,
          d: (error as { details?: unknown }).details,
        }),
      ).not.toContain('private-target');
      expect(adapter.executed).toHaveLength(0);
      expect(sink.events).toHaveLength(0);
    });

    it.each([
      ['a `..` escape', (): string => join(root, '..', 'private-target')],
      ['an absolute outside path', (): string => outside],
      ['a nonexistent path', (): string => join(root, 'missing')],
      ['a file instead of a directory', (): string => join(root, 'file.txt')],
    ])('rejects %s before execution', async (_name, path) => {
      await writeFile(join(root, 'file.txt'), 'x');
      const { nexar, adapter, sink } = await setup();
      const task = nexar.createTask({
        kind: 'general',
        prompt: 'p',
        projectId: 'demo',
        workingDirectory: path(),
      });
      await expect(nexar.run(task)).rejects.toMatchObject({ code: 'POLICY_REJECTED' });
      expect(adapter.executed).toHaveLength(0);
      expect(sink.events).toHaveLength(0);
    });

    it('rejects a task whose project id is unknown at run time', async () => {
      const { nexar, adapter } = await setup();
      const task = {
        ...nexar.createTask({ kind: 'general', prompt: 'p' }),
        projectId: 'ghost' as never,
      };
      await expect(nexar.run(task)).rejects.toMatchObject({ code: 'POLICY_REJECTED' });
      expect(adapter.executed).toHaveLength(0);
    });

    it('route stays path-agnostic and side-effect free', async () => {
      const { nexar, adapter } = await setup();
      const task = nexar.createTask({
        kind: 'general',
        prompt: 'p',
        projectId: 'demo',
        workingDirectory: '/definitely/not/allowed',
      });
      expect((await nexar.route(task)).outcome).toBe('selected');
      expect(adapter.executed).toHaveLength(0);
    });
  });

  describe('run without a project', () => {
    it("'project-only' (the default) rejects any working directory", async () => {
      const { nexar, adapter, sink } = await setup();
      const task = nexar.createTask({ kind: 'general', prompt: 'p', workingDirectory: root });
      await expect(nexar.run(task)).rejects.toMatchObject({ code: 'POLICY_REJECTED' });
      expect(adapter.executed).toHaveLength(0);
      expect(sink.events).toHaveLength(0);
    });

    it("'project-only' still runs tasks that name no working directory", async () => {
      const { nexar, adapter } = await setup();
      await nexar.run(nexar.createTask({ kind: 'general', prompt: 'p' }));
      expect(adapter.executed).toHaveLength(1);
    });

    it("'project-or-unscoped' canonicalizes the directory", async () => {
      await symlink(join(root, 'sub'), join(root, 'inner'));
      const { nexar, adapter } = await setup({ policy: 'project-or-unscoped' });
      await nexar.run(
        nexar.createTask({ kind: 'general', prompt: 'p', workingDirectory: join(root, 'inner') }),
      );
      expect(adapter.executed[0]?.task.input.workingDirectory).toBe(join(root, 'sub'));
    });

    it("'project-or-unscoped' fails closed when the path cannot be resolved", async () => {
      const { nexar, adapter } = await setup({ policy: 'project-or-unscoped' });
      const task = nexar.createTask({
        kind: 'general',
        prompt: 'p',
        workingDirectory: join(base, 'missing'),
      });
      const error = await nexar.run(task).then(
        () => undefined,
        (e: unknown) => e,
      );
      expect(error).toMatchObject({ code: 'POLICY_REJECTED' });
      expect((error as Error).message).not.toContain(base);
      expect(adapter.executed).toHaveLength(0);
    });

    it('a project still constrains the task under project-or-unscoped', async () => {
      await symlink(outside, join(root, 'link'));
      const { nexar, adapter } = await setup({ policy: 'project-or-unscoped' });
      const task = nexar.createTask({
        kind: 'general',
        prompt: 'p',
        projectId: 'demo',
        workingDirectory: join(root, 'link'),
      });
      await expect(nexar.run(task)).rejects.toMatchObject({ code: 'POLICY_REJECTED' });
      expect(adapter.executed).toHaveLength(0);
    });
  });

  describe('createNexar', () => {
    it('keeps its signature: no projects option means an empty registry and project-only', async () => {
      const adapter = new SpyAdapter();
      const runtime = createNexar(parseConfig(baseConfig, 'test'), { adapters: [adapter] });
      expect(runtime.projects.list()).toEqual([]);
      const task = runtime.nexar.createTask({
        kind: 'general',
        prompt: 'p',
        workingDirectory: root,
      });
      await expect(runtime.nexar.run(task)).rejects.toMatchObject({ code: 'POLICY_REJECTED' });
      expect(() =>
        runtime.nexar.createTask({ kind: 'general', prompt: 'p', projectId: 'demo' }),
      ).toThrow();
    });

    it('accepts a prebuilt ProjectRegistry', async () => {
      const projects = await ProjectRegistry.create([
        { id: 'demo' as never, displayName: 'Demo', roots: [root] },
      ]);
      const runtime = createNexar(parseConfig(baseConfig, 'test'), {
        adapters: [new SpyAdapter()],
        projects,
      });
      expect(runtime.projects).toBe(projects);
    });
  });
});
