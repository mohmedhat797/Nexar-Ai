import { spawnSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { performance } from 'node:perf_hooks';

export const STATE_GUARD_READY = 'nexar-state-guard:ready';
export const STATE_GUARD_PHASE = 'nexar-state-guard:phase';
/** Test-only main-process readback; not a renderer/IPC channel or a mutation authority. */
export const STATE_GUARD_TRACE_EVENT = 'nexar:startup-process-observation';

export interface WindowsStateToolOptions {
  readonly env: Record<string, string>;
  readonly windowsHide: true;
  readonly shell: false;
  readonly timeout: number;
  readonly maxBuffer: number;
}

type ScriptPhaseName = 'ready' | 'tree-checked' | 'acl-verified' | 'complete';

export interface WindowsStateScriptPhase {
  readonly phase: ScriptPhaseName;
  readonly childPid: number;
  readonly childCreatedAtUtc: string;
  readonly readinessFlushedAtUtc: string;
  readonly atUtc: string;
  /** Child Stopwatch duration after flushing readiness, not a parent callback timestamp. */
  readonly elapsedMs: number;
}

interface ProcessRequest {
  readonly schema: 'private-state-process@1';
  readonly correlationId: string;
  readonly attemptId: number;
  readonly parentPid: number;
  readonly parentStartedAtUtcEstimate: string;
  readonly spawnRequestedAtUtc: string;
  readonly timeoutMs: number;
  readonly observation: 'synchronous-buffered';
}

export interface WindowsStateProcessResult extends ProcessRequest {
  readonly event: 'result';
  readonly childPid?: number;
  readonly childCreated: boolean;
  readonly nativeReturnedAtUtc: string;
  readonly exitObservedAtUtc?: string;
  readonly elapsedMs: number;
  readonly outputCaptured: boolean;
  readonly outputCapturedAtUtc?: string;
  readonly readinessCaptured: boolean;
  readonly exitCode?: number;
  readonly signal?: 'SIGTERM' | 'SIGKILL' | 'other';
  readonly termination: 'exited' | 'timeout' | 'spawn-failed' | 'signaled' | 'invalid-result';
  readonly scriptPhases: readonly WindowsStateScriptPhase[];
  readonly unavailableTimings: readonly [
    'live-spawn-confirmation',
    'first-parent-output-callback',
    'exact-os-exit',
    'exact-parent-creation',
  ];
}

export type WindowsStateProcessEvent =
  (ProcessRequest & { readonly event: 'request' }) | WindowsStateProcessResult;

interface NativeResult {
  readonly pid?: number;
  readonly status: number | null;
  readonly signal?: string | null;
  readonly stdout?: unknown;
  readonly error?: unknown;
}

/** Trusted dependency seams only; no renderer or configuration supplies launch parameters. */
export interface WindowsStateProcessHooks {
  readonly spawn?: (
    command: string,
    args: readonly string[],
    options: WindowsStateToolOptions,
  ) => NativeResult;
  readonly monotonicNow?: () => number;
  readonly wallNow?: () => Date;
  readonly onEvent?: (event: WindowsStateProcessEvent) => void;
}

export class WindowsStateProcessError extends Error {
  constructor(
    readonly nativeCode: 'ETIMEDOUT' | 'ENOENT' | 'other',
    readonly result: WindowsStateProcessResult,
  ) {
    // Retain no native exception, command, environment, stdout or stderr on this error.
    super('Native Desktop state guard failed');
    this.name = 'WindowsStateProcessError';
  }
}

const phases = new Set<string>(['ready', 'tree-checked', 'acl-verified', 'complete']);
const iso = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/;

function validUtc(value: string): boolean {
  const parsed = new Date(value);
  return iso.test(value) && Number.isFinite(parsed.getTime()) && parsed.toISOString() === value;
}

function scriptPhases(stdout: string, childPid: number | undefined): WindowsStateScriptPhase[] {
  const accepted: WindowsStateScriptPhase[] = [];
  const seen = new Set<string>();
  for (const line of stdout.split(/\r?\n/)) {
    if (!line.startsWith(`${STATE_GUARD_PHASE}|`)) continue;
    const fields = line.split('|');
    if (fields.length !== 7) continue;
    const [, phase, pid, created, ready, at, duration] = fields as [
      string,
      string,
      string,
      string,
      string,
      string,
      string,
    ];
    if (
      !phases.has(phase) ||
      seen.has(phase) ||
      !/^\d+$/.test(pid) ||
      Number(pid) !== childPid ||
      !validUtc(created) ||
      !validUtc(ready) ||
      !validUtc(at) ||
      !/^\d+$/.test(duration)
    )
      continue;
    const elapsedMs = Number(duration);
    if (!Number.isSafeInteger(elapsedMs) || elapsedMs > 86_400_000) continue;
    accepted.push({
      phase: phase as ScriptPhaseName,
      childPid: Number(pid),
      childCreatedAtUtc: created,
      readinessFlushedAtUtc: ready,
      atUtc: at,
      elapsedMs,
    });
    seen.add(phase);
  }
  return accepted;
}

/**
 * The same synchronous native primitive used by Node's execFileSync, retaining its PID.
 * Do not make this asynchronous: the private guard must finish before Electron's first yield.
 * Output is parsed to a strict metadata allowlist and never forwarded or retained on errors.
 */
export function runWindowsStateProcess(
  command: string,
  args: readonly string[],
  options: WindowsStateToolOptions,
  hooks: WindowsStateProcessHooks = {},
): void {
  const now = hooks.monotonicNow ?? (() => performance.now());
  const wall = hooks.wallNow ?? (() => new Date());
  const requested = wall();
  const request: ProcessRequest = {
    schema: 'private-state-process@1',
    correlationId: randomUUID(),
    // One attempt per initialization; a new correlation ID identifies a later initialization.
    // Never retry a failed security guard automatically.
    attemptId: 1,
    parentPid: process.pid,
    parentStartedAtUtcEstimate: new Date(
      requested.getTime() - process.uptime() * 1000,
    ).toISOString(),
    spawnRequestedAtUtc: requested.toISOString(),
    timeoutMs: options.timeout,
    observation: 'synchronous-buffered',
  };
  hooks.onEvent?.({ ...request, event: 'request' });
  const started = now();
  const invoke =
    hooks.spawn ??
    ((file, argv, toolOptions) =>
      spawnSync(file, [...argv], { ...toolOptions, stdio: ['ignore', 'pipe', 'ignore'] }));
  let native: NativeResult;
  try {
    native = invoke(command, args, options);
  } catch (error) {
    // Invalid native invocation/resource failures also fail closed without retaining messages.
    native = { status: null, error };
  }
  const elapsedMs = Math.max(0, Math.round(now() - started));
  const returnedAt = wall().toISOString();
  const childPid = Number.isInteger(native.pid) && native.pid! > 0 ? native.pid : undefined;
  const stdout =
    typeof native.stdout === 'string' || Buffer.isBuffer(native.stdout)
      ? String(native.stdout)
      : '';
  const hasError = native.error !== undefined && native.error !== null;
  const code =
    typeof native.error === 'object' && native.error !== null
      ? (native.error as { readonly code?: unknown }).code
      : undefined;
  const exitCode = Number.isInteger(native.status) ? native.status! : undefined;
  const signal = native.signal
    ? native.signal === 'SIGTERM' || native.signal === 'SIGKILL'
      ? native.signal
      : 'other'
    : undefined;
  const result: WindowsStateProcessResult = {
    ...request,
    event: 'result',
    ...(childPid === undefined ? {} : { childPid }),
    childCreated: childPid !== undefined,
    nativeReturnedAtUtc: returnedAt,
    ...(childPid !== undefined && (exitCode !== undefined || signal !== undefined)
      ? { exitObservedAtUtc: returnedAt }
      : {}),
    elapsedMs,
    outputCaptured: stdout.length > 0,
    ...(stdout.length > 0 ? { outputCapturedAtUtc: returnedAt } : {}),
    readinessCaptured: stdout.includes(STATE_GUARD_READY),
    ...(exitCode === undefined ? {} : { exitCode }),
    ...(signal === undefined ? {} : { signal }),
    termination:
      code === 'ETIMEDOUT'
        ? 'timeout'
        : hasError && childPid === undefined
          ? 'spawn-failed'
          : signal
            ? 'signaled'
            : exitCode !== undefined
              ? 'exited'
              : 'invalid-result',
    scriptPhases: scriptPhases(stdout, childPid),
    unavailableTimings: [
      'live-spawn-confirmation',
      'first-parent-output-callback',
      'exact-os-exit',
      'exact-parent-creation',
    ],
  };
  hooks.onEvent?.(result);
  if (hasError || native.status !== 0 || signal !== undefined) {
    throw new WindowsStateProcessError(
      code === 'ETIMEDOUT' || code === 'ENOENT' ? code : 'other',
      result,
    );
  }
}
