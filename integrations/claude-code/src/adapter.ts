import { spawn } from 'node:child_process';
import { estimated, measured, NexarError, unavailable } from '@nexar/contracts';
import type {
  AuthState,
  ExecutionAdapter,
  ExecutionContext,
  ExecutionRequest,
  ExecutionResult,
  Measured,
  ResourceDescriptor,
  ResourceState,
  UsageReport,
} from '@nexar/contracts';
import { buildChildEnv } from './env.js';
import { parseClaudeResult } from './parse.js';
import type { ParsedClaudeResult } from './parse.js';
import { runProcess } from './process.js';
import type { ProcessOutcome } from './process.js';
import { CLAUDE_CODE_ADAPTER_ID } from './resource.js';
import { readSettings } from './settings.js';
import type { ClaudeCodeSettings } from './settings.js';

const DEFAULT_TIMEOUT_MS = 10 * 60 * 1000;
const PROBE_TIMEOUT_MS = 5000;
const STDERR_EXCERPT_CHARS = 500;
const AUTH_FAILURE = /not logged in|authentication|\b401\b/i;
const NOT_REPORTED = 'not reported by claude CLI';

/** A binary name, or a command plus prefix args (e.g. `node fake-claude.mjs` in tests). */
export type ClaudeBinary = string | { readonly command: string; readonly args: readonly string[] };

export interface ClaudeCodeAdapterOptions {
  /** Default `'claude'`. */
  readonly binary?: ClaudeBinary;
  /** Default 10 minutes; `runtime.options.timeoutMs` overrides per resource. */
  readonly defaultTimeoutMs?: number;
  /** Environment to derive the child's from; default `process.env`. */
  readonly env?: NodeJS.ProcessEnv;
  /** Test seam. */
  readonly spawnImpl?: typeof spawn;
  /** Test seam for `observedAt`. */
  readonly clock?: () => Date;
}

/** Builds the argv (excluding any binary prefix args). The prompt is never part of it. */
export function buildClaudeArgs(
  settings: ClaudeCodeSettings,
  systemPrompt: string | undefined,
): string[] {
  const args = [
    '-p',
    '--output-format',
    'json',
    '--no-session-persistence',
    '--permission-mode',
    settings.permissionMode,
  ];
  if (settings.model !== undefined) args.push('--model', settings.model);
  if (settings.maxTurns !== undefined) args.push('--max-turns', String(settings.maxTurns));
  if (systemPrompt !== undefined && systemPrompt !== '') {
    args.push('--append-system-prompt', systemPrompt);
  }
  // `--tools` is variadic, so it goes last; an empty list disables all tools.
  args.push('--tools', ...(settings.tools.length > 0 ? settings.tools : ['']));
  return args;
}

function reported(n: number | undefined): Measured<number> {
  return n === undefined ? unavailable(NOT_REPORTED) : measured(n);
}

function toUsage(p: ParsedClaudeResult): UsageReport {
  return {
    inputTokens: reported(p.inputTokens),
    outputTokens: reported(p.outputTokens),
    cacheReadTokens: reported(p.cacheReadTokens),
    cacheWriteTokens: reported(p.cacheWriteTokens),
    costUsd:
      p.totalCostUsd === undefined
        ? unavailable(NOT_REPORTED)
        : estimated(p.totalCostUsd, 'claude CLI list-price estimate'),
    turns: reported(p.numTurns),
  };
}

/** Runs tasks through the locally installed, already-authenticated `claude` CLI in print mode. */
export class ClaudeCodeExecutionAdapter implements ExecutionAdapter {
  readonly id = CLAUDE_CODE_ADAPTER_ID;
  readonly displayName = 'Claude Code (native CLI)';

  private readonly command: string;
  private readonly prefixArgs: readonly string[];
  private readonly defaultTimeoutMs: number;
  private readonly parentEnv: NodeJS.ProcessEnv;
  private readonly spawnImpl: typeof spawn;
  private readonly clock: () => Date;
  private runtimeVersion: string | undefined;

  constructor(options: ClaudeCodeAdapterOptions = {}) {
    const binary = options.binary ?? 'claude';
    this.command = typeof binary === 'string' ? binary : binary.command;
    this.prefixArgs = typeof binary === 'string' ? [] : binary.args;
    this.defaultTimeoutMs = options.defaultTimeoutMs ?? DEFAULT_TIMEOUT_MS;
    this.parentEnv = options.env ?? process.env;
    this.spawnImpl = options.spawnImpl ?? spawn;
    this.clock = options.clock ?? (() => new Date());
  }

  supports(resource: ResourceDescriptor): boolean {
    return resource.runtime.adapter === this.id;
  }

  async probe(_resource: ResourceDescriptor, signal: AbortSignal): Promise<ResourceState> {
    const observedAt = this.clock().toISOString();
    const version = await this.runProbeCommand(['--version'], signal);

    if (version.kind === 'aborted') throw cancelled();
    if (version.kind === 'spawn-error') {
      return unavailableState(observedAt, `claude binary not runnable: ${version.error.message}`);
    }
    if (version.kind === 'timeout') {
      return unavailableState(observedAt, 'claude --version timed out');
    }
    if (version.exitCode !== 0) {
      return unavailableState(observedAt, `claude --version exited with ${version.exitCode}`);
    }
    const detail = version.stdout.trim().split(/\r?\n/)[0] ?? '';
    this.runtimeVersion = detail === '' ? undefined : detail;

    const status = await this.runProbeCommand(['auth', 'status'], signal);
    if (status.kind === 'aborted') throw cancelled();
    const auth = status.kind === 'exited' ? parseAuth(status.stdout) : 'unknown';
    return { availability: 'available', auth, detail, observedAt };
  }

