import type { spawn } from 'node:child_process';
import { spawnRuntime } from '@nexar/process';
import { NexarError } from '@nexar/contracts';
import type {
  ExecutionAdapter,
  ExecutionContext,
  ExecutionRequest,
  ExecutionResult,
  LaunchSpec,
  PreparedLaunch,
  ResourceDescriptor,
  ResourceState,
} from '@nexar/contracts';
import {
  AgyStreamParser,
  classifyFailure,
  isInteractiveOAuth,
  isPermissionDenial,
  parseAgyErrorLine,
  toUsage,
} from './parse.js';
import { runProcess } from './process.js';
import type { ProcessOutcome } from './process.js';
import { ANTIGRAVITY_ADAPTER_ID } from './resource.js';
import { readSettings } from './settings.js';
import type { AntigravitySettings } from './settings.js';

/** The `agy` version the argv and stream-json handling were verified against (fixtures only). */
export const TESTED_AGY_VERSION = '1.2.14';

/** Where the task worktree appears inside the Nexar sandbox. */
export const SANDBOX_WORKSPACE = '/work';

/** The prompt is an argv entry (visible in the host's process list), so it is capped. */
export const MAX_PROMPT_BYTES = 100_000;

const DEFAULT_TIMEOUT_MS = 30 * 60 * 1000;
const PROBE_TIMEOUT_MS = 5000;
const MESSAGE_CHARS = 200;
const RESEARCH_NOTE = 'docs/research/upstream/v0.3/antigravity.md';

/** A binary name, or a command plus prefix args (e.g. `node fake-agy.mjs` in tests). */
export type AgyBinary = string | { readonly command: string; readonly args: readonly string[] };

export interface AntigravityAdapterOptions {
  /** Default `'agy'`; `runtime.options.binary` overrides per resource. */
  readonly binary?: AgyBinary;
  /** Default 30 minutes; `runtime.options.timeoutMs` overrides per resource. */
  readonly defaultTimeoutMs?: number;
  /** Environment the probe derives its `PATH`/`HOME` from; default `process.env`. */
  readonly env?: NodeJS.ProcessEnv;
  /** Test seam. */
  readonly spawnImpl?: typeof spawn;
  /** Test seam for `observedAt`. */
  readonly clock?: () => Date;
  /** Test seam for the SIGKILL grace period. */
  readonly killGraceMs?: number;
}

/**
 * Builds the argv (excluding any binary prefix args). `--dangerously-skip-permissions` is what
 * lets headless `agy` act unattended; it is acceptable only because the process runs inside
 * Nexar's sandbox, which is the security boundary (`--sandbox` is deliberately not passed:
 * nesting inside Nexar's sandbox is unverified). The `--print=<prompt>` form keeps a prompt that
 * starts with `-` from being parsed as a flag; `agy` takes the prompt only from argv in this mode.
 */
export function buildAgyArgs(settings: AntigravitySettings, prompt: string): string[] {
  const args = [
    '--output-format',
    'stream-json',
    '--dangerously-skip-permissions',
    '--add-dir',
    SANDBOX_WORKSPACE,
    '--disable-slash-commands',
  ];
  if (settings.model !== undefined) args.push('--model', settings.model);
  if (settings.effort !== undefined) args.push('--effort', settings.effort);
  args.push(`--print=${prompt}`);
  return args;
}

/**
 * EXPERIMENTAL. Runs engineering-lane tasks through the official, locally installed and
 * signed-in `agy` CLI, inside the Nexar sandbox only. Nexar never reads or copies Google
 * credentials; it only launches the unmodified binary.
 */
export class AntigravityExecutionAdapter implements ExecutionAdapter {
  readonly id = ANTIGRAVITY_ADAPTER_ID;
  readonly displayName = 'Antigravity (experimental, native CLI)';

  private readonly command: string;
  private readonly prefixArgs: readonly string[];
  private readonly defaultTimeoutMs: number;
  private readonly parentEnv: NodeJS.ProcessEnv;
  private readonly spawnImpl: typeof spawn;
  private readonly clock: () => Date;
  private readonly killGraceMs: number | undefined;
  private runtimeVersion: string | undefined;
  /** At most one running `agy` per adapter instance (stay within "ordinary use"). */
  private running = false;

