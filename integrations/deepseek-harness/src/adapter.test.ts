import { existsSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import type { ExecutionEvent, ResourceDescriptor, SecretResolver } from '@nexar/contracts';
import { NexarError, adapterId } from '@nexar/contracts';
import { DeepSeekHarnessExecutionAdapter } from './adapter.js';
import { DSH_PINNED_VERSION, deepseekHarnessResource } from './resource.js';
import { fakeBinary, makeContext, makeTask, makeTempDir, readRecord } from './test/support.js';
import type { LogLine } from './test/support.js';

const ENV: NodeJS.ProcessEnv = {
  PATH: process.env.PATH,
  HOME: '/home/test',
  DEEPSEEK_API_KEY: 'sk-test-key-123',
  GH_TOKEN: 'ghp_should_not_leak',
};

function setup(settings: Record<string, string> = {}, extra: { env?: NodeJS.ProcessEnv } = {}) {
  const dir = makeTempDir();
  const recordPath = join(dir, 'record.json');
  const stateDir = join(dir, 'state');
  const adapter = new DeepSeekHarnessExecutionAdapter({
    binary: fakeBinary({ record: recordPath, ...settings }),
    stateDir,
    env: extra.env ?? ENV,
    initializeTimeoutMs: 5000,
    defaultTimeoutMs: 20_000,
  });
  return { dir, recordPath, stateDir, adapter };
}

describe('DeepSeekHarnessExecutionAdapter.execute', () => {
  it('runs a task end to end and maps text, usage and resolved info', async () => {
    const { dir, recordPath, stateDir, adapter } = setup();
    const events: ExecutionEvent[] = [];
    const logs: LogLine[] = [];
    const result = await adapter.execute(
      { task: makeTask({ workingDirectory: dir }), resource: deepseekHarnessResource() },
      makeContext({ events, logs }),
    );

    expect(result.text).toBe('final answer');
    expect(result.resolved).toEqual({
      provider: 'deepseek-official',
      model: 'deepseek-flash',
      runtimeVersion: 'deepseek-harness-sdk-runtime@0.2.1-rc.3',
    });
    expect(result.usage.inputTokens).toEqual({ status: 'measured', value: 30 });
    expect(result.usage.outputTokens).toEqual({ status: 'measured', value: 12 });
    expect(result.usage.cacheReadTokens).toEqual({ status: 'measured', value: 3 });
    expect(result.usage.cacheWriteTokens).toEqual({ status: 'measured', value: 4 });
    expect(result.usage.costUsd).toEqual({
      status: 'unavailable',
      reason: 'dsh does not report cost',
    });
    expect(result.artifacts).toEqual([]);
    expect(result.retries).toBe(0);

    expect(events.filter((e) => e.type === 'status').length).toBeGreaterThanOrEqual(3);
    expect(events).toContainEqual({ type: 'tool-call', name: 'read_file' });

    // Prompts never reach the logs.
    expect(JSON.stringify(logs)).not.toContain('SECRET-PROMPT-TEXT');

    const record = readRecord(recordPath);
    const promptRequest = record.requests.find((r) => r.method === 'session/prompt');
    expect(promptRequest?.params).toEqual({
      sessionId: 'nexar-t1',
      contentBlocks: [{ type: 'text', text: 'SECRET-PROMPT-TEXT say hi' }],
    });
    const init = record.requests.find((r) => r.method === 'initialize');
    expect(init?.params).toEqual({
      cwd: dir,
      provider: 'deepseek-official',
      model: 'deepseek-flash',
    });
    expect(record.requests.map((r) => r.method)).toEqual([
      'initialize',
      'session/prompt',
      'shutdown',
    ]);
    expect(record.cwd).toBe(dir);
    expect(record.dshHome).toBe(join(stateDir, 'home'));
  });

  it('launches with the sdk profile, the generated overlay and only allowlisted env', async () => {
    const { dir, recordPath, stateDir, adapter } = setup();
    const resource = deepseekHarnessResource({
      runtime: {
        adapter: adapterId('deepseek-harness'),
        locality: 'local',
        options: {
          model: 'deepseek-v4-flash',
          patches: ['/extra/one.yml'],
          piAiProviders: { anthropic: { apiKeyEnv: 'ANTHROPIC_API_KEY' } },
          reasoningEffort: 'high',
          maxTokens: 4096,
        },
      },
    });
    await adapter.execute({ task: makeTask({ workingDirectory: dir }), resource }, makeContext());
    const record = readRecord(recordPath);
    const args = record.argv.filter((a) => !a.startsWith('--fake-') && !a.endsWith('fake-dsh.mjs'));
    const overlayPath = join(stateDir, 'nexar.patch.yml');
    expect(args).toEqual(['--profile', 'sdk', '--patch', overlayPath, '--patch', '/extra/one.yml']);
    expect(record.overlay).toContain('- id: session-log-deepseek\n  disabled: true');
    expect(record.overlay).toContain('"anthropic":');
    if (process.platform !== 'win32') expect(statSync(overlayPath).mode & 0o777).toBe(0o600);

    expect(record.envKeys).not.toContain('GH_TOKEN');
    expect(record.envKeys).toContain('DEEPSEEK_API_KEY');
    expect(record.envKeys).not.toContain('ANTHROPIC_API_KEY'); // absent in parent env
    const init = record.requests.find((r) => r.method === 'initialize');
    expect(init?.params).toMatchObject({ reasoningEffort: 'high', maxTokens: 4096 });
  });

  it('ignores other sessions and pre-receipt idle, and handles a receipt before the response', async () => {
    const { dir, adapter } = setup({ early_receipt: '1' });
    const result = await adapter.execute(
      { task: makeTask({ workingDirectory: dir }), resource: deepseekHarnessResource() },
      makeContext(),
    );
    expect(result.text).toBe('final answer');
  });

  it('reports unavailable usage when dsh reports none', async () => {
    const { dir, adapter } = setup({ mode: 'no-usage' });
    const result = await adapter.execute(
      { task: makeTask({ workingDirectory: dir }), resource: deepseekHarnessResource() },
      makeContext(),
    );
    expect(result.text).toBe('no usage here');
    expect(result.usage.inputTokens).toEqual({
      status: 'unavailable',
      reason: 'not reported by dsh',
    });
    expect(result.usage.outputTokens.status).toBe('unavailable');
  });

  it('succeeds on max-tokens with text, noting truncation', async () => {
    const { dir, adapter } = setup({ mode: 'max-tokens' });
    const events: ExecutionEvent[] = [];
    const result = await adapter.execute(
      { task: makeTask({ workingDirectory: dir }), resource: deepseekHarnessResource() },
      makeContext({ events }),
    );
    expect(result.text).toBe('partial answ');
    expect(events).toContainEqual({
      type: 'status',
      message: expect.stringContaining('token limit') as string,
    });
  });

  it.each([
    ['max-tokens-empty', 'max-tokens'],
    ['aborted-turn', 'aborted'],
  ])('fails PROVIDER_ERROR for mode %s with details.turnEnd=%s', async (mode, turnEnd) => {
    const { dir, adapter } = setup({ mode });
    await expect(
      adapter.execute(
        { task: makeTask({ workingDirectory: dir }), resource: deepseekHarnessResource() },
        makeContext(),
      ),
    ).rejects.toMatchObject({ code: 'PROVIDER_ERROR', details: { turnEnd } });
  });

  it('fails PROVIDER_ERROR on an error turn, with a short error summary', async () => {
    const { dir, adapter } = setup({ mode: 'error-turn', error: 'x'.repeat(1000) });
    const error = await adapter
      .execute(
        { task: makeTask({ workingDirectory: dir }), resource: deepseekHarnessResource() },
        makeContext(),
      )
      .catch((e: unknown) => e as Error);
    expect(error).toMatchObject({ code: 'PROVIDER_ERROR', details: { turnEnd: 'error' } });
    expect((error as Error).message.length).toBeLessThan(400);
  });

  it('maps an auth failure inside an error turn to AUTH_REQUIRED', async () => {
    const { dir, adapter } = setup({ mode: 'error-turn', error: 'HTTP 401 Unauthorized' });
    await expect(
      adapter.execute(
        { task: makeTask({ workingDirectory: dir }), resource: deepseekHarnessResource() },
        makeContext(),
      ),
    ).rejects.toMatchObject({ code: 'AUTH_REQUIRED' });
  });

  it('accepts idle without turn/end when text exists, else fails', async () => {
    const ok = setup({ mode: 'no-turn-end' });
    const result = await ok.adapter.execute(
      { task: makeTask({ workingDirectory: ok.dir }), resource: deepseekHarnessResource() },
      makeContext(),
    );
    expect(result.text).toBe('text without turn end');

    const empty = setup({ mode: 'no-turn-end-empty' });
    await expect(
      empty.adapter.execute(
        { task: makeTask({ workingDirectory: empty.dir }), resource: deepseekHarnessResource() },
        makeContext(),
      ),
    ).rejects.toMatchObject({ code: 'PROVIDER_ERROR' });
  });

  it('fails closed on an unexpected runtime identity', async () => {
    const { dir, adapter } = setup({ mode: 'wrong-identity' });
    await expect(
      adapter.execute(
        { task: makeTask({ workingDirectory: dir }), resource: deepseekHarnessResource() },
        makeContext(),
      ),
    ).rejects.toMatchObject({
      code: 'INTEGRATION_UNAVAILABLE',
      message: expect.stringContaining('unexpected runtime identity') as string,
    });
  });

  it('maps a crash before idle to PROVIDER_ERROR carrying the stderr tail, never the prompt', async () => {
    const { dir, adapter } = setup({ mode: 'crash-after-prompt', stderr: 'kaboom happened' });
    const error = await adapter
      .execute(
        { task: makeTask({ workingDirectory: dir }), resource: deepseekHarnessResource() },
        makeContext(),
      )
      .catch((e: unknown) => e as Error);
    expect(error).toMatchObject({ code: 'PROVIDER_ERROR', details: { exitCode: 3 } });
    expect((error as Error).message).toContain('kaboom happened');
    expect((error as Error).message).not.toContain('SECRET-PROMPT-TEXT');
  });

  it('truncates stderr to the last 500 characters', async () => {
    const { dir, adapter } = setup({
      mode: 'crash-after-prompt',
      stderr: `${'a'.repeat(900)}TAIL`,
    });
    const error = await adapter
      .execute(
        { task: makeTask({ workingDirectory: dir }), resource: deepseekHarnessResource() },
        makeContext(),
      )
      .catch((e: unknown) => e as Error);
    expect((error as Error).message).toContain('TAIL');
    expect((error as Error).message.length).toBeLessThan(600);
  });

  it.each([
    'missing API key for provider',
    'apiKeyEnv not set',
    'HTTP 401',
    'Unauthorized request',
  ])('maps stderr %j to AUTH_REQUIRED', async (stderr) => {
    const { dir, adapter } = setup({ mode: 'crash-on-init', stderr });
    await expect(
      adapter.execute(
        { task: makeTask({ workingDirectory: dir }), resource: deepseekHarnessResource() },
        makeContext(),
      ),
    ).rejects.toMatchObject({ code: 'AUTH_REQUIRED' });
  });

  it('redacts the credential value if the runtime echoes it on stderr', async () => {
    const { dir, adapter } = setup({
      mode: 'crash-on-init',
      stderr: 'bad key sk-test-key-123 rejected',
    });
    const error = await adapter
      .execute(
        { task: makeTask({ workingDirectory: dir }), resource: deepseekHarnessResource() },
        makeContext(),
      )
      .catch((e: unknown) => e as Error);
    expect((error as Error).message).not.toContain('sk-test-key-123');
    expect((error as Error).message).toContain('[redacted]');
  });

  it('maps a missing binary to INTEGRATION_UNAVAILABLE', async () => {
    const dir = makeTempDir();
    const adapter = new DeepSeekHarnessExecutionAdapter({
      binary: join(dir, 'no-such-dsh'),
      stateDir: join(dir, 'state'),
      env: ENV,
    });
    await expect(
      adapter.execute(
        { task: makeTask({ workingDirectory: dir }), resource: deepseekHarnessResource() },
        makeContext(),
      ),
    ).rejects.toMatchObject({ code: 'INTEGRATION_UNAVAILABLE' });
  });

  it('surfaces garbage on the wire as PROVIDER_ERROR', async () => {
    const { dir, adapter } = setup({ mode: 'garbage-line' });
    await expect(
      adapter.execute(
        { task: makeTask({ workingDirectory: dir }), resource: deepseekHarnessResource() },
        makeContext(),
      ),
    ).rejects.toMatchObject({ code: 'PROVIDER_ERROR' });
  });

  it('times out a hung run and kills the child', async () => {
    const { dir, adapter } = setup({ mode: 'hang' });
    const resource = deepseekHarnessResource({
      runtime: {
        adapter: adapterId('deepseek-harness'),
        locality: 'local',
        options: { model: 'm', timeoutMs: 400 },
      },
    });
    const started = Date.now();
    await expect(
      adapter.execute({ task: makeTask({ workingDirectory: dir }), resource }, makeContext()),
    ).rejects.toMatchObject({ code: 'EXECUTION_TIMEOUT' });
    expect(Date.now() - started).toBeLessThan(8000);
  });

  it('cancels on abort', async () => {
    const { dir, adapter } = setup({ mode: 'hang' });
    const ac = new AbortController();
    setTimeout(() => ac.abort(), 300);
    await expect(
      adapter.execute(
        { task: makeTask({ workingDirectory: dir }), resource: deepseekHarnessResource() },
        makeContext({ signal: ac.signal }),
      ),
    ).rejects.toMatchObject({ code: 'EXECUTION_CANCELLED' });
  });

  it('rejects an already-aborted signal without doing work', async () => {
    const { dir, stateDir, adapter } = setup({ mode: 'hang' });
    const ac = new AbortController();
    ac.abort();
    await expect(
      adapter.execute(
        { task: makeTask({ workingDirectory: dir }), resource: deepseekHarnessResource() },
        makeContext({ signal: ac.signal }),
      ),
    ).rejects.toMatchObject({ code: 'EXECUTION_CANCELLED' });
    expect(existsSync(stateDir)).toBe(false);
  });

  it('rejects invalid runtime options before launching anything', async () => {
    const { dir, stateDir, adapter } = setup();
    const resource = deepseekHarnessResource({
      runtime: {
        adapter: adapterId('deepseek-harness'),
        locality: 'local',
        options: { maxTokens: 'lots' },
      },
    });
    await expect(
      adapter.execute({ task: makeTask({ workingDirectory: dir }), resource }, makeContext()),
    ).rejects.toMatchObject({ code: 'CONFIGURATION_ERROR' });
    expect(existsSync(stateDir)).toBe(false);
  });

  it('defaults stateDir under the task working directory', async () => {
    const dir = makeTempDir();
    const adapter = new DeepSeekHarnessExecutionAdapter({ binary: fakeBinary(), env: ENV });
    await adapter.execute(
      { task: makeTask({ workingDirectory: dir }), resource: deepseekHarnessResource() },
      makeContext(),
    );
    expect(existsSync(join(dir, '.nexar', 'runtimes', 'deepseek-harness', 'nexar.patch.yml'))).toBe(
      true,
    );
  });
});

describe('DeepSeekHarnessExecutionAdapter.supports', () => {
  it('matches only its own adapter id', () => {
    const adapter = new DeepSeekHarnessExecutionAdapter();
    expect(adapter.supports(deepseekHarnessResource())).toBe(true);
    const other: ResourceDescriptor = deepseekHarnessResource({
      runtime: { adapter: adapterId('other'), locality: 'local' },
    });
    expect(adapter.supports(other)).toBe(false);
  });
});

describe('DeepSeekHarnessExecutionAdapter.probe', () => {
  const now = () => new Date('2026-02-03T04:05:06.000Z');
  const signal = new AbortController().signal;

  function prober(settings: Record<string, string>, env: NodeJS.ProcessEnv = ENV) {
    return new DeepSeekHarnessExecutionAdapter({
      binary: fakeBinary(settings),
      stateDir: join(makeTempDir(), 'state'),
      env,
      now,
    });
  }

  it('reports available + authenticated for the pinned version', async () => {
    const state = await prober({}).probe(deepseekHarnessResource(), signal);
    expect(state).toEqual({
      availability: 'available',
      auth: 'authenticated',
      detail: `dsh ${DSH_PINNED_VERSION}`,
      observedAt: '2026-02-03T04:05:06.000Z',
    });
  });

  it('reports degraded on a version mismatch', async () => {
    const state = await prober({ version: '0.3.0' }).probe(deepseekHarnessResource(), signal);
    expect(state.availability).toBe('degraded');
    expect(state.detail).toBe('dsh 0.3.0 (expected 0.2.1-rc.3)');
  });

  it('reports unauthenticated when the credential env var is absent', async () => {
    const state = await prober({}, { PATH: process.env.PATH }).probe(
      deepseekHarnessResource(),
      signal,
    );
    expect(state.availability).toBe('available');
    expect(state.auth).toBe('unauthenticated');
  });

  it('reports unknown auth for runtime-managed credentials and not-required for none', async () => {
    const managed = deepseekHarnessResource({
      auth: { mode: 'oauth', credential: { source: 'runtime-managed', description: 'login' } },
    });
    expect((await prober({}).probe(managed, signal)).auth).toBe('unknown');
    const none = deepseekHarnessResource({ auth: { mode: 'none' } });
    expect((await prober({}).probe(none, signal)).auth).toBe('not-required');
  });

  it('reports unavailable when the binary is missing', async () => {
    const adapter = new DeepSeekHarnessExecutionAdapter({
      binary: join(makeTempDir(), 'no-such-dsh'),
      env: ENV,
      now,
    });
    const state = await adapter.probe(deepseekHarnessResource(), signal);
    expect(state.availability).toBe('unavailable');
    expect(state.auth).toBe('authenticated');
  });

  it('never spawns the runtime: only --version is run, no state is written', async () => {
    const dir = makeTempDir();
    const recordPath = join(dir, 'record.json');
    const adapter = new DeepSeekHarnessExecutionAdapter({
      binary: fakeBinary({ record: recordPath }),
      stateDir: join(dir, 'state'),
      env: ENV,
      now,
    });
    await adapter.probe(deepseekHarnessResource(), signal);
    expect(existsSync(recordPath)).toBe(false); // fake exits on --version before recording
    expect(existsSync(join(dir, 'state'))).toBe(false);
  });

  it('reports unavailable when aborted', async () => {
    const ac = new AbortController();
    ac.abort();
    const state = await prober({}).probe(deepseekHarnessResource(), ac.signal);
    expect(state.availability).toBe('unavailable');
  });
});

async function rejection(promise: Promise<unknown>): Promise<NexarError> {
  try {
    await promise;
  } catch (e) {
    expect(e).toBeInstanceOf(NexarError);
    return e as NexarError;
  }
  throw new Error('expected the call to reject');
}

describe('DeepSeekHarnessExecutionAdapter keystore credentials', () => {
  const NAME = 'DEEPSEEK_API_KEY';
  const STORED = 'sk-keystore-value-789';
  const PARENT = 'sk-parent-env-value-000';
  const signal = new AbortController().signal;
  const keystoreResource = (
    options: Record<string, unknown> = { model: 'deepseek-v4-flash' },
  ): ResourceDescriptor =>
    deepseekHarnessResource({
      auth: { mode: 'api-key', credential: { source: 'keystore', name: NAME } },
      runtime: { adapter: adapterId('deepseek-harness'), locality: 'local', options },
    });

  function build(
    settings: Record<string, string>,
    resolveSecret: SecretResolver | undefined,
    env: NodeJS.ProcessEnv = { PATH: process.env.PATH, HOME: '/home/test', [NAME]: PARENT },
  ) {
    const dir = makeTempDir();
    const recordPath = join(dir, 'record.json');
    const adapter = new DeepSeekHarnessExecutionAdapter({
      binary: fakeBinary({ record: recordPath, ...settings }),
      stateDir: join(dir, 'state'),
      env,
      initializeTimeoutMs: 5000,
      defaultTimeoutMs: 20_000,
      ...(resolveSecret === undefined ? {} : { resolveSecret }),
    });
    return { dir, recordPath, adapter };
  }

  it('gives the child the keystore variable and a resolver-only name set', async () => {
    const asked: string[] = [];
    const { dir, recordPath, adapter } = build({}, (name) => {
      asked.push(name);
      return STORED;
    });
    const logs: LogLine[] = [];
    const result = await adapter.execute(
      { task: makeTask({ workingDirectory: dir }), resource: keystoreResource() },
      makeContext({ logs }),
    );
    expect(result.text).toBe('final answer');
    expect(readRecord(recordPath).envKeys).toContain(NAME);
    expect(new Set(asked)).toEqual(new Set([NAME]));
    expect(JSON.stringify({ result, logs })).not.toContain(STORED);
  });

  it('names a keystore piAiProviders variable in the overlay and the child env', async () => {
    const { dir, recordPath, adapter } = build({}, (name) =>
      name === 'ANTHROPIC_API_KEY' || name === NAME ? STORED : undefined,
    );
    await adapter.execute(
      {
        task: makeTask({ workingDirectory: dir }),
        resource: keystoreResource({
          model: 'm',
          piAiProviders: { anthropic: { keystore: 'ANTHROPIC_API_KEY' } },
        }),
      },
      makeContext(),
    );
    const record = readRecord(recordPath);
    expect(record.envKeys).toContain('ANTHROPIC_API_KEY');
    expect(record.overlay).toContain('"anthropic":\n        apiKeyEnv: "ANTHROPIC_API_KEY"');
    expect(record.overlay).not.toContain(STORED);
  });

  it.each([
    ['no resolver', undefined],
    ['an unknown name', () => undefined],
    ['an empty value', () => ''],
  ])(
    'is AUTH_REQUIRED for %s even when the parent env has the same variable',
    async (_label, resolveSecret) => {
      const { dir, recordPath, adapter } = build({}, resolveSecret);
      const error = await rejection(
        adapter.execute(
          { task: makeTask({ workingDirectory: dir }), resource: keystoreResource() },
          makeContext(),
        ),
      );
      expect(error.code).toBe('AUTH_REQUIRED');
      expect(error.message).toBe(`Credential ${NAME} is not stored in the Nexar key store`);
      expect(error.details).toEqual({ keystore: NAME });
      expect(JSON.stringify({ message: error.message, details: error.details })).not.toContain(
        PARENT,
      );
      expect(existsSync(recordPath)).toBe(false); // nothing was launched
    },
  );

  it('does not require a stored key for env references', async () => {
    const { dir, adapter } = build({}, () => undefined);
    const result = await adapter.execute(
      { task: makeTask({ workingDirectory: dir }), resource: deepseekHarnessResource() },
      makeContext(),
    );
    expect(result.text).toBe('final answer');
  });

  it('redacts the keystore value if the runtime echoes it', async () => {
    const { dir, adapter } = build(
      { mode: 'crash-on-init', stderr: `bad key ${STORED} rejected` },
      () => STORED,
    );
    const error = await rejection(
      adapter.execute(
        { task: makeTask({ workingDirectory: dir }), resource: keystoreResource() },
        makeContext(),
      ),
    );
    expect(error.message).not.toContain(STORED);
    expect(error.message).toContain('[redacted]');
  });

  it('redacts a keystore piAiProviders value too', async () => {
    const other = 'sk-provider-keystore-value';
    const { dir, adapter } = build(
      { mode: 'crash-on-init', stderr: `bad key ${other} rejected` },
      (name) => (name === NAME ? STORED : name === 'ANTHROPIC_API_KEY' ? other : undefined),
    );
    const error = await rejection(
      adapter.execute(
        {
          task: makeTask({ workingDirectory: dir }),
          resource: keystoreResource({
            model: 'm',
            piAiProviders: { anthropic: { keystore: 'ANTHROPIC_API_KEY' } },
          }),
        },
        makeContext(),
      ),
    );
    expect(error.message).not.toContain(other);
    expect(error.message).toContain('[redacted]');
  });

  it('probes authenticated only when the resolver holds a value', async () => {
    const stored = build({}, () => STORED).adapter;
    expect((await stored.probe(keystoreResource(), signal)).auth).toBe('authenticated');
    const missing = build({}, () => undefined).adapter;
    expect((await missing.probe(keystoreResource(), signal)).auth).toBe('unauthenticated');
    const empty = build({}, () => '').adapter;
    expect((await empty.probe(keystoreResource(), signal)).auth).toBe('unauthenticated');
    const noResolver = build({}, undefined).adapter;
    expect((await noResolver.probe(keystoreResource(), signal)).auth).toBe('unauthenticated');
  });
});