  async execute(request: ExecutionRequest, context: ExecutionContext): Promise<ExecutionResult> {
    const { task, resource } = request;
    const settings = readSettings(resource);
    if (context.signal.aborted) throw cancelled();

    const args = [...this.prefixArgs, ...buildClaudeArgs(settings, task.input.systemPrompt)];
    const timeoutMs = settings.timeoutMs ?? this.defaultTimeoutMs;
    // Never log argv or the prompt: both can carry user content.
    const logger = context.logger.child({ adapter: this.id, resourceId: resource.id });
    logger.debug('spawning claude', {
      model: settings.model,
      permissionMode: settings.permissionMode,
    });

    const outcome = await runProcess({
      command: this.command,
      args,
      cwd: task.input.workingDirectory ?? process.cwd(),
      env: buildChildEnv(this.parentEnv),
      stdin: task.input.prompt,
      timeoutMs,
      signal: context.signal,
      spawnImpl: this.spawnImpl,
      onSpawn: () => context.onEvent?.({ type: 'status', message: 'claude: started' }),
    });

    switch (outcome.kind) {
      case 'spawn-error':
        throw spawnFailure(outcome.error, this.command);
      case 'aborted':
        throw cancelled();
      case 'timeout':
        throw new NexarError('EXECUTION_TIMEOUT', `claude did not finish within ${timeoutMs} ms`, {
          details: { timeoutMs },
        });
      case 'exited':
        break;
    }

    const parsed = parseClaudeResult(outcome.stdout);
    const subtype = parsed?.subtype;
    const details = { exitCode: outcome.exitCode, ...(subtype !== undefined ? { subtype } : {}) };

    if (parsed === undefined && outcome.exitCode === 0) {
      throw new NexarError('PROVIDER_ERROR', 'claude produced no parseable JSON result', {
        details,
      });
    }
    if (
      outcome.exitCode !== 0 ||
      parsed === undefined ||
      parsed.isError ||
      subtype?.startsWith('error')
    ) {
      throw failure(outcome, parsed, details);
    }

    context.onEvent?.({ type: 'status', message: 'claude: finished' });

    const model = parsed.model ?? settings.model;
    return {
      text: parsed.text,
      artifacts: [],
      usage: toUsage(parsed),
      resolved: {
        provider: 'anthropic',
        ...(model !== undefined ? { model } : {}),
        ...(this.runtimeVersion !== undefined ? { runtimeVersion: this.runtimeVersion } : {}),
      },
      retries: 0,
    };
  }

  private runProbeCommand(args: readonly string[], signal: AbortSignal): Promise<ProcessOutcome> {
    return runProcess({
      command: this.command,
      args: [...this.prefixArgs, ...args],
      cwd: process.cwd(),
      env: buildChildEnv(this.parentEnv),
      timeoutMs: PROBE_TIMEOUT_MS,
      signal,
      spawnImpl: this.spawnImpl,
    });
  }
}

function cancelled(): NexarError {
  return new NexarError('EXECUTION_CANCELLED', 'Execution was cancelled');
}

function spawnFailure(error: NodeJS.ErrnoException, command: string): NexarError {
  return new NexarError(
    'INTEGRATION_UNAVAILABLE',
    error.code === 'ENOENT'
      ? `claude binary not found (${command}); install Claude Code and run 'claude auth'`
      : `claude could not be started: ${error.message}`,
    { cause: error, details: { errorCode: error.code } },
  );
}

function failure(
  outcome: Extract<ProcessOutcome, { kind: 'exited' }>,
  parsed: ParsedClaudeResult | undefined,
  details: Record<string, unknown>,
): NexarError {
  const evidence = [outcome.stderr, parsed?.text ?? '', String(parsed?.apiErrorStatus ?? '')];
  const authFailure = evidence.some((s) => AUTH_FAILURE.test(s));

  const parts = [`exit ${outcome.exitCode}`];
  if (parsed?.subtype !== undefined) parts.push(`subtype ${parsed.subtype}`);
  if (parsed?.apiErrorStatus !== undefined) parts.push(`api status ${parsed.apiErrorStatus}`);
  const stderrTail = outcome.stderr.trim().slice(-STDERR_EXCERPT_CHARS);
  const message = `claude failed (${parts.join(', ')})${stderrTail === '' ? '' : `: ${stderrTail}`}`;

  return new NexarError(authFailure ? 'AUTH_REQUIRED' : 'PROVIDER_ERROR', message, { details });
}

function unavailableState(observedAt: string, detail: string): ResourceState {
  return { availability: 'unavailable', auth: 'unknown', detail, observedAt };
}

function parseAuth(stdout: string): AuthState {
  try {
    const v: unknown = JSON.parse(stdout.trim());
    const loggedIn =
      typeof v === 'object' && v !== null ? (v as { loggedIn?: unknown }).loggedIn : v;
    if (loggedIn === true) return 'authenticated';
    if (loggedIn === false) return 'unauthenticated';
  } catch {
    // fall through
  }
  return 'unknown';
}
