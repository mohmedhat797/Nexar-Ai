import { spawn } from 'node:child_process';
import { mkdir, mkdtemp, rm, stat, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { basename, dirname, join } from 'node:path';
import { NexarError } from '@nexar/contracts';
import type {
  ExecutionAdapter,
  ExecutionContext,
  ExecutionRequest,
  ExecutionResult,
  LaunchMount,
  LaunchSpec,
  ResourceDescriptor,
  ResourceState,
} from '@nexar/contracts';
import { checkRelayPin, readPinnedRelay, RELAY_VERSION_LABEL } from './pin.js';
import { runProcess } from './process.js';
import type { ProcessOutcome } from './process.js';
import { DELEGATE_SKILLS_ADAPTER_ID } from './resource.js';
import {
  classifyFailure,
  MAX_EVENTS_BYTES,
  MAX_RESULT_BYTES,
  parseRelayResult,
  readBoundedFile,
  usageFromEvents,
} from './result.js';
import type { RelayResult } from './result.js';
import { readSettings, resolveCodexHome } from './settings.js';
import type { DelegateSkillsSettings } from './settings.js';

/** Where the relay's directory, the per-run out dir and the owner's Codex home appear in the sandbox. */
export const SANDBOX_RELAY_DIR = '/opt/nexar/relay';
export const SANDBOX_OUT_DIR = '/opt/nexar/out';
export const SANDBOX_CODEX_HOME = '/home/agent/.codex';
const SANDBOX_WORKSPACE = '/work';

/** Time the outer watchdog allows beyond the relay's own `--timeout` before killing the process group. */
const WATCHDOG_GRACE_MS = 60_000;
const PROBE_TIMEOUT_MS = 5000;
const MESSAGE_CHARS = 200;

export interface DelegateSkillsAdapterOptions {
  /** Environment the adapter reads `CODEX_HOME`/`HOME`/`PATH` from; default `process.env`. Never passed on. */
  readonly env?: NodeJS.ProcessEnv;
  /** Host directory under which each run gets a fresh out dir (0700), removed after the run. */
  readonly stateDir: string;
  /** Test seam. */
  readonly spawnImpl?: typeof spawn;
  /** Test seam for `observedAt`. */
  readonly clock?: () => Date;
  /** Test seam for the SIGKILL grace period. */
  readonly killGraceMs?: number;
  /** Test seam for the outer watchdog's margin over the relay's own timeout. */
  readonly watchdogGraceMs?: number;
}

/**
 * Executes an engineering lane for a resource the Resource Controller already chose, by running a
 * sha256-pinned Delegate Skills `codex` relay inside the Nexar sandbox. The relay is only the
 * mechanism: it never selects the resource, and Codex's own sandbox is off because Nexar's is the
 * boundary.
 */
export class DelegateSkillsExecutionAdapter implements ExecutionAdapter {
  readonly id = DELEGATE_SKILLS_ADAPTER_ID;
  readonly displayName = 'Delegate Skills relay (codex)';

  private readonly parentEnv: NodeJS.ProcessEnv;
  private readonly stateDir: string;
  private readonly spawnImpl: typeof spawn;
  private readonly clock: () => Date;
  private readonly killGraceMs: number | undefined;
  private readonly watchdogGraceMs: number;

  constructor(options: DelegateSkillsAdapterOptions) {
    this.parentEnv = options.env ?? process.env;
    this.stateDir = options.stateDir;
    this.spawnImpl = options.spawnImpl ?? spawn;
    this.clock = options.clock ?? (() => new Date());
    this.killGraceMs = options.killGraceMs;
    this.watchdogGraceMs = options.watchdogGraceMs ?? WATCHDOG_GRACE_MS;
  }

  supports(resource: ResourceDescriptor): boolean {
    return resource.runtime.adapter === this.id;
  }

  /** Free: hashes the relay file and runs `node --version`; never runs the relay or `codex exec`. */
  async probe(resource: ResourceDescriptor, signal: AbortSignal): Promise<ResourceState> {
    const observedAt = this.clock().toISOString();
    const settings = readSettings(resource);

    const pin = await checkRelayPin(settings.relayPath, settings.relaySha256);
    if (pin === 'missing') return unavailableState(observedAt, 'relay script not found');
    if (pin === 'mismatch') return unavailableState(observedAt, 'relay pin mismatch');

    let version = '';
    const env: Record<string, string> = {};
    const path = this.parentEnv['PATH'];
    if (path !== undefined && path !== '') env['PATH'] = path;
    const outcome = await runProcess({
      command: settings.nodePath,
      args: ['--version'],
      cwd: process.cwd(),
      env,
      timeoutMs: PROBE_TIMEOUT_MS,
      signal,
      spawnImpl: this.spawnImpl,
      onStdout: (chunk) => {
        version += chunk;
      },
    });
    if (outcome.kind === 'aborted') throw cancelled();
    if (outcome.kind === 'spawn-error') {
      return unavailableState(observedAt, `node not runnable: ${outcome.error.message}`);
    }
    if (outcome.kind === 'timeout') return unavailableState(observedAt, 'node --version timed out');
    if (outcome.exitCode !== 0) return unavailableState(observedAt, 'node --version failed');
    // The codex login probe belongs to the native codex adapter.
    return {
      availability: 'available',
      auth: 'unknown',
      detail: `node ${version.trim()}; ${RELAY_VERSION_LABEL} pinned`,
      observedAt,
    };
  }

  async execute(request: ExecutionRequest, context: ExecutionContext): Promise<ExecutionResult> {
    const { task, resource } = request;
    const settings = readSettings(resource);
    const workspace = context.workspace;
    if (workspace === undefined) {
      throw new NexarError('POLICY_REJECTED', 'relay lanes run only in engineering workspaces', {
        details: { adapter: this.id },
      });
    }
    if (workspace.launcher.isolation !== 'sandbox') {
      throw new NexarError('POLICY_REJECTED', 'relay lanes require the Nexar sandbox', {
        details: { adapter: this.id },
      });
    }
    if (context.signal.aborted) throw cancelled();

    const { pin, bytes: relayBytes } = await readPinnedRelay(
      settings.relayPath,
      settings.relaySha256,
    );
    if (pin !== 'ok' || relayBytes === undefined) {
      throw new NexarError(
        'INTEGRATION_UNAVAILABLE',
        pin === 'missing' ? 'relay script not found' : 'relay pin mismatch',
        { details: { adapter: this.id, pin } },
      );
    }
    const codexHome = resolveCodexHome(settings, this.parentEnv, homedir());
    await assertDirectory(codexHome);

    const logger = context.logger.child({ adapter: this.id, resourceId: resource.id });
    // Never log argv, stdin or result text: they can carry user content.
    logger.debug('starting codex relay', { model: settings.model });

    // The relay has no system-prompt flag, so the system prompt is prepended to the brief on stdin.
    const systemPrompt = task.input.systemPrompt;
    const brief =
      systemPrompt !== undefined && systemPrompt !== ''
        ? `${systemPrompt}\n\n${task.input.prompt}`
        : task.input.prompt;

    await mkdir(this.stateDir, { recursive: true, mode: 0o700 });
    const outDir = await mkdtemp(join(this.stateDir, 'run-'));
    // The sandbox runs a private, read-only copy of exactly the bytes that matched the pin.
    const relayDir = await mkdtemp(join(this.stateDir, 'relay-'));
    const relayFile = join(relayDir, 'relay.mjs');
    try {
      await writeFile(relayFile, relayBytes, { mode: 0o400, flag: 'wx' });
      const spec = buildLaunchSpec(settings, {
        relayFile,
        outDir,
        codexHome,
        workspacePath: workspace.path,
        workspaceAccess: workspace.access,
      });
      const prepared = await workspace.launcher.prepare(spec, context.signal);
      let outcome: ProcessOutcome;
      try {
        // Re-check what the launcher actually applied before running with Codex's sandbox off.
        if (prepared.isolation !== 'sandbox') {
          throw new NexarError(
            'POLICY_REJECTED',
            'Launcher did not apply the sandbox; refusing to run the relay',
          );
        }
        outcome = await runProcess({
          command: prepared.command,
          args: prepared.args,
          env: prepared.env,
          cwd: prepared.cwd,
          stdin: brief,
          timeoutMs: settings.timeoutMs + this.watchdogGraceMs,
          signal: context.signal,
          spawnImpl: this.spawnImpl,
          onSpawn: () => context.onEvent?.({ type: 'status', message: 'relay: started' }),
          ...(this.killGraceMs !== undefined ? { killGraceMs: this.killGraceMs } : {}),
        });
      } finally {
        await prepared.dispose();
      }

      switch (outcome.kind) {
        case 'spawn-error':
          throw new NexarError(
            'INTEGRATION_UNAVAILABLE',
            outcome.error.code === 'ENOENT'
              ? 'node binary for the relay not found'
              : `relay could not be started: ${outcome.error.message}`,
            { cause: outcome.error, details: { errorCode: outcome.error.code } },
          );
        case 'aborted':
          throw cancelled();
        case 'timeout':
          throw timedOut(settings.timeoutMs);
        case 'exited':
          break;
      }

      const resultText = await readBoundedFile(join(outDir, 'result.json'), MAX_RESULT_BYTES);
      const result = resultText === undefined ? undefined : parseRelayResult(resultText);
      if (result === undefined) {
        throw new NexarError('PROVIDER_ERROR', 'relay produced no valid result', {
          details: { exitCode: outcome.exitCode },
        });
      }
      throwForStatus(result, settings, brief, outcome.exitCode);

      const eventsText = await readBoundedFile(join(outDir, 'events.jsonl'), MAX_EVENTS_BYTES);
      // Informational only: Nexar recomputes the diff itself.
      context.onEvent?.({
        type: 'status',
        message:
          result.touchedCount === undefined
            ? 'relay: finished'
            : `relay: finished (${result.touchedCount} files touched)`,
      });
      const model = result.model ?? settings.model;
      return {
        text: result.finalMessage,
        artifacts: [],
        usage: usageFromEvents(eventsText),
        resolved: {
          provider: 'openai',
          ...(model !== undefined ? { model } : {}),
          runtimeVersion: [result.codexVersion, RELAY_VERSION_LABEL]
            .filter((p) => p !== undefined)
            .join(' '),
        },
        retries: 0,
      };
    } finally {
      await rm(outDir, { recursive: true, force: true });
      await rm(relayDir, { recursive: true, force: true });
    }
  }
}

interface LaunchInputs {
  /** Host path of the private, pin-verified relay copy; its directory is mounted read-only. */
  readonly relayFile: string;
  readonly outDir: string;
  readonly codexHome: string;
  readonly workspacePath: string;
  readonly workspaceAccess: 'read-only' | 'read-write';
}

/**
 * The exact launch request. The brief is not part of it (it goes to stdin). Codex's own sandbox is
 * off (`danger-full-access`) because the Nexar sandbox is the boundary; `--clean-env` keeps the
 * relay from forwarding anything but basics and `CODEX_HOME`.
 */
export function buildLaunchSpec(
  settings: DelegateSkillsSettings,
  inputs: LaunchInputs,
): LaunchSpec {
  const args = [
    `${SANDBOX_RELAY_DIR}/${basename(inputs.relayFile)}`,
    '--cd',
    SANDBOX_WORKSPACE,
    '--out-dir',
    SANDBOX_OUT_DIR,
    '--sandbox',
    'danger-full-access',
    '--clean-env',
    '--ignore-user-config',
    '--keep-env',
    'CODEX_HOME',
    '--timeout',
    settings.timeout,
  ];
  if (settings.model !== undefined) args.push('--model', settings.model);
  if (settings.effort !== undefined) args.push('--effort', settings.effort);
  const mounts: LaunchMount[] = [
    { hostPath: dirname(inputs.relayFile), sandboxPath: SANDBOX_RELAY_DIR, access: 'read-only' },
    { hostPath: inputs.outDir, sandboxPath: SANDBOX_OUT_DIR, access: 'read-write' },
    { hostPath: inputs.codexHome, sandboxPath: SANDBOX_CODEX_HOME, access: 'read-write' },
  ];
  return {
    command: settings.nodePath,
    args,
    env: { CODEX_HOME: SANDBOX_CODEX_HOME, LANG: 'C.UTF-8' },
    workspace: inputs.workspacePath,
    workspaceAccess: inputs.workspaceAccess,
    network: { mode: 'proxy', allowHosts: settings.allowHosts },
    mounts,
  };
}

/** Maps a non-completed relay status to the matching NexarError; returns for `completed`. */
function throwForStatus(
  result: RelayResult,
  settings: DelegateSkillsSettings,
  brief: string,
  exitCode: number | null,
): void {
  switch (result.status) {
    case 'completed':
      return;
    case 'timeout':
      throw timedOut(settings.timeoutMs);
    case 'aborted':
      throw cancelled();
    case 'codex_unavailable':
      throw new NexarError(
        'INTEGRATION_UNAVAILABLE',
        "codex binary not found inside the sandbox; install Codex and run 'codex login'",
      );
    case 'failed': {
      const evidence = `${result.error ?? ''}\n${result.stderrTail ?? ''}`;
      const shown = truncate(redact(result.error ?? result.stderrTail ?? '', brief).trim());
      throw new NexarError(
        classifyFailure(evidence),
        `codex relay failed${shown === '' ? '' : `: ${shown}`}`,
        { details: { exitCode } },
      );
    }
  }
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

function timedOut(timeoutMs: number): NexarError {
  return new NexarError('EXECUTION_TIMEOUT', `codex relay did not finish within ${timeoutMs} ms`, {
    details: { timeoutMs },
  });
}

function unavailableState(observedAt: string, detail: string): ResourceState {
  return { availability: 'unavailable', auth: 'unknown', detail, observedAt };
}
