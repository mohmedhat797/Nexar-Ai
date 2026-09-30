import { describe, expect, it } from 'vitest';
import {
  adapterId,
  NexarError,
  taskId,
  type ExecutionAdapter,
  type ExecutionEvent,
  type Logger,
  type TelemetrySink,
} from '@nexar/contracts';
import { InMemoryTelemetrySink, createJsonLogger } from '@nexar/telemetry';
import { EchoExecutionAdapter, echoResource } from '@nexar/integration-echo';
import { AdapterRegistry } from './adapter-registry.js';
import { parseConfig, type NexarConfig } from './config.js';
import { createNexar } from './create-nexar.js';

const echoConfig = (): NexarConfig =>
  parseConfig(
    {
      version: 1,
      resources: [echoResource()],
      routing: { policy: 'deterministic', defaultResourceId: 'local-echo' },
    },
    'test',
  );

function setup(
  adapter: ExecutionAdapter = new EchoExecutionAdapter(),
  options: { telemetry?: TelemetrySink; logger?: Logger; config?: NexarConfig } = {},
) {
  const sink = new InMemoryTelemetrySink();
  const runtime = createNexar(options.config ?? echoConfig(), {
    adapters: [adapter],
    telemetry: options.telemetry ?? sink,
    ...(options.logger === undefined ? {} : { logger: options.logger }),
  });
  return { ...runtime, sink };
}

describe('Nexar.createTask', () => {
  it('applies defaults and injected id/clock', () => {
    const { nexar } = setup();
    const task = nexar.createTask({ kind: 'general', prompt: 'hi' });
    expect(task.id).toMatch(/^task_/);
    expect(task.origin).toEqual({ source: 'cli' });
    expect(task.requirements).toEqual({ capabilities: [] });
    expect(task.input).toEqual({ prompt: 'hi' });
  });

  it('carries optional fields', () => {
    const { nexar } = setup();
    const task = nexar.createTask({
      kind: 'coding',
      prompt: 'p',
      title: 't',
      systemPrompt: 's',
      workingDirectory: '/w',
      requirements: { privacy: 'local-only' },
      origin: { source: 'test' },
      metadata: { a: 1 },
    });
    expect(task).toMatchObject({
      title: 't',
      input: { prompt: 'p', systemPrompt: 's', workingDirectory: '/w' },
      requirements: { capabilities: [], privacy: 'local-only' },
      origin: { source: 'test' },
      metadata: { a: 1 },
    });
  });
});

