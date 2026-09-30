import { spawn } from 'node:child_process';
import type { ChildProcess } from 'node:child_process';
import { chmod, mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { NexarError } from '@nexar/contracts';
import { dshHome } from './env.js';
import { JsonRpcStdioClient } from './json-rpc-client.js';
import { renderPatchOverlay } from './overlay.js';
import type { PiAiProviders } from './overlay.js';

export const EXPECTED_SERVER_NAME = 'deepseek-harness-sdk-runtime';
const STDERR_TAIL_CHARS = 2000;
const KILL_GRACE_MS = 2000;

export interface BinarySpec {
  readonly command: string;
  readonly args: readonly string[];
}

export function normalizeBinary(binary: string | BinarySpec | undefined): BinarySpec {
  if (binary === undefined) return { command: 'dsh', args: [] };
  return typeof binary === 'string' ? { command: binary, args: [] } : binary;
}

export interface LaunchOptions {
  readonly binary: BinarySpec;
  readonly cwd: string;
  readonly stateDir: string;
  readonly env: Readonly<Record<string, string>>;
  readonly patches: readonly string[];
  readonly piAiProviders?: PiAiProviders | undefined;
}

export interface ExitInfo {
  readonly code: number | null;
  readonly signal: NodeJS.Signals | null;
}

/** A running `dsh --profile sdk` child with its JSON-RPC client. */
export class RuntimeProcess {
  readonly client: JsonRpcStdioClient;
  /** Set when the OS could not start the binary (e.g. ENOENT). */
  spawnError: NodeJS.ErrnoException | undefined;
  private stderr = '';
  private exit: ExitInfo | undefined;
  private readonly exitWaiters: (() => void)[] = [];

  constructor(private readonly child: ChildProcess) {
    // stdio is always 'pipe', so these are non-null even if the spawn itself failed.
    this.client = new JsonRpcStdioClient({
      input: child.stdout!,
      output: child.stdin!,
    });
    child.stderr!.setEncoding('utf8');
    child.stderr!.on('data', (chunk: string) => {
      this.stderr = (this.stderr + chunk).slice(-STDERR_TAIL_CHARS);
    });
    child.on('error', (err: NodeJS.ErrnoException) => {
      this.spawnError = err;
      this.markExited({ code: null, signal: null });
    });
    child.on('close', (code, signal) => this.markExited({ code, signal }));
  }

  get exited(): boolean {
    return this.exit !== undefined;
  }

  get exitInfo(): ExitInfo | undefined {
    return this.exit;
  }

  /** Last stderr output, capped at `maxChars`, with `secrets` masked. Never includes prompt text. */
  stderrTail(maxChars: number, secrets: readonly string[] = []): string {
    let text = this.stderr;
    for (const secret of secrets) {
      if (secret.length >= 4) text = text.split(secret).join('[redacted]');
    }
    return text.trim().slice(-maxChars);
  }

  /** Resolves true once the process has exited, false if `timeoutMs` passes first. */
  waitForExit(timeoutMs: number): Promise<boolean> {
    if (this.exit !== undefined) return Promise.resolve(true);
    return new Promise((resolve) => {
      const timer = setTimeout(() => resolve(false), timeoutMs);
      this.exitWaiters.push(() => {
        clearTimeout(timer);
        resolve(true);
      });
    });
  }

  /** Makes sure the child is gone: end stdin, SIGTERM, then SIGKILL after a grace period. */
  async stop(graceMs = KILL_GRACE_MS): Promise<void> {
    this.client.close();
    if (this.exited) return;
    this.child.kill('SIGTERM');
    if (await this.waitForExit(graceMs)) return;
    this.child.kill('SIGKILL');
    await this.waitForExit(graceMs);
  }

  private markExited(info: ExitInfo): void {
    if (this.exit !== undefined) return;
    this.exit = info;
    for (const wake of this.exitWaiters.splice(0)) wake();
  }
}

/** Writes the Nexar patch overlay (0600) and returns its path. */
export async function writeOverlay(
  stateDir: string,
  piAiProviders: PiAiProviders | undefined,
): Promise<string> {
  // Render first so invalid configuration fails before touching the filesystem.
  const text = renderPatchOverlay({ piAiProviders });
  await mkdir(dshHome(stateDir), { recursive: true });
  const path = join(stateDir, 'nexar.patch.yml');
  await writeFile(path, text, { mode: 0o600 });
  await chmod(path, 0o600);
  return path;
}

/** Spawns `dsh --profile sdk` synchronously (so callers never lose a started child to a race). */
export function spawnRuntime(options: LaunchOptions, overlayPath: string): RuntimeProcess {
  const args = [
    ...options.binary.args,
    '--profile',
    'sdk',
    '--patch',
    overlayPath,
    ...options.patches.flatMap((p) => ['--patch', p]),
  ];
  const child = spawn(options.binary.command, args, {
    cwd: options.cwd,
    env: { ...options.env },
    stdio: ['pipe', 'pipe', 'pipe'],
    windowsHide: true,
  });
  return new RuntimeProcess(child);
}

/** Writes the overlay then spawns the runtime. */
export async function launchRuntime(options: LaunchOptions): Promise<RuntimeProcess> {
  const overlay = await writeOverlay(options.stateDir, options.piAiProviders);
  return spawnRuntime(options, overlay);
}

export interface InitializeParams {
  readonly cwd: string;
  readonly provider: string;
  readonly model: string;
  readonly reasoningEffort?: string | undefined;
  readonly maxTokens?: number | undefined;
}

export interface ServerInfo {
  readonly name: string;
  readonly version: string;
}

/** Performs `initialize` and fails closed unless the runtime identifies itself as the DSH SDK runtime. */
export async function initializeRuntime(
  client: JsonRpcStdioClient,
  params: InitializeParams,
  timeoutMs: number,
  signal?: AbortSignal,
): Promise<ServerInfo> {
  const wire = {
    cwd: params.cwd,
    provider: params.provider,
    model: params.model,
    ...(params.reasoningEffort === undefined ? {} : { reasoningEffort: params.reasoningEffort }),
    ...(params.maxTokens === undefined ? {} : { maxTokens: params.maxTokens }),
  };
  const result = await client.request('initialize', wire, {
    timeoutMs,
    ...(signal === undefined ? {} : { signal }),
  });
  const info = (result as { serverInfo?: { name?: unknown; version?: unknown } } | null)
    ?.serverInfo;
  if (typeof info?.name !== 'string' || typeof info.version !== 'string') {
    throw new NexarError('PROVIDER_ERROR', 'dsh answered initialize without serverInfo', {
      details: { reason: 'protocol' },
    });
  }
  if (info.name !== EXPECTED_SERVER_NAME) {
    throw new NexarError(
      'INTEGRATION_UNAVAILABLE',
      `unexpected runtime identity '${info.name.slice(0, 80)}' (expected '${EXPECTED_SERVER_NAME}')`,
      { details: { serverName: info.name.slice(0, 80) } },
    );
  }
  return { name: info.name, version: info.version };
}
