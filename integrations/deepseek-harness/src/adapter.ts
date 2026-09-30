import { spawn } from 'node:child_process';
import { join } from 'node:path';
import { NexarError, isNexarError, toNexarError } from '@nexar/contracts';
import type {
  AuthState,
  ExecutionAdapter,
  ExecutionContext,
  ExecutionRequest,
  ExecutionResult,
  ResourceDescriptor,
  ResourceState,
} from '@nexar/contracts';
import { buildBaseEnv, buildDshEnv, credentialEnvName } from './env.js';
import { RunGuard } from './guard.js';
import { parseRuntimeOptions } from './options.js';
import { DEEPSEEK_HARNESS_ADAPTER_ID, DSH_PINNED_VERSION } from './resource.js';
import { RunCollector, interpretRun, isAuthFailureText } from './run-collector.js';
import {
  initializeRuntime,
  normalizeBinary,
  spawnRuntime,
  writeOverlay,
} from './runtime-process.js';
import type { BinarySpec, RuntimeProcess } from './runtime-process.js';

const DEFAULT_INITIALIZE_TIMEOUT_MS = 15_000;
const DEFAULT_RUN_TIMEOUT_MS = 15 * 60_000;
const PROBE_TIMEOUT_MS = 5_000;
const SHUTDOWN_TIMEOUT_MS = 2_000;
const STDERR_IN_ERROR_CHARS = 500;
const DEFAULT_STATE_SUBDIR = join('.nexar', 'runtimes', 'deepseek-harness');

export interface DeepSeekHarnessAdapterOptions {
  /** `dsh` executable, or a command plus leading args. Default `'dsh'`. */
  readonly binary?: string | BinarySpec;
  /** Where the isolated `DSH_HOME` and patch overlay live. Default `<cwd>/.nexar/runtimes/deepseek-harness`. */
  readonly stateDir?: string;
  /** Environment the allowlist is applied to. Default `process.env`. */
  readonly env?: NodeJS.ProcessEnv;
  readonly initializeTimeoutMs?: number;
  readonly defaultTimeoutMs?: number;
  readonly now?: () => Date;
}

/** Runs tasks on DeepSeek Harness by driving an external `dsh --profile sdk` process. */
export class DeepSeekHarnessExecutionAdapter implements ExecutionAdapter {
  readonly id = DEEPSEEK_HARNESS_ADAPTER_ID;
  readonly displayName = 'DeepSeek Harness';

  private readonly binary: BinarySpec;
  private readonly stateDir: string | undefined;
  private readonly env: NodeJS.ProcessEnv;
  private readonly initializeTimeoutMs: number;
  private readonly defaultTimeoutMs: number;
  private readonly now: () => Date;

  constructor(options: DeepSeekHarnessAdapterOptions = {}) {
    this.binary = normalizeBinary(options.binary);
    this.stateDir = options.stateDir;
    this.env = options.env ?? process.env;
    this.initializeTimeoutMs = options.initializeTimeoutMs ?? DEFAULT_INITIALIZE_TIMEOUT_MS;
    this.defaultTimeoutMs = options.defaultTimeoutMs ?? DEFAULT_RUN_TIMEOUT_MS;
    this.now = options.now ?? (() => new Date());
  }

  supports(resource: ResourceDescriptor): boolean {
    return resource.runtime.adapter === this.id;
  }

  async probe(resource: ResourceDescriptor, signal: AbortSignal): Promise<ResourceState> {
    const observedAt = this.now().toISOString();
    const auth = this.probeAuth(resource);
    const stateDir = this.stateDir ?? join(process.cwd(), DEFAULT_STATE_SUBDIR);
    const outcome = await runVersion(this.binary, buildBaseEnv(this.env, stateDir), signal);

    if (outcome.kind === 'failed') {
      return { availability: 'unavailable', auth, detail: outcome.detail, observedAt };
    }
    const { version } = outcome;
    if (version === undefined) {
      return { availability: 'degraded', auth, detail: 'dsh (version unknown)', observedAt };
    }
    if (version !== DSH_PINNED_VERSION) {
      return {
        availability: 'degraded',
        auth,
        detail: `dsh ${version} (expected ${DSH_PINNED_VERSION})`,
        observedAt,
      };
    }
    return { availability: 'available', auth, detail: `dsh ${version}`, observedAt };
  }