  constructor(options: AntigravityAdapterOptions = {}) {
    const binary = options.binary ?? 'agy';
    this.command = typeof binary === 'string' ? binary : binary.command;
    this.prefixArgs = typeof binary === 'string' ? [] : binary.args;
    this.defaultTimeoutMs = options.defaultTimeoutMs ?? DEFAULT_TIMEOUT_MS;
    this.parentEnv = options.env ?? process.env;
    this.spawnImpl = options.spawnImpl ?? spawnRuntime;
    this.clock = options.clock ?? (() => new Date());
    this.killGraceMs = options.killGraceMs;
  }

  supports(resource: ResourceDescriptor): boolean {
    return resource.runtime.adapter === this.id;
  }

  /**
   * Installation/version probe only. Catalog refresh belongs to the owner-triggered inventory
   * source; neither installation nor a model list establishes the runtime's authentication.
   */
  async probe(resource: ResourceDescriptor, signal: AbortSignal): Promise<ResourceState> {
    const observedAt = this.clock().toISOString();
    const settings = readSettings(resource);
    const env = this.probeEnv();
    const [command, prefix] = this.binaryFor(settings);

    const version = await this.runProbe(command, [...prefix, '--version'], env, signal);
    if (version.outcome.kind === 'aborted') throw cancelled();
    if (version.outcome.kind === 'spawn-error') {
      return unavailableState(observedAt, 'agy binary not runnable');
    }
    if (version.outcome.kind === 'timeout') {
      return unavailableState(observedAt, 'agy --version timed out');
    }
    if (version.outcome.kind !== 'exited' || version.outcome.exitCode !== 0) {
      return unavailableState(observedAt, 'agy --version failed');
    }
    const line = version.lines.find((l) => l.trim() !== '')?.trim() ?? '';
    const match =
      line.length <= 100
        ? /^(?:agy )?(\d{1,5}\.\d{1,5}\.\d{1,5})(?:-[A-Za-z0-9]+(?:[.-][A-Za-z0-9]+)*)?(?:\+[A-Za-z0-9]+(?:[.-][A-Za-z0-9]+)*)?$/.exec(
            line,
          )
        : null;
    this.runtimeVersion = match?.[1];
    let detail = this.runtimeVersion === undefined ? 'agy' : `agy ${this.runtimeVersion}`;
    if (this.runtimeVersion !== TESTED_AGY_VERSION) {
      detail = `${detail} (Nexar tested with agy ${TESTED_AGY_VERSION})`;
    }

    if (!settings.acknowledgeExperimental) {
      return {
        availability: 'degraded',
        auth: 'unknown',
        detail: `experimental: set acknowledgeExperimental (${detail})`,
        observedAt,
      };
    }
    return { availability: 'available', auth: 'unknown', detail, observedAt };
  }

  async execute(request: ExecutionRequest, context: ExecutionContext): Promise<ExecutionResult> {
    const { task, resource } = request;
    const settings = readSettings(resource);

    if (!settings.acknowledgeExperimental) {
      throw new NexarError(
        'CONFIGURATION_ERROR',
        `Resource '${resource.id}' uses the experimental Antigravity adapter: it is unverified ` +
          'with authenticated runs, and the Antigravity Terms forbid third-party access with its ' +
          `OAuth tokens (this adapter only drives the official binary). See ${RESEARCH_NOTE}, ` +
          'then set runtime.options.acknowledgeExperimental to true to opt in.',
        { details: { resourceId: resource.id, option: 'acknowledgeExperimental' } },
      );
    }
    // Refuse before anything is prepared or spawned: headless `agy` runs unattended only with
    // `--dangerously-skip-permissions` and has no structural no-commit guarantee outside a sandbox.
    const workspace = context.workspace;
    if (workspace === undefined || workspace.launcher.isolation !== 'sandbox') {
      throw new NexarError(
        'POLICY_REJECTED',
        'Antigravity runs only in an engineering workspace with the Nexar sandbox',
        { details: { adapter: 'antigravity' } },
      );
    }

    // `agy` has no system-prompt flag, so the system prompt is prepended to the prompt.
    const systemPrompt = task.input.systemPrompt;
    const prompt =
      systemPrompt !== undefined && systemPrompt !== ''
        ? `${systemPrompt}\n\n---\n\n${task.input.prompt}`
        : task.input.prompt;
    const promptBytes = Buffer.byteLength(prompt);
    if (promptBytes > MAX_PROMPT_BYTES) {
      throw new NexarError(
        'VALIDATION_ERROR',
        `Prompt is ${promptBytes} bytes; agy takes it as a command-line argument (max ${MAX_PROMPT_BYTES})`,
        { details: { bytes: promptBytes, maxBytes: MAX_PROMPT_BYTES } },
      );
    }
    if (context.signal.aborted) throw cancelled();

    if (this.running) {
      throw new NexarError(
        'RESOURCE_UNAVAILABLE',
        'Antigravity already has a run in progress (one at a time)',
        { retryable: true, details: { adapter: 'antigravity' } },
      );
    }
    this.running = true;
    try {
      return await this.run(workspace, settings, prompt, context);
    } finally {
      this.running = false;
    }
  }

