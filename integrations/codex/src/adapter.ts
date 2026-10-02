import type { spawn } from 'node:child_process';
import { spawnRuntime } from '@nexar/process';
import { stat } from 'node:fs/promises';
import { homedir } from 'node:os';
import { NexarError } from '@nexar/contracts';
import type {
  AuthState,
  EngineeringWorkspace,
  ExecutionAdapter,
  ExecutionContext,
  ExecutionRequest,
  ExecutionResult,
  LaunchSpec,
  PreparedLaunch,
  ResourceDescriptor,
  ResourceState,
} from '@nexar/contracts';
import { buildCodexEnv, buildProbeEnv } from './env.js';
import { classifyFailure, CodexStreamParser, toUsage } from './parse.js';
import { runProcess } from './process.js';
import type { ProcessOutcome } from './process.js';
import { CODEX_ADAPTER_ID } from './resource.js';
import { readSettings, resolveCodexHome } from './settings.js';
import type { CodexSettings } from './settings.js';

/** The Codex CLI version the argv and JSONL handling were verified against. */
export const TESTED_CODEX_VERSION = '0.159.3';

/** Where the owner's Codex directory appears inside the Nexar sandbox. */
export const SANDBOX_CODEX_HOME = '/home/agent/.codex';

const DEFAULT_TIMEOUT_MS = 20 * 60 * 1000;
const PROBE_TIMEOUT_MS = 5000;
const MESSAGE_CHARS = 200;

/** A binary name, or a command plus prefix args (e.g. `node fake-codex.mjs` in tests). */
export type CodexBinary = string | { readonly command: string; readonly args: readonly string[] };

export interface CodexAdapterOptions {
  /** Default `'codex'`; `runtime.options.binary` overrides per resource. */
  readonly binary?: CodexBinary;
  /** Default 20 minutes; `runtime.options.timeoutMs` overrides per resource. */
  readonly defaultTimeoutMs?: number;
  /** Environment to derive the child's from; default `process.env`. */
  readonly env?: NodeJS.ProcessEnv;
  /** Test seam. */
  readonly spawnImpl?: typeof spawn;
  /** Test seam for `observedAt`. */
  readonly clock?: () => Date;
  /** Test seam for the SIGKILL grace period. */
  readonly killGraceMs?: number;
}

/** Which of the three execution modes a request runs in. */
export type CodexMode = 'unscoped' | 'sandboxed' | 'workspace-read-only';

/** Chooses the mode from the lane workspace; refuses write mode without a sandbox launcher. */
export function chooseMode(workspace: EngineeringWorkspace | undefined): CodexMode {
  if (workspace === undefined) return 'unscoped';
  if (workspace.launcher.isolation === 'sandbox') return 'sandboxed';
  if (workspace.access === 'read-write') {
    throw new NexarError('POLICY_REJECTED', 'Codex write mode requires the Nexar sandbox', {
      details: { adapter: 'codex' },
    });
  }
  return 'workspace-read-only';
}

/**
 * Builds the argv (excluding any binary prefix args). The prompt is never part of it: it goes to
 * stdin via `-`. `--dangerously-bypass-approvals-and-sandbox` turns Codex's own sandbox off, so it
 * is emitted only for the `sandboxed` mode, where Nexar's launcher is the security boundary.
 *
 * `-C` is omitted for `sandboxed`: the in-sandbox workspace path is only known after
 * `launcher.prepare`, and the launcher starts the process inside the workspace.
 */
export function buildCodexArgs(
  settings: CodexSettings,
  mode: CodexMode,
  workingDirectory?: string,
): string[] {
  const args = ['exec', '--json', '--ephemeral', '--ignore-user-config', '--color', 'never'];
  if (settings.model !== undefined) args.push('-m', settings.model);
  if (settings.reasoningEffort !== undefined) {
    args.push('-c', `model_reasoning_effort="${settings.reasoningEffort}"`);
  }
  if (mode === 'sandboxed') {
    args.push('--dangerously-bypass-approvals-and-sandbox');
  } else {
    args.push('-s', 'read-only', '--skip-git-repo-check');
    if (workingDirectory !== undefined) args.push('-C', workingDirectory);
  }
  args.push('-');
  return args;
}

