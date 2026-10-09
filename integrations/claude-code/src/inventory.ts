import type { ChildProcess, spawn } from 'node:child_process';
import { chmod, mkdtemp, rm } from 'node:fs/promises';
import { isAbsolute, join, relative, resolve } from 'node:path';
import { Transform } from 'node:stream';
import type { Options, SDKUserMessage, SpawnedProcess } from '@anthropic-ai/claude-agent-sdk';
import {
  PROVIDER_MODEL_INVENTORY_MAX_ENTRIES,
  type InventorySource,
  type InventorySourceResult,
  type ProviderInventoryFailureReason,
  type ProviderModelEntry,
} from '@nexar/contracts';
import { publicRuntimeEnvironment, spawnRuntime, terminateProcessTree } from '@nexar/process';

/** Verified against the published package types and implementation; never used as CLI version. */
export const CLAUDE_INVENTORY_SDK_VERSION = '0.3.292';
const MAX_OUTPUT_BYTES = 256 * 1024;
const CLEANUP_TIMEOUT_MS = 6_000;
const EFFORT_LEVELS = ['low', 'medium', 'high', 'xhigh', 'max'];

export interface ClaudeInventoryQuery {
  supportedModels(): Promise<unknown>;
  close(): void;
}

export type ClaudeInventoryQueryFactory = (params: {
  readonly prompt: AsyncIterable<SDKUserMessage>;
  readonly options: Options;
}) => ClaudeInventoryQuery;

export interface ClaudeModelInventoryOptions {
  readonly env: NodeJS.ProcessEnv;
  /** Host-owned private parent (owner ACL on Windows, owner-only mode on POSIX). Not project cwd. */
  readonly privateDirectory: string;
  /** Host-configured installed runtime, never a renderer-provided command. */
  readonly command?: string;
  readonly timeoutMs?: number;
  readonly queryImpl?: ClaudeInventoryQueryFactory;
  readonly spawnImpl?: typeof spawn;
  readonly terminateTree?: typeof terminateProcessTree;
}

function environment(parent: NodeJS.ProcessEnv): Record<string, string> {
  const env = publicRuntimeEnvironment(parent);
  const names = Object.keys(parent).filter((name) =>
    process.platform === 'win32'
      ? name.toUpperCase() === 'CLAUDE_CONFIG_DIR'
      : name === 'CLAUDE_CONFIG_DIR',
  );
  if (names.length > 1) throw new Error('Invalid native config directory');
  if (names.length === 1) {
    const value = parent[names[0]!];
    if (value !== undefined) {
      if (
        !value ||
        value.length > 4096 ||
        /\p{Cc}/u.test(value) ||
        !isAbsolute(value) ||
        (process.platform === 'win32' && !/^(?:[A-Za-z]:[\\/]|\\\\[^\\]+\\[^\\]+)/.test(value))
      ) {
        throw new Error('Invalid native config directory');
      }
      env.CLAUDE_CONFIG_DIR = value;
    }
  }
  // SDK public markers only. No API-key/OAuth, routing, project, debug or NODE_OPTIONS inheritance.
  env.CLAUDE_CODE_ENTRYPOINT = 'sdk-ts';
  env.CLAUDE_AGENT_SDK_VERSION = CLAUDE_INVENTORY_SDK_VERSION;
  return env;
}

function publicText(value: unknown, max: number): string {
  if (
    typeof value !== 'string' ||
    !value ||
    value.length > max ||
    value.trim() !== value ||
    /\p{Cc}/u.test(value)
  ) {
    throw new Error('Invalid model metadata');
  }
  return value;
}

function models(value: unknown): readonly ProviderModelEntry[] {
  if (!Array.isArray(value) || value.length > PROVIDER_MODEL_INVENTORY_MAX_ENTRIES)
    throw new Error('Invalid model metadata');
  const entries: ProviderModelEntry[] = [];
  const seen = new Set<string>();
  for (const raw of value as unknown[]) {
    if (raw === null || typeof raw !== 'object' || Array.isArray(raw))
      throw new Error('Invalid model metadata');
    const row = raw as Record<string, unknown>;
    const id = publicText(row.value, 200);
    const displayName = publicText(row.displayName, 160);
    let reasoningModes: string[] | undefined;
    if (row.supportedEffortLevels !== undefined) {
      if (
        !Array.isArray(row.supportedEffortLevels) ||
        row.supportedEffortLevels.length > EFFORT_LEVELS.length ||
        row.supportedEffortLevels.some(
          (mode: unknown) => typeof mode !== 'string' || !EFFORT_LEVELS.includes(mode),
        )
      ) {
        throw new Error('Invalid model metadata');
      }
      reasoningModes = [...new Set(row.supportedEffortLevels as string[])];
    }
    if (seen.has(id)) continue;
    seen.add(id);
    entries.push({
      selection: { kind: 'model', id },
      displayName,
      availability: 'available',
      compatibility: 'native-agent',
      source: 'live-runtime',
      ...(reasoningModes ? { reasoningModes } : {}),
    });
  }
  return entries;
}