  async execute(request: ExecutionRequest, context: ExecutionContext): Promise<ExecutionResult> {
    const { task, resource } = request;
    const runtime = parseRuntimeOptions(resource);
    const cwd = task.input.workingDirectory ?? process.cwd();
    const stateDir = this.stateDir ?? join(cwd, DEFAULT_STATE_SUBDIR);
    const timeoutMs = runtime.timeoutMs ?? this.defaultTimeoutMs;
    const env = buildDshEnv(this.env, resource, {
      stateDir,
      piAiProviders: runtime.piAiProviders,
    });
    const secrets = secretValues(env, resource, runtime.piAiProviders);
    const emit = context.onEvent ?? (() => undefined);
    const logger = context.logger.child({ adapter: String(this.id), taskId: task.id });

    if (task.input.systemPrompt !== undefined || (task.input.attachments?.length ?? 0) > 0) {
      logger.warn('systemPrompt and attachments are not forwarded to dsh');
    }

    if (context.signal.aborted) {
      throw new NexarError('EXECUTION_CANCELLED', 'execution was cancelled');
    }
    const guard = new RunGuard(context.signal, timeoutMs);
    let proc: RuntimeProcess | undefined;
    try {
      emit({ type: 'status', message: 'Launching DeepSeek Harness' });
      logger.info('launching dsh', {
        command: this.binary.command,
        cwd,
        provider: runtime.provider,
        model: runtime.model,
      });
      const launch = {
        binary: this.binary,
        cwd,
        stateDir,
        env,
        patches: runtime.patches,
        piAiProviders: runtime.piAiProviders,
      };
      const overlayPath = await guard.race(writeOverlay(stateDir, runtime.piAiProviders));
      if (guard.interrupted) throw new NexarError('EXECUTION_CANCELLED', 'execution was cancelled');
      proc = spawnRuntime(launch, overlayPath);
      const running = proc;

      const serverInfo = await guard.race(
        initializeRuntime(
          running.client,
          {
            cwd,
            provider: runtime.provider,
            model: runtime.model,
            reasoningEffort: runtime.reasoningEffort,
            maxTokens: runtime.maxTokens,
          },
          this.initializeTimeoutMs,
        ),
      );
      emit({ type: 'status', message: `DeepSeek Harness runtime ready (${serverInfo.version})` });

      const sessionId = `nexar-${task.id}`;
      const collector = new RunCollector(sessionId, emit);
      running.client.onNotification((n) => collector.push(n));
      const idle = new Promise<void>((resolve, reject) => {
        void collector.whenDone().then(resolve);
        running.client.onClose((error) => (collector.done ? resolve() : reject(error)));
      });
      idle.catch(() => undefined);

      const receipt = await guard.race(
        running.client.request<{ messageId?: unknown }>('session/prompt', {
          sessionId,
          contentBlocks: [{ type: 'text', text: task.input.prompt }],
        }),
      );
      if (typeof receipt?.messageId !== 'string') {
        throw new NexarError('PROVIDER_ERROR', 'dsh answered session/prompt without a messageId', {
          details: { reason: 'protocol' },
        });
      }
      collector.setMessageId(receipt.messageId);

      await guard.race(idle);
      const run = interpretRun(collector.snapshot());
      if (run.truncated) {
        emit({
          type: 'status',
          message: 'dsh stopped at the token limit; output may be truncated',
        });
      }
      emit({ type: 'status', message: 'DeepSeek Harness run finished' });

      return {
        text: run.text,
        artifacts: [],
        usage: run.usage,
        resolved: {
          provider: runtime.provider,
          model: runtime.model,
          // serverInfo.version is the SDK server plugin's version, not the dsh CLI version.
          runtimeVersion: `${serverInfo.name}@${serverInfo.version}`,
        },
        retries: 0,
      };
    } catch (e) {
      throw await mapFailure(e, proc, secrets);
    } finally {
      guard.dispose();
      if (proc !== undefined) {
        if (!guard.interrupted && !proc.client.closed) await requestShutdown(proc);
        await proc.stop();
      }
    }
  }

  private probeAuth(resource: ResourceDescriptor): AuthState {
    if (resource.auth.mode === 'none') return 'not-required';
    const name = credentialEnvName(resource);
    if (name === undefined) return 'unknown';
    const value = this.env[name];
    return value !== undefined && value !== '' ? 'authenticated' : 'unauthenticated';
  }
}