describe('Nexar.run', () => {
  it('routes, executes and records on the happy path', async () => {
    const { nexar, sink } = setup();
    const events: ExecutionEvent[] = [];
    const task = nexar.createTask({ kind: 'general', prompt: 'hello there' });
    const outcome = await nexar.run(task, { onEvent: (e) => events.push(e) });

    expect(outcome.result.text).toBe('[echo:local-echo] hello there');
    expect(outcome.decision.selected.resourceId).toBe('local-echo');
    expect(events.map((e) => e.type)).toEqual(['status', 'text-delta']);
    expect(sink.events.map((e) => e.type)).toEqual([
      'route.decided',
      'execution.started',
      'execution.finished',
    ]);

    const { record } = outcome;
    expect(sink.records()).toEqual([record]);
    expect(record).toMatchObject({
      schemaVersion: 1,
      taskId: task.id,
      taskKind: 'general',
      origin: 'cli',
      resourceId: 'local-echo',
      resourceKind: 'model',
      adapter: 'echo',
      provider: 'nexar',
      model: 'echo',
      outcome: 'succeeded',
      retries: 0,
      artifacts: [],
      routing: { policy: 'deterministic', policyVersion: '1' },
      quotaImpact: { status: 'unavailable', reason: 'not tracked in v0.1' },
    });
    expect(record.routing.reasonCodes).toEqual(
      outcome.decision.selected.reasons.map((r) => r.code),
    );
    expect(record.routing.reasonCodes).toContain('capability.match');
    expect(record.usage.inputTokens.status).toBe('estimated');
    expect(record.usage.outputTokens.status).toBe('estimated');
    expect(record.usage.costUsd).toEqual({ status: 'measured', value: 0 });
    expect(record.usage.turns).toEqual({ status: 'measured', value: 1 });
    expect(record.error).toBeUndefined();
    expect(record.latencyMs).toBeGreaterThanOrEqual(0);
  });

  it('uses the injected clock and task id factory', async () => {
    const sink = new InMemoryTelemetrySink();
    const { registry, controller, adapters } = createNexar(echoConfig(), {
      adapters: [new EchoExecutionAdapter()],
    });
    const { Nexar } = await import('./engine.js');
    let ticks = 0;
    const nexar = new Nexar({
      registry,
      router: controller,
      adapters,
      telemetry: sink,
      logger: createJsonLogger({ write: () => undefined }),
      clock: () => new Date(Date.UTC(2026, 0, 1, 0, 0, 0, ticks++ * 10)),
      newTaskId: () => taskId('fixed'),
    });
    const task = nexar.createTask({ kind: 'general', prompt: 'x' });
    expect(task.id).toBe('fixed');
    const { record } = await nexar.run(task);
    expect(record.startedAt < record.endedAt).toBe(true);
    expect(record.latencyMs).toBeGreaterThan(0);
  });

  it('throws NO_ELIGIBLE_RESOURCE and emits no execution events', async () => {
    const { nexar, sink } = setup();
    const task = nexar.createTask({
      kind: 'general',
      prompt: 'x',
      requirements: { capabilities: ['teleportation'] },
    });
    await expect(nexar.run(task)).rejects.toMatchObject({ code: 'NO_ELIGIBLE_RESOURCE' });
    expect(sink.events.map((e) => e.type)).toEqual(['route.decided']);
  });

  it('records adapter failures and rethrows', async () => {
    const { nexar, sink } = setup(new EchoExecutionAdapter({ failWith: 'PROVIDER_ERROR' }));
    const task = nexar.createTask({ kind: 'general', prompt: 'x' });
    await expect(nexar.run(task)).rejects.toMatchObject({ code: 'PROVIDER_ERROR' });
    const [record] = sink.records();
    expect(record).toMatchObject({
      outcome: 'failed',
      error: { code: 'PROVIDER_ERROR', retryable: true },
    });
    expect(record?.usage.inputTokens.status).toBe('unavailable');
    expect(record?.usage.costUsd.status).toBe('unavailable');
    expect(sink.events.map((e) => e.type)).toEqual([
      'route.decided',
      'execution.started',
      'execution.finished',
    ]);
  });

  it('wraps non-Nexar errors as INTERNAL_ERROR', async () => {
    const boom: ExecutionAdapter = {
      ...new EchoExecutionAdapter(),
      id: adapterId('echo'),
      displayName: 'boom',
      supports: () => true,
      probe: () =>
        Promise.resolve({ availability: 'available', auth: 'not-required', observedAt: 'x' }),
      execute: () => Promise.reject(new TypeError('kaboom')),
    };
    const { nexar, sink } = setup(boom);
    await expect(
      nexar.run(nexar.createTask({ kind: 'general', prompt: 'x' })),
    ).rejects.toMatchObject({
      code: 'INTERNAL_ERROR',
    });
    expect(sink.records()[0]?.outcome).toBe('failed');
  });

  it('times out even when the adapter ignores its abort signal', async () => {
    const echo = new EchoExecutionAdapter();
    const stuck: ExecutionAdapter = {
      id: echo.id,
      displayName: 'stuck',
      supports: () => true,
      probe: echo.probe.bind(echo),
      execute: () => new Promise<never>(() => undefined),
    };
    const { nexar, sink } = setup(stuck);
    const task = nexar.createTask({ kind: 'general', prompt: 'x' });
    await expect(nexar.run(task, { timeoutMs: 20 })).rejects.toMatchObject({
      code: 'EXECUTION_TIMEOUT',
    });
    expect(sink.records()[0]?.outcome).toBe('timed-out');
  });

  it('maps a timeout to EXECUTION_TIMEOUT / timed-out', async () => {
    const { nexar, sink } = setup(new EchoExecutionAdapter({ delayMs: 10_000 }));
    const task = nexar.createTask({ kind: 'general', prompt: 'x' });
    const error = await nexar.run(task, { timeoutMs: 20 }).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(NexarError);
    expect(error).toMatchObject({ code: 'EXECUTION_TIMEOUT' });
    expect(sink.records()[0]).toMatchObject({
      outcome: 'timed-out',
      error: { code: 'EXECUTION_TIMEOUT' },
    });
  });

  it('maps a caller abort to EXECUTION_CANCELLED / cancelled', async () => {
    const { nexar, sink } = setup(new EchoExecutionAdapter({ delayMs: 10_000 }));
    const controller = new AbortController();
    const task = nexar.createTask({ kind: 'general', prompt: 'x' });
    const pending = nexar.run(task, { signal: controller.signal, timeoutMs: 60_000 });
    setTimeout(() => controller.abort(), 10);
    await expect(pending).rejects.toMatchObject({ code: 'EXECUTION_CANCELLED' });
    expect(sink.records()[0]).toMatchObject({
      outcome: 'cancelled',
      error: { code: 'EXECUTION_CANCELLED' },
    });
  });

  it('does not fail the run when a telemetry sink throws, and logs a warning', async () => {
    const lines: string[] = [];
    const logger = createJsonLogger({ write: (l) => lines.push(l) });
    const bad: TelemetrySink = {
      emit: (): never => {
        throw new Error('sink down');
      },
    };
    const { nexar } = setup(new EchoExecutionAdapter(), { telemetry: bad, logger });
    // createNexar wraps the sink in a composite, so exercise the engine guard directly as well.
    const outcome = await nexar.run(nexar.createTask({ kind: 'general', prompt: 'x' }));
    expect(outcome.record.outcome).toBe('succeeded');
    expect(lines.some((l) => l.includes('"level":"warn"') && l.includes('sink down'))).toBe(true);
  });

  it('guards against rejecting sinks at the engine level', async () => {
    const { registry, controller, adapters } = createNexar(echoConfig(), {
      adapters: [new EchoExecutionAdapter()],
    });
    const { Nexar } = await import('./engine.js');
    const warnings: string[] = [];
    const logger: Logger = {
      debug: () => undefined,
      info: () => undefined,
      warn: (msg) => void warnings.push(msg),
      error: () => undefined,
      child: () => logger,
    };
    const failing: TelemetrySink = {
      emit: () => Promise.reject(new Error('nope')),
    };
    const nexar = new Nexar({ registry, router: controller, adapters, telemetry: failing, logger });
    const outcome = await nexar.run(nexar.createTask({ kind: 'general', prompt: 'x' }));
    expect(outcome.record.outcome).toBe('succeeded');
    expect(warnings).toHaveLength(3);
  });

  it('routes around a resource whose adapter is not installed', async () => {
    const ghost = echoResource({
      id: 'ghost' as never,
      runtime: { adapter: adapterId('ghost'), locality: 'local' },
    });
    const config = parseConfig(
      {
        version: 1,
        resources: [ghost, echoResource()],
        routing: { policy: 'deterministic', defaultResourceId: 'ghost' },
      },
      'test',
    );
    const { nexar, registry } = setup(new EchoExecutionAdapter(), { config });
    const outcome = await nexar.run(nexar.createTask({ kind: 'general', prompt: 'x' }));
    expect(outcome.record.resourceId).toBe('local-echo');
    expect(outcome.decision.rejected.map((r) => r.resourceId)).toEqual(['ghost']);
    expect(registry.getState('ghost' as never)).toMatchObject({
      availability: 'unavailable',
      detail: 'adapter "ghost" not installed',
    });
  });
});

