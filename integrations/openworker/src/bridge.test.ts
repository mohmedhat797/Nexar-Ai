import { mkdir, mkdtemp, readFile, realpath, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { LocalArtifactStore } from '@nexar/artifacts';
import {
  NexarError,
  resourceId,
  measured,
  taskId,
  unavailable,
  type LogFields,
  type Logger,
  type NexarTask,
} from '@nexar/contracts';
import {
  createNexarWithProjects,
  parseConfig,
  type NewTaskInput,
  type NexarRuntime,
  type RunOutcome,
} from '@nexar/core';
import { EchoExecutionAdapter, echoResource } from '@nexar/integration-echo';
import { ProjectRegistry } from '@nexar/projects';
import {
  MAX_JOBS,
  WORK_BRIDGE_VERSION,
  WorkRequestSchema,
  createWorkBridge,
  workRequestJsonSchema,
  type WorkBridge,
  type WorkBridgeOptions,
  type WorkEngine,
} from './index.js';

const SECRET = 'TOP-SECRET-PROMPT-TEXT';

function capturingLogger(lines: string[]): Logger {
  const make = (bindings: LogFields): Logger => {
    const log = (level: string, msg: string, fields?: LogFields): void => {
      lines.push(JSON.stringify({ level, msg, ...bindings, ...fields }));
    };
    return {
      debug: (m, f) => log('debug', m, f),
      info: (m, f) => log('info', m, f),
      warn: (m, f) => log('warn', m, f),
      error: (m, f) => log('error', m, f),
      child: (b) => make({ ...bindings, ...b }),
    };
  };
  return make({});
}

interface Stub {
  readonly engine: WorkEngine;
  readonly created: NewTaskInput[];
  readonly runs: { task: NexarTask; signal?: AbortSignal; timeoutMs?: number }[];
  readonly recorded: unknown[];
}

function stubEngine(behavior: () => Promise<void> = () => Promise.resolve()): Stub {
  const created: NewTaskInput[] = [];
  const runs: Stub['runs'] = [];
  const recorded: unknown[] = [];
  let counter = 0;
  const engine: WorkEngine = {
    createTask(input) {
      created.push(input);
      counter += 1;
      return {
        id: taskId(`task-${String(counter)}`),
        kind: input.kind,
        input: { prompt: input.prompt },
        requirements: { capabilities: [], ...input.requirements },
        ...(input.projectId === undefined ? {} : { projectId: input.projectId as never }),
        origin: input.origin ?? { source: 'cli' },
        createdAt: '2026-01-01T00:00:00.000Z',
      };
    },
    async run(task, options) {
      runs.push({
        task,
        ...(options?.signal === undefined ? {} : { signal: options.signal }),
        ...(options?.timeoutMs === undefined ? {} : { timeoutMs: options.timeoutMs }),
      });
      await behavior();
      return {
        task,
        decision: {
          outcome: 'selected',
          taskId: task.id,
          selected: {
            resourceId: resourceId('res-a'),
            eligible: true,
            score: 1,
            reasons: [{ code: 'default.match', effect: 'supports', message: 'default resource' }],
          },
          alternatives: [],
          rejected: [],
          policy: { name: 'deterministic', version: '1' },
          decidedAt: '2026-01-01T00:00:00.000Z',
        },
        result: {
          text: 'the answer',
          artifacts: [],
          usage: {
            inputTokens: measured(10),
            outputTokens: measured(20),
            costUsd: unavailable('unpriced'),
            turns: measured(1),
          },
          resolved: {},
          retries: 0,
        },
        record: {} as RunOutcome['record'],
      };
    },
    recordArtifacts(forTask, forProject, artifacts) {
      recorded.push({ forTask, forProject, artifacts });
      return Promise.resolve();
    },
  };
  return { engine, created, runs, recorded };
}

const valid = (overrides: Record<string, unknown> = {}): Record<string, unknown> => ({
  version: 2,
  requestId: 'req-1',
  source: 'openworker',
  project: 'proj',
  taskKind: 'analysis',
  request: 'summarize this',
  ...overrides,
});

function deferred(): { promise: Promise<void>; resolve: () => void } {
  let resolve!: () => void;
  const promise = new Promise<void>((r) => {
    resolve = r;
  });
  return { promise, resolve };
}

describe('Work Bridge v2 with a stub engine', () => {
  let base: string;
  let projects: ProjectRegistry;
  let store: LocalArtifactStore;

  beforeEach(async () => {
    base = await realpath(await mkdtemp(join(tmpdir(), 'nexar-bridge-stub-')));
    await mkdir(join(base, 'docs'));
    await writeFile(join(base, 'docs', 'a.md'), 'alpha');
    await writeFile(join(base, 'docs', 'b.md'), 'beta');
    projects = await ProjectRegistry.create([
      {
        id: 'proj' as never,
        displayName: 'Proj',
        roots: [base],
        documentSets: { notes: [join(base, 'docs')], one: [join(base, 'docs', 'a.md')] },
      },
    ]);
    store = new LocalArtifactStore({ projects });
  });
  afterEach(async () => {
    await rm(base, { recursive: true, force: true });
  });

  function bridge(stub: Stub, extra: Partial<WorkBridgeOptions> = {}): WorkBridge {
    return createWorkBridge({ engine: stub.engine, projects, artifacts: store, ...extra });
  }

  it('completes a valid request with route, explanation and usage', async () => {
    const stub = stubEngine();
    const res = await bridge(stub).submit(valid());
    expect(res).toMatchObject({
      version: WORK_BRIDGE_VERSION,
      requestId: 'req-1',
      status: 'completed',
      taskId: 'task-1',
      output: { text: 'the answer' },
      route: { resourceId: 'res-a', policy: 'deterministic', reasonCodes: ['default.match'] },
      usage: {
        inputTokens: { status: 'measured', value: 10 },
        outputTokens: { status: 'measured', value: 20 },
        costUsd: { status: 'unavailable', reason: 'unpriced' },
      },
    });
    expect(res.route?.explanation).toContain('Selected resource: res-a');
    expect(res.artifacts).toBeUndefined();
    expect(res.error).toBeUndefined();
  });

  it('maps the request onto a Nexar task', async () => {
    const stub = stubEngine();
    const controller = new AbortController();
    await bridge(stub, { timeoutMs: 5000 }).submit(
      valid({
        requestedBy: 'alice',
        systemPrompt: 'be brief',
        workingDirectory: 'sub',
        constraints: {
          capabilities: ['coding'],
          privacy: 'local-only',
          maxCostUsd: 0.5,
          preferredResourceIds: ['a'],
          excludedResourceIds: ['b'],
        },
      }),
      { signal: controller.signal },
    );
    expect(stub.created[0]).toEqual({
      kind: 'analysis',
      prompt: 'summarize this',
      systemPrompt: 'be brief',
      projectId: 'proj',
      workingDirectory: 'sub',
      origin: {
        source: 'openworker',
        project: 'proj',
        correlationId: 'req-1',
        requestedBy: 'alice',
      },
      requirements: {
        capabilities: ['coding'],
        privacy: 'local-only',
        maxCostUsd: 0.5,
        preferredResourceIds: ['a'],
        excludedResourceIds: ['b'],
      },
      metadata: { bridge: 'openworker', bridgeVersion: 2 },
    });
    expect(stub.runs[0]?.signal).toBe(controller.signal);
    expect(stub.runs[0]?.timeoutMs).toBe(5000);
  });

  it('defaults capabilities to an empty list', async () => {
    const stub = stubEngine();
    await bridge(stub).submit(valid());
    expect(stub.created[0]?.requirements).toEqual({ capabilities: [] });
  });

  it('rejects unknown keys with the offending path', async () => {
    const stub = stubEngine();
    const res = await bridge(stub).submit(valid({ extra: 1, constraints: { nope: true } }));
    expect(res.status).toBe('rejected');
    expect(res.requestId).toBe('req-1');
    expect(res.error?.code).toBe('VALIDATION_ERROR');
    expect(res.error?.retryable).toBe(false);
    const paths = res.error?.issues?.map((i) => i.path) ?? [];
    expect(paths).toContain('');
    expect(paths).toContain('constraints');
    expect(stub.runs).toHaveLength(0);
  });

  it('requires a project', async () => {
    const stub = stubEngine();
    const withoutProject = valid();
    delete withoutProject['project'];
    const res = await bridge(stub).submit(withoutProject);
    expect(res.status).toBe('rejected');
    expect(res.error?.code).toBe('VALIDATION_ERROR');
    expect(res.error?.issues?.map((i) => i.path)).toContain('project');
    expect(stub.created).toHaveLength(0);
  });

  describe('field limits', () => {
    const cases: [string, Record<string, unknown>, string][] = [
      ['v1 version', { version: 1 }, 'version'],
      ['empty requestId', { requestId: '' }, 'requestId'],
      ['requestId charset', { requestId: 'a b' }, 'requestId'],
      ['long requestId', { requestId: 'a'.repeat(129) }, 'requestId'],
      ['taskKind charset', { taskKind: 'Bad_Kind' }, 'taskKind'],
      ['long taskKind', { taskKind: 'a'.repeat(65) }, 'taskKind'],
      ['empty project', { project: '' }, 'project'],
      ['long project', { project: 'p'.repeat(129) }, 'project'],
      ['empty request', { request: '' }, 'request'],
      ['long request', { request: 'x'.repeat(100_001) }, 'request'],
      ['long systemPrompt', { systemPrompt: 's'.repeat(20_001) }, 'systemPrompt'],
      [
        'too many capabilities',
        { constraints: { capabilities: Array.from({ length: 17 }, () => 'coding') } },
        'constraints.capabilities',
      ],
      ['bad capability', { constraints: { capabilities: ['Bad'] } }, 'constraints.capabilities.0'],
      ['bad privacy', { constraints: { privacy: 'public' } }, 'constraints.privacy'],
      ['negative cost', { constraints: { maxCostUsd: -1 } }, 'constraints.maxCostUsd'],
      [
        'bad preferred id',
        { constraints: { preferredResourceIds: ['Bad Id'] } },
        'constraints.preferredResourceIds.0',
      ],
      [
        'bad excluded id',
        { constraints: { excludedResourceIds: ['ok', ''] } },
        'constraints.excludedResourceIds.1',
      ],
      ['NUL in workingDirectory', { workingDirectory: 'a\0b' }, 'workingDirectory'],
      ['empty workingDirectory', { workingDirectory: '' }, 'workingDirectory'],
      [
        'too many document sets',
        { documentSets: Array.from({ length: 9 }, (_, i) => `set${String(i)}`) },
        'documentSets',
      ],
      ['empty document set name', { documentSets: [''] }, 'documentSets.0'],
      ['empty output filename', { output: { filename: '' } }, 'output.filename'],
      ['long output filename', { output: { filename: 'f'.repeat(101) } }, 'output.filename'],
      [
        'unsupported output media type',
        { output: { filename: 'a', mediaType: 'text/html' } },
        'output.mediaType',
      ],
      ['unknown output key', { output: { filename: 'a', path: '/x' } }, 'output'],
      ['long requestedBy', { requestedBy: 'r'.repeat(129) }, 'requestedBy'],
      ['workflow must be an object', { workflow: 'x' }, 'workflow'],
      ['workflow id charset', { workflow: { id: 'Bad_Id', inputs: {} } }, 'workflow.id'],
      [
        'workflow input name charset',
        { workflow: { id: 'sow', inputs: { 'a b': 'x' } } },
        'workflow.inputs.a b',
      ],
      [
        'workflow input value type',
        { workflow: { id: 'sow', inputs: { a: 5 } } },
        'workflow.inputs.a',
      ],
      ['unknown workflow key', { workflow: { id: 'sow', inputs: {}, extra: 1 } }, 'workflow'],
    ];

    it.each(cases)('%s', async (_name, overrides, path) => {
      const stub = stubEngine();
      const res = await bridge(stub).submit(valid(overrides));
      expect(res.status).toBe('rejected');
      expect(res.error?.code).toBe('VALIDATION_ERROR');
      expect(res.error?.issues?.map((i) => i.path)).toContain(path);
      expect(stub.runs).toHaveLength(0);
    });

    it('honors a custom maxRequestChars', async () => {
      const stub = stubEngine();
      const res = await bridge(stub, { maxRequestChars: 5 }).submit(valid({ request: 'abcdef' }));
      expect(res.status).toBe('rejected');
      expect(res.error?.issues?.[0]?.path).toBe('request');
    });

    it('accepts a relative and an absolute workingDirectory (the engine enforces it)', async () => {
      const stub = stubEngine();
      const b = bridge(stub);
      expect((await b.submit(valid({ workingDirectory: 'sub/dir' }))).status).toBe('completed');
      expect(
        (await b.submit(valid({ requestId: 'req-2', workingDirectory: '/srv/../etc' }))).status,
      ).toBe('completed');
      expect(stub.created.map((c) => c.workingDirectory)).toEqual(['sub/dir', '/srv/../etc']);
    });
  });

  it('rejects a disallowed source with POLICY_REJECTED', async () => {
    const stub = stubEngine();
    const res = await bridge(stub).submit(valid({ source: 'mobile' }));
    expect(res.status).toBe('rejected');
    expect(res.error?.code).toBe('POLICY_REJECTED');
    expect(stub.runs).toHaveLength(0);
    const allowed = await bridge(stub, { allowedSources: ['mobile'] }).submit(
      valid({ source: 'mobile' }),
    );
    expect(allowed.status).toBe('completed');
  });

  it('rejects an unknown project with POLICY_REJECTED before any task exists', async () => {
    const stub = stubEngine();
    const res = await bridge(stub).submit(valid({ project: 'nope' }));
    expect(res.status).toBe('rejected');
    expect(res.error?.code).toBe('POLICY_REJECTED');
    expect(res.error?.message).toBe('Unknown project');
    expect(stub.created).toHaveLength(0);
    const malformed = await bridge(stub).submit(valid({ project: 'Bad Project!' }));
    expect(malformed.status).toBe('rejected');
    expect(malformed.error?.code).toBe('POLICY_REJECTED');
  });

  describe('authorize hook', () => {
    it('sees the validated request, and runs before project lookup and task creation', async () => {
      const stub = stubEngine();
      const seen: unknown[] = [];
      const res = await bridge(stub).submit(
        valid({ project: 'nope', documentSets: ['notes'], constraints: { maxCostUsd: 2 } }),
        {
          authorize: (request) => {
            seen.push(request);
            throw new NexarError('POLICY_REJECTED', 'Not permitted for this client');
          },
        },
      );
      expect(seen).toEqual([
        {
          requestId: 'req-1',
          source: 'openworker',
          project: 'nope',
          taskKind: 'analysis',
          documentSets: ['notes'],
          maxCostUsd: 2,
        },
      ]);
      expect(res.status).toBe('rejected');
      expect(res.error?.code).toBe('POLICY_REJECTED');
      expect(res.error?.message).toBe('Not permitted for this client');
      expect(stub.created).toHaveLength(0);
      expect(stub.runs).toHaveLength(0);
    });

    it('passes through the code it throws', async () => {
      const res = await bridge(stubEngine()).submit(valid(), {
        authorize: () => {
          throw new NexarError('AUTH_REQUIRED', 'Authentication failed');
        },
      });
      expect(res.status).toBe('rejected');
      expect(res.error?.code).toBe('AUTH_REQUIRED');
    });

    it('fails closed when the hook throws something else', async () => {
      const stub = stubEngine();
      const res = await bridge(stub).submit(valid(), {
        authorize: () => {
          throw new TypeError('secret detail');
        },
      });
      expect(res.status).toBe('rejected');
      expect(res.error?.code).toBe('POLICY_REJECTED');
      expect(JSON.stringify(res)).not.toContain('secret detail');
      expect(stub.created).toHaveLength(0);
    });

    it('is not called for invalid requests', async () => {
      let called = false;
      const res = await bridge(stubEngine()).submit(valid({ request: '' }), {
        authorize: () => {
          called = true;
        },
      });
      expect(res.error?.code).toBe('VALIDATION_ERROR');
      expect(called).toBe(false);
    });
  });

  describe('document sets', () => {
    it('resolves named sets into attachments, without duplicates', async () => {
      const stub = stubEngine();
      const res = await bridge(stub).submit(valid({ documentSets: ['notes', 'one', 'notes'] }));
      expect(res.status).toBe('completed');
      const attachments = stub.created[0]?.attachments ?? [];
      expect(attachments.map((a) => a.label)).toEqual(['docs/a.md', 'docs/b.md']);
      expect(attachments.every((a) => fileURLToPath(a.uri).startsWith(base))).toBe(true);
    });

    it('rejects an unknown set as VALIDATION_ERROR and creates no task', async () => {
      const stub = stubEngine();
      const res = await bridge(stub).submit(valid({ documentSets: ['missing'] }));
      expect(res.status).toBe('rejected');
      expect(res.error?.code).toBe('VALIDATION_ERROR');
      expect(stub.created).toHaveLength(0);
    });

    it('omits attachments when no sets are named', async () => {
      const stub = stubEngine();
      await bridge(stub).submit(valid());
      expect(stub.created[0]).not.toHaveProperty('attachments');
    });
  });

  describe('async jobs', () => {
    it('answers running, then completes through status', async () => {
      const gate = deferred();
      const stub = stubEngine(() => gate.promise);
      const b = bridge(stub);
      const first = await b.submit(valid(), { waitMs: 5, clientId: 'alice' });
      expect(first).toEqual({
        version: 2,
        requestId: 'req-1',
        status: 'running',
        taskId: 'task-1',
      });
      expect(b.status('req-1', { clientId: 'alice' }).status).toBe('running');
      gate.resolve();
      await new Promise((r) => setTimeout(r, 10));
      const done = b.status('req-1', { clientId: 'alice' });
      expect(done.status).toBe('completed');
      expect(done.output?.text).toBe('the answer');
      expect(done.taskId).toBe('task-1');
    });

    it('waits for a job that finishes within waitMs', async () => {
      const stub = stubEngine(() => new Promise((r) => setTimeout(r, 20)));
      const res = await bridge(stub).submit(valid(), { waitMs: 2000 });
      expect(res.status).toBe('completed');
    });

    it('clamps waitMs to 100 s and treats a bad value as the default', async () => {
      const gate = deferred();
      const stub = stubEngine(() => gate.promise);
      const b = bridge(stub);
      const res = await b.submit(valid(), { waitMs: 0 });
      expect(res.status).toBe('running');
      gate.resolve();
      expect((await b.submit(valid({ requestId: 'req-2' }), { waitMs: Number.NaN })).status).toBe(
        'completed',
      );
      expect(
        (await b.submit(valid({ requestId: 'req-3' }), { waitMs: Number.MAX_SAFE_INTEGER })).status,
      ).toBe('completed');
    });

    it('reports a failure that happens after the submit call returned', async () => {
      const gate = deferred();
      const stub = stubEngine(async () => {
        await gate.promise;
        throw new NexarError('PROVIDER_ERROR', 'upstream broke');
      });
      const b = bridge(stub);
      expect((await b.submit(valid(), { waitMs: 0 })).status).toBe('running');
      gate.resolve();
      await new Promise((r) => setTimeout(r, 10));
      const res = b.status('req-1');
      expect(res.status).toBe('failed');
      expect(res.error).toMatchObject({ code: 'PROVIDER_ERROR', retryable: true });
      expect(res.taskId).toBe('task-1');
    });

    it('is idempotent for the same client: no second task, current state returned', async () => {
      const gate = deferred();
      const stub = stubEngine(() => gate.promise);
      const b = bridge(stub);
      const first = await b.submit(valid(), { waitMs: 0, clientId: 'alice' });
      const again = await b.submit(valid({ request: 'different text' }), {
        waitMs: 0,
        clientId: 'alice',
      });
      expect(again).toEqual(first);
      expect(stub.created).toHaveLength(1);
      expect(stub.runs).toHaveLength(1);
      // A resubmit can also be used to wait for the result.
      const waiting = b.submit(valid(), { waitMs: 2000, clientId: 'alice' });
      gate.resolve();
      expect((await waiting).status).toBe('completed');
      expect((await b.submit(valid(), { clientId: 'alice' })).status).toBe('completed');
      expect(stub.created).toHaveLength(1);
    });

    it('namespaces request ids per client: others see "unknown" and get their own job', async () => {
      const stub = stubEngine();
      const b = bridge(stub);
      await b.submit(valid(), { clientId: 'alice' });
      const read = b.status('req-1', { clientId: 'mallory' });
      expect(read.status).toBe('rejected');
      expect(read.error).toMatchObject({ code: 'VALIDATION_ERROR', message: 'Unknown request' });
      expect(read.output).toBeUndefined();
      expect(b.status('req-1').error).toMatchObject({ message: 'Unknown request' });
      const other = await b.submit(valid(), { clientId: 'mallory' });
      expect(other.taskId).toBeDefined();
      expect(stub.created).toHaveLength(2);
      expect(b.status('req-1', { clientId: 'alice' }).status).toBe('completed');
    });

    it('runs authorize again on a resubmit', async () => {
      const b = bridge(stubEngine());
      await b.submit(valid(), { clientId: 'alice' });
      const res = await b.submit(valid(), {
        clientId: 'alice',
        authorize: () => {
          throw new NexarError('POLICY_REJECTED', 'Not permitted for this client');
        },
      });
      expect(res.status).toBe('rejected');
    });

    it('status: unknown request is rejected with VALIDATION_ERROR', () => {
      const res = bridge(stubEngine()).status('nope');
      expect(res.status).toBe('rejected');
      expect(res.error).toMatchObject({ code: 'VALIDATION_ERROR', message: 'Unknown request' });
      expect(res.requestId).toBe('nope');
      expect(bridge(stubEngine()).status('bad id!').requestId).toBeNull();
    });

    it('keeps at most MAX_JOBS jobs, evicting the oldest finished one', async () => {
      const b = bridge(stubEngine());
      for (let i = 0; i <= MAX_JOBS; i++) {
        await b.submit(valid({ requestId: `req-${String(i)}` }));
      }
      expect(b.status('req-0').error?.message).toBe('Unknown request');
      expect(b.status('req-1').status).toBe('completed');
      expect(b.status(`req-${String(MAX_JOBS)}`).status).toBe('completed');
    });

    it('refuses new work when every slot holds a running job', async () => {
      const gate = deferred();
      const b = bridge(stubEngine(() => gate.promise));
      for (let i = 0; i < MAX_JOBS; i++) {
        await b.submit(valid({ requestId: `req-${String(i)}` }), { waitMs: 0 });
      }
      const res = await b.submit(valid({ requestId: 'overflow' }), { waitMs: 0 });
      expect(res.status).toBe('failed');
      expect(res.error).toMatchObject({ code: 'RESOURCE_UNAVAILABLE', retryable: true });
      gate.resolve();
    });
  });

  describe('output artifacts', () => {
    it('stores the result text and returns and records the ref', async () => {
      const stub = stubEngine();
      const res = await bridge(stub).submit(
        valid({ output: { filename: 'summary.md' }, systemPrompt: SECRET }),
      );
      expect(res.status).toBe('completed');
      expect(res.artifacts).toHaveLength(1);
      const ref = res.artifacts?.[0];
      expect(ref?.mediaType).toBe('text/markdown');
      expect(ref?.label).toContain('task-1');
      expect(await readFile(fileURLToPath(ref?.uri ?? ''), 'utf8')).toBe('the answer');
      expect(stub.recorded).toEqual([
        { forTask: 'task-1', forProject: 'proj', artifacts: res.artifacts },
      ]);
    });

    it('honors text/plain and forces a matching extension', async () => {
      const res = await bridge(stubEngine()).submit(
        valid({ output: { filename: 'notes.sh', mediaType: 'text/plain' } }),
      );
      expect(res.artifacts?.[0]?.uri.endsWith('.txt')).toBe(true);
    });

    it('does not let the filename escape the artifacts directory', async () => {
      const res = await bridge(stubEngine()).submit(
        valid({ output: { filename: '../../../etc/passwd' } }),
      );
      const path = fileURLToPath(res.artifacts?.[0]?.uri ?? '');
      expect(path.startsWith(join(base, '.nexar', 'artifacts'))).toBe(true);
    });

    it('keeps the text and reports the error when storing fails', async () => {
      const lines: string[] = [];
      const failing = {
        store: () => Promise.reject(new NexarError('POLICY_REJECTED', `cannot write ${base}`)),
        list: () => Promise.resolve([]),
      };
      const res = await bridge(stubEngine(), {
        artifacts: failing,
        logger: capturingLogger(lines),
      }).submit(valid({ output: { filename: 'x.md' } }));
      expect(res.status).toBe('completed');
      expect(res.output?.text).toBe('the answer');
      expect(res.artifacts).toBeUndefined();
      expect(res.error).toEqual({
        code: 'POLICY_REJECTED',
        message: 'The result could not be stored as an artifact',
        retryable: false,
      });
      expect(JSON.stringify(res)).not.toContain(base);
    });

    it('stores nothing when the request has no output', async () => {
      const stub = stubEngine();
      await bridge(stub).submit(valid());
      expect(stub.recorded).toEqual([]);
    });
  });

  it('reports an engine NexarError as failed with its code and the task id', async () => {
    const stub = stubEngine(() => Promise.reject(new NexarError('PROVIDER_ERROR', 'upstream')));
    const res = await bridge(stub).submit(valid());
    expect(res).toEqual({
      version: 2,
      requestId: 'req-1',
      status: 'failed',
      taskId: 'task-1',
      error: { code: 'PROVIDER_ERROR', message: 'upstream', retryable: true },
    });
  });

  it('explains NO_ELIGIBLE_RESOURCE from the rejection details', async () => {
    const stub = stubEngine(() =>
      Promise.reject(
        new NexarError('NO_ELIGIBLE_RESOURCE', 'No eligible resource for task task-1', {
          details: {
            rejected: [{ resourceId: 'a', reasonCodes: ['capability.missing', 'privacy.remote'] }],
          },
        }),
      ),
    );
    const res = await bridge(stub).submit(valid());
    expect(res.status).toBe('failed');
    expect(res.error?.code).toBe('NO_ELIGIBLE_RESOURCE');
    expect(res.route?.resourceId).toBeUndefined();
    expect(res.route?.reasonCodes).toEqual(['capability.missing', 'privacy.remote']);
    expect(res.route?.explanation).toContain('a: capability.missing, privacy.remote');
  });

  it('maps an engine POLICY_REJECTED (workspace) to rejected', async () => {
    const res = await bridge(
      stubEngine(() => Promise.reject(new NexarError('POLICY_REJECTED', 'nope'))),
    ).submit(valid({ workingDirectory: '/x' }));
    expect(res.status).toBe('rejected');
    expect(res.error?.code).toBe('POLICY_REJECTED');
  });

  it('hides unknown throws behind INTERNAL_ERROR and logs the detail at warn', async () => {
    const lines: string[] = [];
    const stub = stubEngine(() => Promise.reject(new Error('db password is hunter2')));
    const res = await bridge(stub, { logger: capturingLogger(lines) }).submit(valid());
    expect(res.status).toBe('failed');
    expect(res.error?.code).toBe('INTERNAL_ERROR');
    expect(JSON.stringify(res)).not.toContain('hunter2');
    expect(JSON.stringify(res)).not.toContain('stack');
    expect(lines.some((l) => l.includes('"level":"warn"') && l.includes('hunter2'))).toBe(true);
  });

  it('never throws, even when the engine throws synchronously', async () => {
    const stub = stubEngine();
    const throwing: WorkEngine = {
      ...stub.engine,
      createTask: () => {
        throw new TypeError('boom');
      },
    };
    const res = await createWorkBridge({ engine: throwing, projects, artifacts: store }).submit(
      valid(),
    );
    expect(res.status).toBe('failed');
    expect(res.error?.code).toBe('INTERNAL_ERROR');
    expect(res.requestId).toBe('req-1');
  });

  it.each([null, 'a string', ['a'], 42, undefined])(
    'rejects non-object input %j with a null requestId',
    async (input) => {
      const res = await bridge(stubEngine()).submit(input);
      expect(res.status).toBe('rejected');
      expect(res.requestId).toBeNull();
      expect(res.error?.code).toBe('VALIDATION_ERROR');
    },
  );

  it('keeps a readable requestId when other fields are invalid', async () => {
    const res = await bridge(stubEngine()).submit({ requestId: 'r-9', version: 7 });
    expect(res.requestId).toBe('r-9');
    const bad = await bridge(stubEngine()).submit({ requestId: 'bad id!' });
    expect(bad.requestId).toBeNull();
  });

  it('never logs prompt content', async () => {
    const lines: string[] = [];
    const logger = capturingLogger(lines);
    const attempt = (overrides: Record<string, unknown>, stub = stubEngine()): Promise<unknown> =>
      bridge(stub, { logger }).submit(
        valid({ request: SECRET, systemPrompt: SECRET, ...overrides }),
      );
    await attempt({});
    await attempt({ requestId: 'r2', source: 'nope' });
    await attempt({ requestId: 'r3', project: 'nope' });
    await attempt({ requestId: 'r4', extra: SECRET });
    await attempt({ requestId: 'r5', output: { filename: 'o.md' }, documentSets: ['notes'] });
    await attempt(
      { requestId: 'r6' },
      stubEngine(() => Promise.reject(new NexarError('PROVIDER_ERROR', 'x'))),
    );
    await attempt(
      { requestId: 'r7' },
      stubEngine(() => Promise.reject(new Error(`leaky ${'detail'}`))),
    );
    expect(lines.length).toBeGreaterThan(0);
    expect(lines.join('\n')).not.toContain(SECRET);
  });
});

describe('schema', () => {
  it('exports the version constant', () => {
    expect(WORK_BRIDGE_VERSION).toBe(2);
  });

  it('parses a minimal request', () => {
    expect(WorkRequestSchema.safeParse(valid()).success).toBe(true);
  });

  it('generates a JSON schema with the v2 properties', () => {
    const schema = workRequestJsonSchema();
    const properties = schema['properties'] as Record<string, unknown>;
    for (const key of ['request', 'project', 'documentSets', 'output', 'workingDirectory']) {
      expect(properties).toHaveProperty(key);
    }
    expect(properties).toHaveProperty('workflow');
    expect(schema['additionalProperties']).toBe(false);
    // `taskKind`/`request` are optional in the schema: the bridge requires them unless `workflow` is set.
    expect(schema['required']).toEqual(
      expect.arrayContaining(['version', 'requestId', 'source', 'project']),
    );
    expect(schema['required']).not.toContain('request');
  });
});

describe('with the real engine and a real project', () => {
  let base: string;
  let outside: string;
  let executed: number;
  let runtime: NexarRuntime;

  beforeEach(async () => {
    base = await realpath(await mkdtemp(join(tmpdir(), 'nexar-bridge-')));
    outside = join(base, 'outside');
    await mkdir(join(base, 'allowed', 'sub'), { recursive: true });
    await mkdir(join(base, 'allowed', 'docs'));
    await writeFile(join(base, 'allowed', 'docs', 'brief.md'), 'the brief');
    await mkdir(outside);
    await symlink(outside, join(base, 'allowed', 'link'));
    executed = 0;
  });
  afterEach(async () => {
    await rm(base, { recursive: true, force: true });
  });

  async function realBridge(delayMs = 0): Promise<WorkBridge> {
    const config = parseConfig(
      {
        version: 1,
        resources: [echoResource()],
        routing: { policy: 'deterministic', defaultResourceId: 'local-echo' },
        projects: [
          {
            id: 'demo',
            displayName: 'Demo',
            roots: [join(base, 'allowed')],
            documentSets: { briefs: [join(base, 'allowed', 'docs')] },
          },
        ],
      },
      'test',
    );
    const echo = new EchoExecutionAdapter({ delayMs });
    const spy = Object.assign(Object.create(echo) as EchoExecutionAdapter, {
      execute: (...args: Parameters<EchoExecutionAdapter['execute']>) => {
        executed++;
        return echo.execute(...args);
      },
    });
    runtime = await createNexarWithProjects(config, { adapters: [spy] });
    return createWorkBridge({
      engine: runtime.nexar,
      projects: runtime.projects,
      artifacts: new LocalArtifactStore({ projects: runtime.projects }),
    });
  }

  const real = (overrides: Record<string, unknown> = {}): Record<string, unknown> =>
    valid({ project: 'demo', ...overrides });

  it('runs end to end and explains the route', async () => {
    const res = await (await realBridge()).submit(real({ request: 'hello' }));
    expect(res.status).toBe('completed');
    expect(res.output?.text).toBe('[echo:local-echo] hello');
    expect(res.route?.resourceId).toBe('local-echo');
    expect(res.route?.explanation).toContain('Selected resource: local-echo');
    expect(res.taskId).toMatch(/^task_/);
    expect(res.usage?.costUsd).toEqual({ status: 'measured', value: 0 });
  });

  it('surfaces NO_ELIGIBLE_RESOURCE from the real engine as failed with an explanation', async () => {
    const res = await (
      await realBridge()
    ).submit(real({ constraints: { excludedResourceIds: ['local-echo'] } }));
    expect(res.status).toBe('failed');
    expect(res.error?.code).toBe('NO_ELIGIBLE_RESOURCE');
    expect(res.route?.explanation).toContain('local-echo');
    expect(res.route?.reasonCodes.length).toBeGreaterThan(0);
  });

  it('runs a slow job in the background: running, then completed via status', async () => {
    const b = await realBridge(150);
    const first = await b.submit(real({ request: 'slow' }), { waitMs: 10, clientId: 'c1' });
    expect(first.status).toBe('running');
    expect(first.taskId).toMatch(/^task_/);
    expect(first.output).toBeUndefined();
    await new Promise((r) => setTimeout(r, 400));
    const done = b.status('req-1', { clientId: 'c1' });
    expect(done.status).toBe('completed');
    expect(done.output?.text).toBe('[echo:local-echo] slow');
    expect(done.taskId).toBe(first.taskId);
    expect(executed).toBe(1);
  });

  it('passes document sets to the adapter as attachments', async () => {
    const b = await realBridge();
    const res = await b.submit(real({ documentSets: ['briefs'] }));
    expect(res.status).toBe('completed');
  });

  it('persists the result as an artifact inside the project and returns the ref', async () => {
    const res = await (
      await realBridge()
    ).submit(real({ request: 'write it', output: { filename: 'result' } }));
    expect(res.status).toBe('completed');
    const ref = res.artifacts?.[0];
    expect(ref?.mediaType).toBe('text/markdown');
    const path = fileURLToPath(ref?.uri ?? '');
    expect(path.startsWith(join(base, 'allowed', '.nexar', 'artifacts', res.taskId ?? '?'))).toBe(
      true,
    );
    expect(await readFile(path, 'utf8')).toBe('[echo:local-echo] write it');
    expect(ref?.sizeBytes).toBe(Buffer.byteLength('[echo:local-echo] write it'));
  });

  it('runs in a directory inside the project (relative and absolute)', async () => {
    const b = await realBridge();
    expect((await b.submit(real({ workingDirectory: 'sub' }))).status).toBe('completed');
    const abs = await b.submit(
      real({ requestId: 'req-2', workingDirectory: join(base, 'allowed', 'sub') }),
    );
    expect(abs.status).toBe('completed');
    expect(executed).toBe(2);
  });

  it('rejects the symlink attack (allowed/link -> outside) and never executes', async () => {
    const b = await realBridge();
    for (const [i, workingDirectory] of ['link', join(base, 'allowed', 'link')].entries()) {
      const res = await b.submit(real({ requestId: `req-${String(i)}`, workingDirectory }));
      expect(res.status).toBe('rejected');
      expect(res.error?.code).toBe('POLICY_REJECTED');
      expect(JSON.stringify(res)).not.toContain(base);
    }
    expect(executed).toBe(0);
  });

  it('rejects a `..` escape and an unknown project', async () => {
    const b = await realBridge();
    const escape = await b.submit(
      real({ workingDirectory: join(base, 'allowed', '..', 'outside') }),
    );
    expect(escape.status).toBe('rejected');
    const relative = await b.submit(real({ requestId: 'req-2', workingDirectory: '../outside' }));
    expect(relative.status).toBe('rejected');
    const unknown = await b.submit(real({ requestId: 'req-3', project: 'nope' }));
    expect(unknown.status).toBe('rejected');
    expect(unknown.error?.code).toBe('POLICY_REJECTED');
    expect(executed).toBe(0);
  });
});