async function requestShutdown(proc: RuntimeProcess): Promise<void> {
  await proc.client
    .request('shutdown', undefined, { timeoutMs: SHUTDOWN_TIMEOUT_MS })
    .catch(() => undefined);
  await proc.waitForExit(SHUTDOWN_TIMEOUT_MS);
}

function secretValues(
  env: Readonly<Record<string, string>>,
  resource: ResourceDescriptor,
  piAiProviders: Readonly<Record<string, { apiKeyEnv: string }>> | undefined,
): string[] {
  const names = [
    credentialEnvName(resource),
    ...Object.values(piAiProviders ?? {}).map((p) => p.apiKeyEnv),
  ];
  return names.flatMap((name) => {
    const value = name === undefined ? undefined : env[name];
    return value === undefined ? [] : [value];
  });
}

/** Turns anything thrown during a run into the `NexarError` Nexar callers expect. */
async function mapFailure(
  error: unknown,
  proc: RuntimeProcess | undefined,
  secrets: readonly string[],
): Promise<NexarError> {
  const closed = isNexarError(error) && error.details?.reason === 'closed';
  if (proc === undefined || !closed) return toNexarError(error, 'INTERNAL_ERROR');

  // The connection dropped: let the exit (or a spawn failure) land so we can explain why.
  await proc.waitForExit(SHUTDOWN_TIMEOUT_MS);
  if (proc.spawnError !== undefined) {
    const { code, path, syscall } = proc.spawnError;
    return new NexarError(
      'INTEGRATION_UNAVAILABLE',
      code === 'ENOENT'
        ? `could not launch dsh: '${path ?? 'binary'}' or the working directory was not found`
        : `could not launch dsh (${code ?? 'unknown error'})`,
      { cause: proc.spawnError, details: { code, syscall } },
    );
  }
  const exit = proc.exitInfo;
  const tail = proc.stderrTail(STDERR_IN_ERROR_CHARS, secrets);
  const how =
    exit === undefined
      ? 'closed its connection'
      : exit.signal !== null
        ? `was killed by ${exit.signal}`
        : `exited with code ${String(exit.code)}`;
  return new NexarError(
    isAuthFailureText(tail) ? 'AUTH_REQUIRED' : 'PROVIDER_ERROR',
    `dsh ${how} before finishing${tail.length > 0 ? `: ${tail}` : ''}`,
    { details: { exitCode: exit?.code ?? null, signal: exit?.signal ?? null } },
  );
}

type VersionOutcome =
  | { readonly kind: 'ok'; readonly version: string | undefined }
  | { readonly kind: 'failed'; readonly detail: string };

/** Runs `<binary> --version` (never the runtime itself), bounded by a timeout and the caller's signal. */
function runVersion(
  binary: BinarySpec,
  env: Record<string, string>,
  signal: AbortSignal,
): Promise<VersionOutcome> {
  return new Promise((resolve) => {
    if (signal.aborted) {
      resolve({ kind: 'failed', detail: 'probe aborted' });
      return;
    }
    let stdout = '';
    let settled = false;
    const child = spawn(binary.command, [...binary.args, '--version'], {
      env,
      stdio: ['ignore', 'pipe', 'ignore'],
      windowsHide: true,
    });
    const finish = (outcome: VersionOutcome): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      signal.removeEventListener('abort', onAbort);
      if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL');
      resolve(outcome);
    };
    const onAbort = (): void => finish({ kind: 'failed', detail: 'probe aborted' });
    const timer = setTimeout(
      () => finish({ kind: 'failed', detail: `'${binary.command} --version' timed out` }),
      PROBE_TIMEOUT_MS,
    );
    signal.addEventListener('abort', onAbort, { once: true });

    child.stdout.setEncoding('utf8');
    child.stdout.on('data', (chunk: string) => {
      stdout = (stdout + chunk).slice(0, 1000);
    });
    child.on('error', (err: NodeJS.ErrnoException) => {
      finish({
        kind: 'failed',
        detail:
          err.code === 'ENOENT'
            ? `'${binary.command}' not found`
            : `could not run '${binary.command}' (${err.code ?? 'error'})`,
      });
    });
    child.on('close', (code) => {
      if (code !== 0) {
        finish({
          kind: 'failed',
          detail: `'${binary.command} --version' exited with ${String(code)}`,
        });
        return;
      }
      const match = /\d+\.\d+\.\d+(?:[-+][0-9A-Za-z.-]+)?/.exec(stdout);
      finish({ kind: 'ok', version: match?.[0] });
    });
  });
}
