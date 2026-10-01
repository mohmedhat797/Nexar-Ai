import { spawn } from 'node:child_process';
import { estimated, measured, NexarError, unavailable } from '@nexar/contracts';
import type {
  AuthState,
  ExecutionAdapter,
  ExecutionContext,
  ExecutionRequest,
  ExecutionResult,
  LaunchSpec,
  Measured,
  ResourceDescriptor,
  ResourceState,
  UsageReport,
  EngineeringWorkspace,
} from '@nexar/contracts';
import { buildChildEnv } from './env.js';
import { findRateLimit, parseClaudeResult, parseToolCallNames } from './parse.js';
import type { ParsedClaudeResult, ParsedRateLimit } from './parse.js';
import { runProcess } from './process.js';
import type { ProcessOutcome } from './process.js';
import { CLAUDE_CODE_ADAPTER_ID } from './resource.js';
import { DEFAULT_ALLOW_HOSTS, readSettings } from './settings.js';
import type { ClaudeCodeSettings } from './settings.js';

const DEFAULT_TIMEOUT_MS = 10 * 60 * 1000;
const DEFAULT_ENGINEERING_TIMEOUT_MS = 30 * 60 * 1000;
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
  maxCostUsd?: number,
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
  if (maxCostUsd !== undefined) args.push('--max-budget-usd', String(maxCostUsd));
  if (systemPrompt !== undefined && systemPrompt !== '') {
    args.push('--append-system-prompt', systemPrompt);
  }
  // `--tools` is variadic, so it goes last; an empty list disables all tools.
  args.push('--tools', ...(settings.tools.length > 0 ? settings.tools : ['']));
  return args;
}

/** Deny rules for git writes; defense in depth only (the launcher mounts `.git` read-only). */
const GIT_DENY_RULES: readonly string[] = [
  'Bash(git commit:*)',
  'Bash(git commit *)',
  'Bash(git push:*)',
  'Bash(git push *)',
  'Bash(git add:*)',
  'Bash(git add *)',
  'Bash(git reset *)',
  'Bash(git checkout *)',
  'Bash(git remote *)',
  'Bash(git config *)',
];

const ENGINEERING_TOOLS = {
  'read-write': ['Read', 'Edit', 'Write', 'Glob', 'Grep', 'Bash'],
  'read-only': ['Read', 'Glob', 'Grep', 'Bash'],
} as const;

/** The complete environment of a sandboxed claude: nothing is inherited from the parent. */
const ENGINEERING_ENV: Readonly<Record<string, string>> = {
  LANG: 'C.UTF-8',
  CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: '1',
  CLAUDE_CODE_DISABLE_AUTO_MEMORY: '1',
  CLAUDE_CODE_DISABLE_GIT_INSTRUCTIONS: '1',
  ENABLE_CLAUDEAI_MCP_SERVERS: 'false',
};

/**
 * Builds the argv for a run inside Nexar's sandbox (excluding any binary prefix args). The prompt
 * is never part of it. Claude's own sandbox is disabled (it cannot nest); `--setting-sources user`
 * keeps a worktree's `.claude/settings.json` hooks and MCP servers from running.
 */
