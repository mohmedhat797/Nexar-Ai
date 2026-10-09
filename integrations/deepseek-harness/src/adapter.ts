import { spawn } from 'node:child_process';
import { join } from 'node:path';
import { NexarError } from '@nexar/contracts';
import type {
  AuthState,
  ExecutionAdapter,
  ExecutionContext,
  ExecutionRequest,
  ExecutionResult,
  ResourceDescriptor,
  ResourceState,
  SecretResolver,
} from '@nexar/contracts';
import type { ApprovalGate, ApprovalStore } from '@nexar/approvals';
import { executeAcp } from './acp/run.js';
import {
  assertKeystoreCredentialStored,
  buildBaseEnv,
  buildDshEnv,
  credentialVariable,
  resolveOwnCredential,
} from './env.js';
import { RunGuard } from './guard.js';
import { piAiProviderVariable } from './overlay.js';
import type { PiAiProviders } from './overlay.js';
import { parseRuntimeOptions } from './options.js';
import { DEEPSEEK_HARNESS_ADAPTER_ID, DSH_PINNED_VERSION } from './resource.js';
import { mapFailure } from './failure.js';
import { RunCollector, interpretRun } from './run-collector.js';
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
const DEFAULT_STATE_SUBDIR = join('.nexar', 'runtimes', 'deepseek-harness');

export interface DeepSeekHarnessAdapterOptions {
  /** `dsh` executable, or a command plus leading args. Default `'dsh'`. */
  readonly binary?: string | BinarySpec;
  /** Where the isolated `DSH_HOME` and patch overlay live. Default `<cwd>/.nexar/runtimes/deepseek-harness`. */
  readonly stateDir?: string;
  /** Environment the allowlist is applied to. Default `process.env`. */
  readonly env?: NodeJS.ProcessEnv;
  /**
   * Resolves `keystore` credential references (injected by the host). Without it a keystore
   * reference counts as not stored; the environment is never consulted for it.
   */
  readonly resolveSecret?: SecretResolver;
  readonly initializeTimeoutMs?: number;
  readonly defaultTimeoutMs?: number;
  readonly now?: () => Date;
  /**
   * Approvals for engineering lanes (ACP). Without a gate every `session/request_permission` is
   * rejected (deny by default). `store` additionally lets allow-listed tool decisions be recorded.
   */
  readonly approvals?: { readonly gate: ApprovalGate; readonly store?: ApprovalStore };
  /**
   * Absolute path, inside the lane sandbox, of the Node that runs the Intelligence Bridge relay for
   * a gateway session. Default: the `binary` command when it is itself an absolute `node` path.
   */
  readonly nodeCommand?: string;
}

/**
 * Runs tasks on DeepSeek Harness. Ordinary tasks drive an external `dsh --profile sdk` process;
 * engineering lanes (a context carrying a workspace) run `dsh --profile acp` through the
 * workspace's launcher, with every permission request answered via Nexar approvals.
 */
export class DeepSeekHarnessExecutionAdapter implements ExecutionAdapter {
  readonly id = DEEPSEEK_HARNESS_ADAPTER_ID;
  readonly displayName = 'DeepSeek Harness';

  private readonly binary: BinarySpec;
  private readonly stateDir: string | undefined;
  private readonly env: NodeJS.ProcessEnv;
  private readonly resolveSecret: SecretResolver | undefined;
  private readonly initializeTimeoutMs: number;
  private readonly defaultTimeoutMs: number;
  private readonly now: () => Date;
  private readonly approvals: DeepSeekHarnessAdapterOptions['approvals'];
  private readonly nodeCommand: string | undefined;

  constructor(options: DeepSeekHarnessAdapterOptions = {}) {
    this.binary = normalizeBinary(options.binary);
    this.stateDir = options.stateDir;
    this.env = options.env ?? process.env;
    this.resolveSecret = options.resolveSecret;
    this.initializeTimeoutMs = options.initializeTimeoutMs ?? DEFAULT_INITIALIZE_TIMEOUT_MS;
    this.defaultTimeoutMs = options.defaultTimeoutMs ?? DEFAULT_RUN_TIMEOUT_MS;
    this.now = options.now ?? (() => new Date());
    this.approvals = options.approvals;
    this.nodeCommand = options.nodeCommand;
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
    if (context.workspace !== undefined) {
      return executeAcp(request, context, context.workspace, {
        binary: this.binary,
        stateDir: this.stateDir ?? join(process.cwd(), DEFAULT_STATE_SUBDIR),
        env: this.env,
        resolveSecret: this.resolveSecret,
        approvals: this.approvals,
        initializeTimeoutMs: this.initializeTimeoutMs,
        defaultTimeoutMs: this.defaultTimeoutMs,
        nodeCommand: this.nodeCommand,
      });
    }
    const runtime = parseRuntimeOptions(resource);
    const cwd = task.input.workingDirectory ?? process.cwd();
    const stateDir = this.stateDir ?? join(cwd, DEFAULT_STATE_SUBDIR);
    const timeoutMs = runtime.timeoutMs ?? this.defaultTimeoutMs;
    assertKeystoreCredentialStored(resource, this.credentialSources());
    const env = buildDshEnv(this.env, resource, {
      stateDir,
      piAiProviders: runtime.piAiProviders,
      resolveSecret: this.resolveSecret,
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
    if (credentialVariable(resource) === undefined) return 'unknown';
    const value = resolveOwnCredential(resource, this.credentialSources());
    return value !== undefined && value !== '' ? 'authenticated' : 'unauthenticated';
  }

  private credentialSources(): { env: NodeJS.ProcessEnv; resolveSecret?: SecretResolver } {
    return this.resolveSecret === undefined
      ? { env: this.env }
      : { env: this.env, resolveSecret: this.resolveSecret };
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
  piAiProviders: PiAiProviders | undefined,
): string[] {
  const names = [
    credentialVariable(resource)?.name,
    ...Object.values(piAiProviders ?? {}).map((p) => piAiProviderVariable(p).name),
  ];
  return names.flatMap((name) => {
    const value = name === undefined ? undefined : env[name];
    return value === undefined ? [] : [value];
  });
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