/** Runs tasks through the locally installed, already-authenticated `codex` CLI (`exec --json`). */
export class CodexExecutionAdapter implements ExecutionAdapter {
  readonly id = CODEX_ADAPTER_ID;
  readonly displayName = 'Codex (native CLI)';

  private readonly command: string;
  private readonly prefixArgs: readonly string[];
  private readonly defaultTimeoutMs: number;
  private readonly parentEnv: NodeJS.ProcessEnv;
  private readonly spawnImpl: typeof spawn;
  private readonly clock: () => Date;
  private readonly killGraceMs: number | undefined;
  private runtimeVersion: string | undefined;

  constructor(options: CodexAdapterOptions = {}) {
    const binary = options.binary ?? 'codex';
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

  async probe(resource: ResourceDescriptor, signal: AbortSignal): Promise<ResourceState> {
    const observedAt = this.clock().toISOString();
    const settings = readSettings(resource);
    const codexHome = resolveCodexHome(settings, this.parentEnv, homedir());
    const env = buildProbeEnv(this.parentEnv, codexHome);
    const [command, prefix] = this.binaryFor(settings);

    const version = await this.runProbe(command, [...prefix, '--version'], env, signal);
    if (version.outcome.kind === 'aborted') throw cancelled();
    if (version.outcome.kind === 'spawn-error') {
      return unavailableState(
        observedAt,
        `codex binary not runnable: ${version.outcome.error.message}`,
      );
    }
    if (version.outcome.kind === 'timeout') {
      return unavailableState(observedAt, 'codex --version timed out');
    }
    if (version.outcome.kind !== 'exited' || version.outcome.exitCode !== 0) {
      return unavailableState(observedAt, 'codex --version failed');
    }
    const line = version.lines.find((l) => l.trim() !== '')?.trim() ?? '';
    const match = /codex-cli\s+(\d+\.\d+\.\d+\S*)/.exec(line);
    this.runtimeVersion = match?.[1];
    let detail = line;
    if (this.runtimeVersion !== TESTED_CODEX_VERSION) {
      detail = `${line} (Nexar tested with codex-cli ${TESTED_CODEX_VERSION})`.trim();
    }

    // `login status` only reads local state; never `codex login` or `codex exec` in a probe.
    const status = await this.runProbe(command, [...prefix, 'login', 'status'], env, signal);
    if (status.outcome.kind === 'aborted') throw cancelled();
    const auth =
      status.outcome.kind === 'exited'
        ? parseLoginStatus(`${status.lines.join('\n')}\n${status.outcome.stderr}`)
        : 'unknown';
    return { availability: 'available', auth, detail, observedAt };
  }

  async execute(request: ExecutionRequest, context: ExecutionContext): Promise<ExecutionResult> {
    const { task, resource } = request;
    const settings = readSettings(resource);
    // Refuse before anything is spawned or prepared.
    const mode = chooseMode(context.workspace);
    if (context.signal.aborted) throw cancelled();

    const logger = context.logger.child({ adapter: this.id, resourceId: resource.id });
    // Never log argv, stdin or stderr: they can carry user content.
    logger.debug('starting codex', { model: settings.model, mode });

    // `codex exec` has no system-prompt flag, so the system prompt is prepended to the stdin prompt.
    const systemPrompt = task.input.systemPrompt;
    const stdin =
      systemPrompt !== undefined && systemPrompt !== ''
        ? `${systemPrompt}\n\n${task.input.prompt}`
        : task.input.prompt;

    const [command, prefix] = this.binaryFor(settings);
    const codexHome = resolveCodexHome(settings, this.parentEnv, homedir());
    const timeoutMs = settings.timeoutMs ?? this.defaultTimeoutMs;
    const parser = new CodexStreamParser();
    const onLine = (line: string): void => {
      for (const event of parser.push(line)) context.onEvent?.(event);
    };
    const run = (spawned: {
      command: string;
      args: readonly string[];
      env: Readonly<Record<string, string>>;
      cwd: string;
    }): Promise<ProcessOutcome> =>
      runProcess({
        ...spawned,
        stdin,
        timeoutMs,
        signal: context.signal,
        spawnImpl: this.spawnImpl,
        onLine,
        onSpawn: () => context.onEvent?.({ type: 'status', message: 'codex: started' }),
        ...(this.killGraceMs !== undefined ? { killGraceMs: this.killGraceMs } : {}),
      });

    let outcome: ProcessOutcome;
    const workspace = context.workspace;
    if (workspace === undefined) {
      const cwd = task.input.workingDirectory ?? process.cwd();
      outcome = await run({
        command,
        args: [...prefix, ...buildCodexArgs(settings, mode, cwd)],
        env: buildCodexEnv(this.parentEnv, codexHome),
        cwd,
      });
    } else {
      const spec: LaunchSpec =
        mode === 'sandboxed'
          ? {
              command,
              args: [...prefix, ...buildCodexArgs(settings, mode)],
              env: { CODEX_HOME: SANDBOX_CODEX_HOME, LANG: 'C.UTF-8' },
              workspace: workspace.path,
              workspaceAccess: workspace.access,
              network: { mode: 'proxy', allowHosts: settings.allowHosts },
              mounts: [
                { hostPath: codexHome, sandboxPath: SANDBOX_CODEX_HOME, access: 'read-write' },
              ],
            }
          : {
              command,
              args: [...prefix, ...buildCodexArgs(settings, mode, workspace.path)],
              env: buildCodexEnv(this.parentEnv, codexHome),
              workspace: workspace.path,
              workspaceAccess: workspace.access,
              network: { mode: 'proxy', allowHosts: settings.allowHosts },
            };
      if (mode === 'sandboxed') await assertDirectory(codexHome);

      const prepared = await workspace.launcher.prepare(spec, context.signal);
      try {
        // Re-check what the launcher actually applied before running with Codex's sandbox off.
        if (mode === 'sandboxed' && prepared.isolation !== 'sandbox') {
          throw new NexarError(
            'POLICY_REJECTED',
            'Launcher did not apply the sandbox; refusing to run Codex',
          );
        }
        outcome = await run(preparedSpawn(prepared));
      } finally {
        await prepared.dispose();
      }
    }

    switch (outcome.kind) {
      case 'spawn-error':
        throw spawnFailure(outcome.error, command);
      case 'aborted':
        throw cancelled();
      case 'timeout':
        throw new NexarError('EXECUTION_TIMEOUT', `codex did not finish within ${timeoutMs} ms`, {
          details: { timeoutMs },
        });
      case 'overflow':
        throw new NexarError('PROVIDER_ERROR', 'codex output exceeded the size limit');
      case 'exited':
        break;
    }

    const parsed = parser.result();
    const details = { exitCode: outcome.exitCode, turns: parsed.turns };
    if (outcome.exitCode !== 0 || parsed.failure !== undefined) {
      const evidence = parsed.failure ?? outcome.stderr;
      const message = truncate(redact(evidence, stdin).trim());
      const code = classifyFailure(`${evidence}\n${outcome.stderr}`);
      throw new NexarError(
        code,
        `codex failed (exit ${outcome.exitCode})${message === '' ? '' : `: ${message}`}`,
        { details },
      );
    }
    if (parsed.turns === 0) {
      throw new NexarError('PROVIDER_ERROR', 'codex produced no completed turn', { details });
    }

    context.onEvent?.({ type: 'status', message: 'codex: finished' });
    return {
      text: parsed.text ?? '',
      artifacts: [],
      usage: toUsage(parsed),
      resolved: {
        provider: 'openai',
        ...(settings.model !== undefined ? { model: settings.model } : {}),
        ...(this.runtimeVersion !== undefined ? { runtimeVersion: this.runtimeVersion } : {}),
      },
      retries: 0,
    };
  }

  private binaryFor(settings: CodexSettings): [string, readonly string[]] {
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

/** Existence check only; nothing inside the directory is ever opened. */
async function assertDirectory(path: string): Promise<void> {
  try {
    if ((await stat(path)).isDirectory()) return;
  } catch {
    // fall through
  }
  throw new NexarError(
    'AUTH_REQUIRED',
    "Codex home directory not found; install Codex and run 'codex login'",
  );
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
      ? `codex binary not found (${command}); install Codex and run 'codex login'`
      : `codex could not be started: ${error.message}`,
    { cause: error, details: { errorCode: error.code } },
  );
}

function unavailableState(observedAt: string, detail: string): ResourceState {
  return { availability: 'unavailable', auth: 'unknown', detail, observedAt };
}

function parseLoginStatus(output: string): AuthState {
  if (/not logged in/i.test(output)) return 'unauthenticated';
  if (/logged in/i.test(output)) return 'authenticated';
  return 'unknown';
}