  private async run(
    workspace: NonNullable<ExecutionContext['workspace']>,
    settings: AntigravitySettings,
    prompt: string,
    context: ExecutionContext,
  ): Promise<ExecutionResult> {
    const logger = context.logger.child({ adapter: this.id });
    // Never log argv or stderr: they carry the prompt and user content.
    logger.debug('starting agy', { model: settings.model });

    const [command, prefix] = this.binaryFor(settings);
    const timeoutMs = settings.timeoutMs ?? this.defaultTimeoutMs;
    const parser = new AgyStreamParser();

    // An interactive sign-in attempt can never finish headless: stop it as soon as it shows.
    const stopper = new AbortController();
    let oauthAttempted = false;
    let denials = 0;
    const onLine = (line: string): void => {
      if (!line.trimStart().startsWith('{') && isInteractiveOAuth(line)) {
        oauthAttempted = true;
        stopper.abort();
        return;
      }
      for (const event of parser.push(line)) context.onEvent?.(event);
    };
    const onStderrLine = (line: string): void => {
      if (isInteractiveOAuth(line)) {
        oauthAttempted = true;
        stopper.abort();
      } else if (isPermissionDenial(line)) {
        denials += 1;
        context.onEvent?.({ type: 'status', message: `agy: permission denied (${denials})` });
      }
    };

    const spec: LaunchSpec = {
      command,
      args: [...prefix, ...buildAgyArgs(settings, prompt)],
      env: { LANG: 'C.UTF-8' },
      workspace: workspace.path,
      workspaceAccess: workspace.access,
      network: { mode: 'proxy', allowHosts: settings.allowHosts },
      ...(settings.mounts !== undefined && settings.mounts.length > 0
        ? { mounts: settings.mounts }
        : {}),
    };

    let outcome: ProcessOutcome;
    const prepared = await workspace.launcher.prepare(spec, context.signal);
    try {
      // Re-check what the launcher actually applied before running with permissions skipped.
      if (prepared.isolation !== 'sandbox') {
        throw new NexarError(
          'POLICY_REJECTED',
          'Launcher did not apply the sandbox; refusing to run Antigravity',
        );
      }
      if (prepared.workspacePath !== SANDBOX_WORKSPACE) {
        throw new NexarError(
          'SANDBOX_UNAVAILABLE',
          `Launcher mounted the workspace somewhere other than ${SANDBOX_WORKSPACE}`,
        );
      }
      outcome = await runProcess({
        ...preparedSpawn(prepared),
        timeoutMs,
        signal: AbortSignal.any([context.signal, stopper.signal]),
        spawnImpl: this.spawnImpl,
        onLine,
        onStderrLine,
        onSpawn: () => context.onEvent?.({ type: 'status', message: 'agy: started' }),
        ...(this.killGraceMs !== undefined ? { killGraceMs: this.killGraceMs } : {}),
      });
    } finally {
      await prepared.dispose();
    }

    if (oauthAttempted) {
      throw new NexarError(
        'AUTH_REQUIRED',
        "agy tried to start an interactive sign-in; sign in with 'agy' yourself first",
      );
    }
    switch (outcome.kind) {
      case 'spawn-error':
        throw spawnFailure(outcome.error, command);
      case 'aborted':
        throw cancelled();
      case 'timeout':
        throw new NexarError('EXECUTION_TIMEOUT', `agy did not finish within ${timeoutMs} ms`, {
          details: { timeoutMs },
        });
      case 'overflow':
        throw new NexarError('PROVIDER_ERROR', 'agy output exceeded the size limit');
      case 'exited':
        break;
    }

    const parsed = parser.result();
    const agyError = parseAgyErrorLine(outcome.stderr);
    const details = { exitCode: outcome.exitCode, permissionDenials: denials };
    const succeeded = outcome.exitCode === 0 && parsed.sawResult && parsed.status === 'SUCCESS';
    if (!succeeded) {
      const agyEvidence =
        agyError === undefined ? undefined : [agyError.status, agyError.code].join(' ').trim();
      const evidence =
        parsed.error ??
        (agyEvidence === undefined || agyEvidence === '' ? undefined : agyEvidence) ??
        (parsed.sawResult && parsed.status !== undefined ? `status ${parsed.status}` : undefined) ??
        outcome.stderr;
      const message = truncate(redact(evidence, prompt).trim());
      const code = classifyFailure(
        `${parsed.error ?? ''}\n${agyEvidence ?? ''}\n${redact(outcome.stderr, prompt)}`,
      );
      const noResult =
        outcome.exitCode === 0 && !parsed.sawResult ? 'agy produced no result' : undefined;
      throw new NexarError(
        code,
        `agy failed (exit ${outcome.exitCode})${message === '' ? '' : `: ${message}`}` +
          (noResult === undefined || message !== '' ? '' : `: ${noResult}`),
        {
          details,
          ...(agyError?.retryable !== undefined ? { retryable: agyError.retryable } : {}),
        },
      );
    }

    context.onEvent?.({
      type: 'status',
      message: denials > 0 ? `agy: finished (${denials} soft permission denials)` : 'agy: finished',
    });
    return {
      text: parsed.response ?? '',
      artifacts: [],
      usage: toUsage(parsed),
      resolved: {
        provider: 'google',
        ...(settings.model !== undefined ? { model: settings.model } : {}),
        ...(this.runtimeVersion !== undefined ? { runtimeVersion: this.runtimeVersion } : {}),
      },
      retries: 0,
    };
  }