export function buildEngineeringArgs(
  settings: ClaudeCodeSettings,
  systemPrompt: string | undefined,
  access: 'read-only' | 'read-write',
  maxCostUsd?: number,
): string[] {
  const args = [
    '-p',
    '--output-format',
    'stream-json',
    '--verbose',
    '--no-session-persistence',
    '--permission-mode',
    'acceptEdits',
    '--permission-prompts',
    'none',
    '--setting-sources',
    'user',
    '--strict-mcp-config',
    '--disable-slash-commands',
    '--settings',
    '{"sandbox":{"enabled":false}}',
  ];
  if (settings.model !== undefined) args.push('--model', settings.model);
  if (settings.maxTurns !== undefined) args.push('--max-turns', String(settings.maxTurns));
  if (maxCostUsd !== undefined) args.push('--max-budget-usd', String(maxCostUsd));
  if (systemPrompt !== undefined && systemPrompt !== '') {
    args.push('--append-system-prompt', systemPrompt);
  }
  // `--allowedTools`, `--disallowedTools` and `--tools` are variadic; `--tools` goes last.
  args.push('--allowedTools', 'Bash', '--disallowedTools', ...GIT_DENY_RULES);
  args.push('--tools', ...ENGINEERING_TOOLS[access]);
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
    const { workspace } = context;
    if (workspace?.access === 'read-write' && workspace.launcher.isolation !== 'sandbox') {
      throw new NexarError('POLICY_REJECTED', 'write mode requires the Nexar sandbox', {
        details: { adapter: this.id },
      });
    }
    if (context.signal.aborted) throw cancelled();

    // Never log argv or the prompt: both can carry user content.
    const logger = context.logger.child({ adapter: this.id, resourceId: resource.id });
    if (workspace !== undefined) {
      return this.executeInWorkspace(request, context, settings, workspace);
    }

    const args = [
      ...this.prefixArgs,
      ...buildClaudeArgs(settings, task.input.systemPrompt, task.requirements.maxCostUsd),
    ];
    const timeoutMs = settings.timeoutMs ?? this.defaultTimeoutMs;
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
    return this.conclude(outcome, settings, timeoutMs, context);
  }

  /** Engineering lanes: spawn only what `launcher.prepare` returns, and always dispose it. */
  private async executeInWorkspace(
    request: ExecutionRequest,
    context: ExecutionContext,
    settings: ClaudeCodeSettings,
    workspace: EngineeringWorkspace,
  ): Promise<ExecutionResult> {
    const { task, resource } = request;
    const sandboxed = workspace.launcher.isolation === 'sandbox';
    const allowHosts = settings.sandbox?.allowHosts ?? DEFAULT_ALLOW_HOSTS;
    const timeoutMs = settings.engineeringTimeoutMs ?? DEFAULT_ENGINEERING_TIMEOUT_MS;
    const logger = context.logger.child({ adapter: this.id, resourceId: resource.id });

    const claudeArgs = sandboxed
      ? buildEngineeringArgs(
          settings,
          task.input.systemPrompt,
          workspace.access,
          task.requirements.maxCostUsd,
        )
      : buildClaudeArgs(settings, task.input.systemPrompt, task.requirements.maxCostUsd);
    const spec: LaunchSpec = {
      command: this.command,
      args: [...this.prefixArgs, ...claudeArgs],
      env: { ...ENGINEERING_ENV },
      workspace: workspace.path,
      workspaceAccess: workspace.access,
      network: { mode: 'proxy', allowHosts: [...allowHosts] },
      mounts: (settings.sandbox?.mounts ?? []).map((m) => ({ ...m })),
    };

    const prepared = await workspace.launcher.prepare(spec, context.signal);
    try {
      logger.debug('spawning claude in workspace', {
        model: settings.model,
        access: workspace.access,
        isolation: prepared.isolation,
      });
      const outcome = await runProcess({
        command: prepared.command,
        args: prepared.args,
        cwd: prepared.cwd,
        env: prepared.env,
        stdin: task.input.prompt,
        timeoutMs,
        signal: context.signal,
        spawnImpl: this.spawnImpl,
        onSpawn: () => context.onEvent?.({ type: 'status', message: 'claude: started' }),
        ...(sandboxed
          ? {
              onStdoutLine: (line: string) => {
                // Names only: tool inputs can carry file contents and commands.
                for (const name of parseToolCallNames(line)) {
                  context.onEvent?.({ type: 'tool-call', name });
                }
              },
            }
          : {}),
      });
      return this.conclude(outcome, settings, timeoutMs, context);
    } finally {
      try {
        await prepared.dispose();
      } catch (e) {
        logger.warn('launcher dispose failed', { error: e instanceof Error ? e.name : 'unknown' });
      }
    }
  }

  private conclude(
    outcome: ProcessOutcome,
    settings: ClaudeCodeSettings,
    timeoutMs: number,
    context: ExecutionContext,
  ): ExecutionResult {
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
    const rateLimit = findRateLimit(outcome.stdout, this.clock());
    const subtype = parsed?.subtype;
    const denials = parsed?.permissionDenials;
    const details = {
      exitCode: outcome.exitCode,
      ...(subtype !== undefined ? { subtype } : {}),
      ...(denials !== undefined ? { permissionDenials: denials } : {}),
    };

    if (parsed === undefined && outcome.exitCode === 0) {
      throw new NexarError('PROVIDER_ERROR', 'claude produced no parseable JSON result', {
        details,
      });
    }
    if (subtype === 'error_max_budget_usd') {
      // A caller-set budget was reached: a policy outcome, not a resource fault.
      throw new NexarError('POLICY_REJECTED', 'claude stopped at the requested maxCostUsd budget', {
        details: { ...details, reason: 'max-budget-usd' },
      });
    }
    if (
      outcome.exitCode !== 0 ||
      parsed === undefined ||
      parsed.isError ||
      subtype?.startsWith('error')
    ) {
      throw failure(outcome, parsed, details, rateLimit);
    }

    if (denials !== undefined && denials > 0) {
      context.onEvent?.({ type: 'status', message: `claude: ${denials} permission denial(s)` });
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
      ...(rateLimit === undefined ? {} : { quotaObservations: [rateLimit.observation] }),
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
  rateLimit: ParsedRateLimit | undefined,
): NexarError {
  if (rateLimit?.rejected === true) {
    const resetsAt = rateLimit.observation.resetsAt;
    return new NexarError(
      'QUOTA_EXHAUSTED',
      'claude reported that its usage allowance is exhausted',
      {
        details: { ...details, ...(resetsAt === undefined ? {} : { resetsAt }) },
      },
    );
  }
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
