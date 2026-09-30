import { mkdir, mkdtemp, realpath, rm, symlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
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
  createNexar,
  parseConfig,
  type NewTaskInput,
  type RunOutcome,
} from '@nexar/core';
import { EchoExecutionAdapter, echoResource } from '@nexar/integration-echo';
import {
  WORK_BRIDGE_VERSION,
  WorkRequestSchema,
  createWorkBridge,
  workRequestJsonSchema,
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
}

function stubEngine(behavior: () => Promise<void> = () => Promise.resolve()): Stub {
  const created: NewTaskInput[] = [];
  const runs: Stub['runs'] = [];
  const engine: WorkEngine = {
    createTask(input) {
      created.push(input);
      return {
        id: taskId('task-1'),
        kind: input.kind,
        input: { prompt: input.prompt },
        requirements: { capabilities: [], ...input.requirements },
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
  };
  return { engine, created, runs };
}

const valid = (overrides: Record<string, unknown> = {}): Record<string, unknown> => ({
  version: 1,
  requestId: 'req-1',
  source: 'openworker',
  taskKind: 'analysis',
  request: 'summarize this',
  ...overrides,
});

function bridge(stub: Stub, extra: Partial<WorkBridgeOptions> = {}) {
  return createWorkBridge({ engine: stub.engine, ...extra });
}

describe('createWorkBridge.submit', () => {
  it('completes a valid request with route and usage', async () => {
    const stub = stubEngine();
    const res = await bridge(stub).submit(valid());
    expect(res).toEqual({
      version: WORK_BRIDGE_VERSION,
      requestId: 'req-1',
      status: 'completed',
      taskId: 'task-1',
      output: { text: 'the answer' },
      route: {
        resourceId: resourceId('res-a'),
        policy: 'deterministic',
        reasons: [{ code: 'default.match', effect: 'supports', message: 'default resource' }],
      },
      usage: {
        inputTokens: { status: 'measured', value: 10 },
        outputTokens: { status: 'measured', value: 20 },
        costUsd: { status: 'unavailable', reason: 'unpriced' },
      },
    });
  });

  it('maps the request onto a Nexar task', async () => {
    const stub = stubEngine();
    const controller = new AbortController();
    await createWorkBridge({
      engine: stub.engine,
      timeoutMs: 5000,
    }).submit(
      valid({
        project: 'proj',
        requestedBy: 'alice',
        systemPrompt: 'be brief',
        workingDirectory: '/work/sub',
        constraints: {
          capabilities: ['coding'],
          privacy: 'local-only',
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
      workingDirectory: '/work/sub',
      origin: {
        source: 'openworker',
        project: 'proj',
        correlationId: 'req-1',
        requestedBy: 'alice',
      },
      requirements: {
        capabilities: ['coding'],
        privacy: 'local-only',
        preferredResourceIds: ['a'],
        excludedResourceIds: ['b'],
      },
      metadata: { bridge: 'openworker', bridgeVersion: 1 },
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

  describe('field limits', () => {
    const cases: [string, Record<string, unknown>, string][] = [
      ['version', { version: 2 }, 'version'],
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
      ['long requestedBy', { requestedBy: 'r'.repeat(129) }, 'requestedBy'],
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

  describe('workingDirectory', () => {
    it('is rejected without a project, before the engine is touched', async () => {
      const stub = stubEngine();
      const res = await bridge(stub).submit(valid({ workingDirectory: '/srv/projects' }));
      expect(res.status).toBe('rejected');
      expect(res.error?.code).toBe('POLICY_REJECTED');
      expect(stub.created).toHaveLength(0);
      expect(stub.runs).toHaveLength(0);
    });

    it('is passed through unchecked when a project is named (the engine enforces)', async () => {
      const stub = stubEngine();
      const res = await bridge(stub).submit(
        valid({ project: 'proj', workingDirectory: '/srv/projects/../etc' }),
      );
      expect(res.status).toBe('completed');
      expect(stub.created[0]?.workingDirectory).toBe('/srv/projects/../etc');
    });

    it('rejects relative paths', async () => {
      const res = await bridge(stubEngine()).submit(
        valid({ project: 'proj', workingDirectory: 'projects/a' }),
      );
      expect(res.status).toBe('rejected');
      expect(res.error?.code).toBe('VALIDATION_ERROR');
      expect(res.error?.issues?.[0]?.path).toBe('workingDirectory');
    });

    it('maps an engine POLICY_REJECTED to rejected', async () => {
      const res = await bridge(
        stubEngine(() => Promise.reject(new NexarError('POLICY_REJECTED', 'nope'))),
      ).submit(valid({ project: 'proj', workingDirectory: '/x' }));
      expect(res.status).toBe('rejected');
      expect(res.error?.code).toBe('POLICY_REJECTED');
    });
  });

  it('reports an engine NexarError as failed with its code', async () => {
    const stub = stubEngine(() =>
      Promise.reject(new NexarError('NO_ELIGIBLE_RESOURCE', 'nothing fits')),
    );
    const res = await bridge(stub).submit(valid());
    expect(res).toEqual({
      version: 1,
      requestId: 'req-1',
      status: 'failed',
      error: { code: 'NO_ELIGIBLE_RESOURCE', message: 'nothing fits', retryable: false },
    });
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
    const engine: WorkEngine = {
      createTask: () => {
        throw new TypeError('boom');
      },
      run: (task, options) => stub.engine.run(task, options),
    };
    const res = await createWorkBridge({ engine }).submit(valid());
    expect(res.status).toBe('failed');
    expect(res.error?.code).toBe('INTERNAL_ERROR');
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
    await bridge(stubEngine(), { logger }).submit(valid({ request: SECRET, systemPrompt: SECRET }));
    await bridge(stubEngine(), { logger }).submit(
      valid({ request: SECRET, systemPrompt: SECRET, source: 'nope' }),
    );
    await bridge(
      stubEngine(() => Promise.reject(new NexarError('PROVIDER_ERROR', 'x'))),
      {
        logger,
      },
    ).submit(valid({ request: SECRET }));
    await bridge(stubEngine(), { logger }).submit(valid({ request: SECRET, extra: SECRET }));
    expect(lines.length).toBeGreaterThan(0);
    expect(lines.join('\n')).not.toContain(SECRET);
  });
});

describe('schema', () => {
  it('exports the version constant', () => {
    expect(WORK_BRIDGE_VERSION).toBe(1);
  });

  it('parses a minimal request', () => {
    expect(WorkRequestSchema.safeParse(valid()).success).toBe(true);
  });

  it('generates a JSON schema with a request property', () => {
    const schema = workRequestJsonSchema();
    expect(typeof schema).toBe('object');
    const properties = schema['properties'] as Record<string, unknown>;
    expect(properties).toHaveProperty('request');
    expect(schema['additionalProperties']).toBe(false);
  });
});

describe('with the real engine', () => {
  it('runs end to end through createNexar and the echo adapter', async () => {
    const config = parseConfig(
      {
        version: 1,
        resources: [echoResource()],
        routing: { policy: 'deterministic', defaultResourceId: 'local-echo' },
      },
      'test',
    );
    const { nexar } = createNexar(config, { adapters: [new EchoExecutionAdapter()] });
    const res = await createWorkBridge({ engine: nexar }).submit(valid({ request: 'hello' }));
    expect(res.status).toBe('completed');
    expect(res.output?.text).toBe('[echo:local-echo] hello');
    expect(res.route?.resourceId).toBe('local-echo');
    expect(res.taskId).toMatch(/^task_/);
    expect(res.usage?.costUsd).toEqual({ status: 'measured', value: 0 });
  });

  it('surfaces NO_ELIGIBLE_RESOURCE from the real engine as failed', async () => {
    const config = parseConfig(
      {
        version: 1,
        resources: [echoResource()],
        routing: { policy: 'deterministic', defaultResourceId: 'local-echo' },
      },
      'test',
    );
    const { nexar } = createNexar(config, { adapters: [new EchoExecutionAdapter()] });
    const res = await createWorkBridge({ engine: nexar }).submit(
      valid({ constraints: { excludedResourceIds: ['local-echo'] } }),
    );
    expect(res.status).toBe('failed');
    expect(res.error?.code).toBe('NO_ELIGIBLE_RESOURCE');
  });
});

describe('with the real engine and a real project', () => {
  let base: string;
  let outside: string;
  let executed: number;

  beforeEach(async () => {
    base = await realpath(await mkdtemp(join(tmpdir(), 'nexar-bridge-')));
    outside = join(base, 'outside');
    await mkdir(join(base, 'allowed', 'sub'), { recursive: true });
    await mkdir(outside);
    await symlink(outside, join(base, 'allowed', 'link'));
    executed = 0;
  });
  afterEach(async () => {
    await rm(base, { recursive: true, force: true });
  });

  async function realBridge() {
    const config = parseConfig(
      {
        version: 1,
        resources: [echoResource()],
        routing: { policy: 'deterministic', defaultResourceId: 'local-echo' },
        projects: [{ id: 'demo', displayName: 'Demo', roots: [join(base, 'allowed')] }],
      },
      'test',
    );
    const echo = new EchoExecutionAdapter();
    const spy = Object.assign(Object.create(echo) as EchoExecutionAdapter, {
      execute: (...args: Parameters<EchoExecutionAdapter['execute']>) => {
        executed++;
        return echo.execute(...args);
      },
    });
    const { nexar } = await createNexarWithProjects(config, { adapters: [spy] });
    return createWorkBridge({ engine: nexar });
  }

  it('runs in a directory inside the project', async () => {
    const res = await (
      await realBridge()
    ).submit(valid({ project: 'demo', workingDirectory: join(base, 'allowed', 'sub') }));
    expect(res.status).toBe('completed');
    expect(executed).toBe(1);
  });

  it('rejects the symlink attack (allowed/link -> outside) and never executes', async () => {
    const res = await (
      await realBridge()
    ).submit(valid({ project: 'demo', workingDirectory: join(base, 'allowed', 'link') }));
    expect(res.status).toBe('rejected');
    expect(res.error?.code).toBe('POLICY_REJECTED');
    expect(JSON.stringify(res)).not.toContain(base);
    expect(executed).toBe(0);
  });

  it('rejects a `..` escape and an unknown project', async () => {
    const b = await realBridge();
    const escape = await b.submit(
      valid({ project: 'demo', workingDirectory: join(base, 'allowed', '..', 'outside') }),
    );
    expect(escape.status).toBe('rejected');
    const unknown = await b.submit(valid({ project: 'nope' }));
    expect(unknown.status).toBe('rejected');
    expect(unknown.error?.code).toBe('POLICY_REJECTED');
    expect(executed).toBe(0);
  });

  it('rejects a working directory without a project', async () => {
    const res = await (
      await realBridge()
    ).submit(valid({ workingDirectory: join(base, 'allowed') }));
    expect(res.status).toBe('rejected');
    expect(executed).toBe(0);
  });
});