function failure(reason: ProviderInventoryFailureReason): InventorySourceResult {
  return {
    status: reason === 'unsupported' ? 'unsupported' : 'unavailable',
    source: 'live-runtime',
    auth: 'unknown',
    reason,
  };
}

async function removeScratch(parent: string, cwd: string): Promise<void> {
  const child = relative(resolve(parent), resolve(cwd));
  if (
    isAbsolute(child) ||
    !child.startsWith('claude-inventory-') ||
    child.includes('..') ||
    child.includes('/') ||
    child.includes('\\')
  )
    return;
  await rm(cwd, { recursive: true, force: true, maxRetries: 3, retryDelay: 50 });
}

/**
 * Owner-triggered native metadata only. An unfed input never supplies a user message. Initialization
 * may refresh vendor-owned auth/state; listing does not prove authentication or generation rights.
 */
export function createClaudeModelInventorySource(
  options: ClaudeModelInventoryOptions,
): InventorySource {
  return {
    async fetch(signal) {
      if (signal.aborted) return failure('cancelled');
      const timeoutMs = options.timeoutMs ?? 10_000;
      if (
        !Number.isFinite(timeoutMs) ||
        timeoutMs <= 0 ||
        timeoutMs > 120_000 ||
        !isAbsolute(options.privateDirectory)
      )
        return failure('runtime-unavailable');
      const controller = new AbortController();
      const children: ChildProcess[] = [];
      const outputs: Transform[] = [];
      let query: ClaudeInventoryQuery | undefined;
      let cwd: string | undefined;
      let env: Record<string, string> | undefined;
      let stopped: ProviderInventoryFailureReason | undefined;
      let finishInput!: () => void;
      const inputClosed = new Promise<void>((done) => {
        finishInput = done;
      });
      // Deliberately returns no SDKUserMessage, including no empty/dummy prompt.
      const input: AsyncIterable<SDKUserMessage> = {
        [Symbol.asyncIterator]() {
          return {
            async next() {
              await inputClosed;
              return { done: true, value: undefined };
            },
          };
        },
      };
      let finishStop!: (result: InventorySourceResult) => void;
      const stopping = new Promise<InventorySourceResult>((done) => {
        finishStop = done;
      });
      const stop = (reason: ProviderInventoryFailureReason): void => {
        if (stopped !== undefined) return;
        stopped = reason;
        finishStop(failure(reason));
      };
      const onAbort = (): void => stop('cancelled');
      signal.addEventListener('abort', onAbort, { once: true });
      const deadline = setTimeout(() => stop('timeout'), timeoutMs);
      const work = async (): Promise<InventorySourceResult> => {
        env = environment(options.env);
        cwd = await mkdtemp(join(options.privateDirectory, 'claude-inventory-'));
        if (process.platform !== 'win32') await chmod(cwd, 0o700);
        if (stopped !== undefined || signal.aborted || controller.signal.aborted) {
          await removeScratch(options.privateDirectory, cwd).catch(() => undefined);
          return failure(stopped ?? 'cancelled');
        }
        const createQuery =
          options.queryImpl ?? (await import('@anthropic-ai/claude-agent-sdk')).query;
        if (stopped !== undefined || signal.aborted || controller.signal.aborted)
          return failure(stopped ?? 'cancelled');
        const command = options.command ?? 'claude';
        const safeEnv = env;
        const scratch = cwd;
        let outputBytes = 0;
        const count = (chunk: Buffer | string): boolean => {
          outputBytes += Buffer.byteLength(chunk);
          if (outputBytes > MAX_OUTPUT_BYTES) {
            stop('invalid-response');
            return false;
          }
          return stopped === undefined;
        };
        const spawnOwned: NonNullable<Options['spawnClaudeCodeProcess']> = (spec) => {
          if (
            stopped !== undefined ||
            signal.aborted ||
            controller.signal.aborted ||
            children.length > 0 ||
            spec.command !== command ||
            spec.cwd !== scratch
          ) {
            throw new Error('Native metadata process refused');
          }
          const child = (options.spawnImpl ?? spawnRuntime)(command, spec.args, {
            cwd: scratch,
            env: safeEnv,
            shell: false,
            windowsHide: true,
            detached: process.platform !== 'win32',
            stdio: ['pipe', 'pipe', 'pipe'],
          });
          children.push(child);
          child.on('error', () => stop('runtime-unavailable'));
          child.stdin?.on('error', () => stop('runtime-unavailable'));
          if (!child.stdin || !child.stdout) throw new Error('Native metadata streams unavailable');
          const bounded = new Transform({
            transform(chunk: Buffer, _encoding, callback) {
              callback(null, count(chunk) ? chunk : undefined);
            },
          });
          outputs.push(bounded);
          child.stdout.on('error', () => stop('runtime-unavailable'));
          child.stdout.pipe(bounded);
          child.stderr?.on('error', () => stop('runtime-unavailable'));
          // Drain and bound stderr, but never forward it to SDK diagnostics or public results.
          child.stderr?.on('data', (chunk: Buffer | string) => {
            count(chunk);
          });
          const owned: SpawnedProcess = {
            stdin: child.stdin,
            stdout: bounded,
            get killed() {
              return child.killed;
            },
            get exitCode() {
              return child.exitCode;
            },
            get signalCode() {
              return child.signalCode;
            },
            kill: child.kill.bind(child),
            on: child.on.bind(child),
            once: child.once.bind(child),
            off: child.off.bind(child),
          };
          return owned;
        };
        query = createQuery({
          prompt: input,
          options: {
            abortController: controller,
            cwd: scratch,
            env: safeEnv,
            pathToClaudeCodeExecutable: command,
            spawnClaudeCodeProcess: spawnOwned,
            settingSources: [],
            settings: { disableAllHooks: true, disableRemoteControl: true, enabledPlugins: {} },
            tools: [],
            allowedTools: [],
            hooks: {},
            plugins: [],
            skills: [],
            agents: {},
            additionalDirectories: [],
            mcpServers: {},
            strictMcpConfig: true,
            persistSession: false,
            debug: false,
            permissionMode: 'default',
            canUseTool: () =>
              Promise.resolve({ behavior: 'deny', message: 'Metadata-only inventory' }),
            stderr: () => undefined,
          },
        });
        if (typeof query.supportedModels !== 'function') return failure('unsupported');
        let entries: readonly ProviderModelEntry[];
        const raw = await query.supportedModels();
        if (stopped !== undefined || signal.aborted) return failure(stopped ?? 'cancelled');
        try {
          entries = models(raw);
        } catch {
          return failure('invalid-response');
        }
        return { status: 'success', source: 'live-runtime', auth: 'unknown', entries };
      };
      let result: InventorySourceResult;
      try {
        if (signal.aborted) stop('cancelled');
        result = await Promise.race([work().catch(() => failure('refresh-failed')), stopping]);
        if (stopped !== undefined || signal.aborted) result = failure(stopped ?? 'cancelled');
      } finally {
        clearTimeout(deadline);
        // Begin tree termination while the leader is still alive. SDK EOF/close can otherwise lose
        // Windows descendant ownership before taskkill gets the tree (no Job Object guarantee).
        let cleanupTimer: ReturnType<typeof setTimeout> | undefined;
        try {
          await Promise.race([
            Promise.all(
              children.map((child) =>
                Promise.resolve()
                  .then(() => (options.terminateTree ?? terminateProcessTree)(child, env))
                  .catch(() => stop('runtime-unavailable')),
              ),
            ),
            new Promise<void>((done) => {
              cleanupTimer = setTimeout(() => {
                stop('runtime-unavailable');
                done();
              }, CLEANUP_TIMEOUT_MS);
            }),
          ]);
        } finally {
          clearTimeout(cleanupTimer);
          finishInput();
          try {
            query?.close();
          } catch {
            /* No vendor exception text leaves this source. */
          }
          controller.abort();
          for (const child of children) {
            try {
              child.kill('SIGKILL');
            } catch {
              /* Owned-tree helper has already had its bounded chance. */
            }
            child.stdin?.destroy();
            child.stdout?.destroy();
            child.stderr?.destroy();
            child.unref();
          }
          for (const output of outputs) output.destroy();
          signal.removeEventListener('abort', onAbort);
          // Only remove the owned, freshly created direct child of the host's private parent.
          if (cwd)
            await removeScratch(options.privateDirectory, cwd).catch(() =>
              stop('runtime-unavailable'),
            );
        }
      }
      return stopped !== undefined || signal.aborted ? failure(stopped ?? 'cancelled') : result;
    },
  };
}