  /** Probe env: `PATH` and `HOME` only (so `agy` finds itself and its own state); nothing else. */
  private probeEnv(): Record<string, string> {
    const env: Record<string, string> = {};
    for (const name of ['PATH', 'HOME'] as const) {
      const value = this.parentEnv[name];
      if (value !== undefined && value !== '') env[name] = value;
    }
    return env;
  }

  private binaryFor(settings: AntigravitySettings): [string, readonly string[]] {
    return settings.binary !== undefined ? [settings.binary, []] : [this.command, this.prefixArgs];
  }

  private async runProbe(
    command: string,
    args: readonly string[],
    env: Readonly<Record<string, string>>,
    signal: AbortSignal,
  ): Promise<{ outcome: ProcessOutcome; lines: string[] }> {
    const lines: string[] = [];
    const outcome = await runProcess({
      command,
      args,
      cwd: process.cwd(),
      env,
      timeoutMs: PROBE_TIMEOUT_MS,
      signal,
      spawnImpl: this.spawnImpl,
      onLine: (l) => lines.push(l),
      ...(this.killGraceMs !== undefined ? { killGraceMs: this.killGraceMs } : {}),
    });
    return { outcome, lines };
  }
}

function preparedSpawn(p: PreparedLaunch): {
  command: string;
  args: readonly string[];
  env: Readonly<Record<string, string>>;
  cwd: string;
} {
  return { command: p.command, args: p.args, env: p.env, cwd: p.cwd };
}

function redact(text: string, secret: string): string {
  return secret.length >= 4 ? text.split(secret).join('[redacted]') : text;
}

function truncate(s: string): string {
  return s.length > MESSAGE_CHARS ? `${s.slice(0, MESSAGE_CHARS)}…` : s;
}

function cancelled(): NexarError {
  return new NexarError('EXECUTION_CANCELLED', 'Execution was cancelled');
}

function spawnFailure(error: NodeJS.ErrnoException, command: string): NexarError {
  return new NexarError(
    'INTEGRATION_UNAVAILABLE',
    error.code === 'ENOENT'
      ? `agy binary not found (${command}); install Antigravity and sign in with 'agy'`
      : `agy could not be started: ${error.message}`,
    { cause: error, details: { errorCode: error.code } },
  );
}

function unavailableState(observedAt: string, detail: string): ResourceState {
  return { availability: 'unavailable', auth: 'unknown', detail, observedAt };
}
