import { mkdir, mkdtemp, realpath, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type {
  EngineeringWorkspace,
  ExecutionContext,
  ExecutionRequest,
  ExecutionResult,
  ProcessLauncher,
} from '@nexar/contracts';
import { EchoExecutionAdapter, echoResource } from '@nexar/integration-echo';
import { InMemoryTelemetrySink } from '@nexar/telemetry';
import { parseConfig } from './config.js';
import { createNexarWithProjects } from './create-nexar.js';

class ContextSpyAdapter extends EchoExecutionAdapter {
  readonly contexts: ExecutionContext[] = [];
  readonly requests: ExecutionRequest[] = [];
  override execute(request: ExecutionRequest, context: ExecutionContext): Promise<ExecutionResult> {
    this.requests.push(request);
    this.contexts.push(context);
    return super.execute(request, context);
  }
}

const launcher: ProcessLauncher = {
  isolation: 'sandbox',
  prepare: () => Promise.reject(new Error('not used')),
};

describe('engine: engineering workspace', () => {
  let base: string;
  let root: string;
  let worktree: string;

  beforeEach(async () => {
    base = await realpath(await mkdtemp(join(tmpdir(), 'nexar-ws-')));
    root = join(base, 'project');
    worktree = join(base, 'worktrees', 'demo', 'task-1', 'work');
    await mkdir(root, { recursive: true });
    await mkdir(worktree, { recursive: true });
  });
  afterEach(async () => {
    await rm(base, { recursive: true, force: true });
  });

  async function setup() {
    const config = parseConfig(
      {
        version: 1,
        resources: [echoResource()],
        routing: { policy: 'deterministic', defaultResourceId: 'local-echo' },
        projects: [{ id: 'demo', displayName: 'Demo', roots: [root] }],
      },
      'test',
    );
    const adapter = new ContextSpyAdapter();
    const sink = new InMemoryTelemetrySink();
    const runtime = await createNexarWithProjects(config, { adapters: [adapter], telemetry: sink });
    return { ...runtime, adapter, sink };
  }

  const ws = (path: string): EngineeringWorkspace => ({ path, access: 'read-write', launcher });

  it('passes the canonical workspace and its launcher to the adapter', async () => {
    await symlink(worktree, join(base, 'alias'), process.platform === 'win32' ? 'junction' : 'dir');
    const { nexar, adapter } = await setup();
    await nexar.run(nexar.createTask({ kind: 'coding', prompt: 'p', projectId: 'demo' }), {
      workspace: ws(join(base, 'alias')),
    });
    const passed = adapter.contexts[0]?.workspace;
    expect(passed?.path).toBe(worktree);
    expect(passed?.access).toBe('read-write');
    expect(passed?.launcher).toBe(launcher);
    // The project working directory is not applied to a workspace task.
    expect(adapter.requests[0]?.task.input.workingDirectory).toBeUndefined();
  });

  it('omits the workspace from the context for ordinary runs', async () => {
    const { nexar, adapter } = await setup();
    await nexar.run(nexar.createTask({ kind: 'general', prompt: 'p', projectId: 'demo' }));
    expect(adapter.contexts[0]?.workspace).toBeUndefined();
  });

  it('requires a project', async () => {
    const { nexar, adapter, sink } = await setup();
    await expect(
      nexar.run(nexar.createTask({ kind: 'coding', prompt: 'p' }), { workspace: ws(worktree) }),
    ).rejects.toMatchObject({ code: 'POLICY_REJECTED' });
    expect(adapter.requests).toHaveLength(0);
    expect(sink.events).toHaveLength(0);
  });

  it('rejects a task that also names a working directory', async () => {
    const { nexar, adapter } = await setup();
    const task = nexar.createTask({
      kind: 'coding',
      prompt: 'p',
      projectId: 'demo',
      workingDirectory: root,
    });
    await expect(nexar.run(task, { workspace: ws(worktree) })).rejects.toMatchObject({
      code: 'VALIDATION_ERROR',
    });
    expect(adapter.requests).toHaveLength(0);
  });

  it('rejects a missing or non-directory workspace without echoing the path', async () => {
    const file = join(base, 'secret-name.txt');
    await writeFile(file, 'x');
    const { nexar, adapter } = await setup();
    for (const path of [join(base, 'missing-dir'), file]) {
      const error: unknown = await nexar
        .run(nexar.createTask({ kind: 'coding', prompt: 'p', projectId: 'demo' }), {
          workspace: ws(path),
        })
        .then(
          () => undefined,
          (e: unknown) => e,
        );
      expect(error).toMatchObject({ code: 'POLICY_REJECTED' });
      expect((error as Error).message).not.toContain(base);
    }
    expect(adapter.requests).toHaveLength(0);
  });
});