describe('AdapterRegistry', () => {
  it('rejects duplicates and resolves by id + supports', () => {
    const registry = new AdapterRegistry();
    const echo = new EchoExecutionAdapter();
    registry.register(echo);
    expect(() => registry.register(new EchoExecutionAdapter())).toThrow(
      expect.objectContaining({ code: 'CONFIGURATION_ERROR' }) as Error,
    );
    expect(registry.list()).toEqual([echo]);
    expect(registry.get(echo.id)).toBe(echo);
    expect(registry.resolve(echoResource())).toBe(echo);
    const other = echoResource({ runtime: { adapter: adapterId('other'), locality: 'local' } });
    expect(() => registry.resolve(other)).toThrow(
      expect.objectContaining({ code: 'ADAPTER_NOT_FOUND' }) as Error,
    );
  });

  it('refuses when the adapter does not support the resource', () => {
    const registry = new AdapterRegistry();
    const echo = new EchoExecutionAdapter();
    registry.register({
      id: echo.id,
      displayName: echo.displayName,
      supports: () => false,
      probe: () => echo.probe(),
      execute: (request, context) => echo.execute(request, context),
    });
    expect(() => registry.resolve(echoResource())).toThrow(
      expect.objectContaining({ code: 'ADAPTER_NOT_FOUND' }) as Error,
    );
  });
});
