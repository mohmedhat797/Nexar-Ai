import { spawn as nodeSpawn } from 'node:child_process';
import { chmod, mkdir, realpath, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { NexarError } from '@nexar/contracts';
import type { Logger } from '@nexar/contracts';
import { mapFailure } from '../failure.js';
import { RunGuard } from '../guard.js';
import type { JsonRpcNotification, JsonRpcReply } from '../json-rpc-client.js';
import { NEXAR_CONTROL_MODEL, NEXAR_CONTROL_TOKEN_ENV, NEXAR_ROUTE } from '../overlay.js';
import { renderProfileOverlay } from '../profiles.js';
import type { DshProfile } from '../profiles.js';
import { allowlistedEnv } from '../runtime/resolve.js';
import type { DshLaunch } from '../runtime/resolve.js';
import { RuntimeProcess } from '../runtime-process.js';
import { acpModelValue } from './gateway.js';
import { PermissionBroker } from './permissions.js';
import type { PermissionDecisionInput } from './permissions.js';
import { cancelSession, classifyRpcError } from './run.js';
import { ToolCallCache } from './tool-calls.js';

export type { PermissionDecisionInput } from './permissions.js';

const SUPPORTED_PROTOCOL_VERSION = 1;
const DEFAULT_INITIALIZE_TIMEOUT_MS = 90_000;
const CLOSE_TIMEOUT_MS = 2_000;
const OVERLAY_FILE = 'nexar.patch.yml';
const DENY_ALL_POLICY = { mode: 'deny', allowTools: [], ttlMs: 1 } as const;

/** Progress of a host-local turn. Never carries tool arguments, paths or prompts. */
export type LocalAcpEvent =
  | { readonly type: 'status'; readonly message: string }
  | { readonly type: 'text-delta'; readonly text: string }
  | { readonly type: 'tool-call'; readonly name: string };

export interface LocalAcpSessionOptions {
  readonly launch: DshLaunch;
  readonly profile: DshProfile;
  /** Absolute; resolved with `realpath`. */
  readonly scratchBase: string;
  /** Must resolve (realpath) to a strict descendant of `scratchBase`, else `POLICY_REJECTED`. */
  readonly scratchDir: string;
  /** Absolute; created 0700; must not be inside `scratchDir`. */
  readonly dshHome: string;
  /** Host-local writes require a per-call ACP decision; no standing write grant. */
  readonly permissionMode: 'read-only';
  readonly control: { readonly baseURL: string; readonly token: string };
  readonly requiredContext?: string | undefined;
  /** ACP stdio MCP server entries for `session/new` (e.g. `bridgeMcpServer(...)`). */
  readonly mcpServers?: readonly Record<string, unknown>[] | undefined;
  /** Normalized tool names the broker allows without asking `decide`. */
  readonly bridgeTools?: readonly string[] | undefined;
  readonly prompt: string;
  readonly decide: (input: PermissionDecisionInput) => Promise<'allow' | 'reject'>;
  readonly onEvent?: ((event: LocalAcpEvent) => void) | undefined;
  readonly parentEnv: NodeJS.ProcessEnv;
  readonly signal: AbortSignal;
  readonly timeoutMs: number;
  /** Deadline for `initialize`, `session/new` and option changes; a cold start takes ~19 s. */
  readonly initializeTimeoutMs?: number | undefined;
  readonly logger: Logger;
  /** Test seam. */
  readonly spawn?: typeof nodeSpawn | undefined;
}

export interface LocalAcpResult {
  readonly text: string;
  readonly stopReason: 'end_turn' | 'max_tokens';
  readonly sessionId: string;
}

/**
 * Runs one prompt turn on a host-local `dsh --profile acp` child (no sandbox): the profile overlay
 * pins the single Nexar route, the child gets an explicit minimal environment, and every permission
 * request is answered through `decide` (deny by default; `*_always` is never selected).
 */
export async function runLocalAcpSession(options: LocalAcpSessionOptions): Promise<LocalAcpResult> {
  const { logger, control } = options;
  const emit = options.onEvent ?? (() => undefined);
  const secrets = [control.token];

  try {
    if (options.signal.aborted) {
      throw new NexarError('EXECUTION_CANCELLED', 'execution was cancelled');
    }
    if (options.permissionMode !== 'read-only') {
      throw new NexarError('POLICY_REJECTED', 'host-local dsh requires per-call write permission');
    }
    const scratchDir = await containedScratch(options.scratchBase, options.scratchDir);
    const overlay = renderProfileOverlay({
      profile: options.profile,
      route: { kind: 'nexar', baseURL: control.baseURL },
      requiredContext: options.requiredContext,
    });
    const home = await prepareHome(options.dshHome, scratchDir);
    const overlayPath = path.join(home, OVERLAY_FILE);
    await writeFile(overlayPath, overlay, { mode: 0o600 });
    await chmod(overlayPath, 0o600);
    return await converse(options, scratchDir, home, overlayPath, emit);
  } catch (error) {
    const mapped = redact(await mapFailure(error, undefined, secrets), control.token);
    logger.warn('local dsh session failed', { code: mapped.code });
    throw mapped;
  }
}

async function converse(
  options: LocalAcpSessionOptions,
  scratchDir: string,
  home: string,
  overlayPath: string,
  emit: (event: LocalAcpEvent) => void,
): Promise<LocalAcpResult> {
  const { launch, logger, control } = options;
  const initializeTimeoutMs = options.initializeTimeoutMs ?? DEFAULT_INITIALIZE_TIMEOUT_MS;
  const mcpServers = options.mcpServers ?? [];
  const guard = new RunGuard(options.signal, options.timeoutMs);
  const expectedModel = acpModelValue(NEXAR_ROUTE, NEXAR_CONTROL_MODEL);
  let proc: RuntimeProcess | undefined;
  let sessionId: string | undefined;
  let broker: PermissionBroker | undefined;
  let promptSettled: Promise<void> | undefined;

  try {
    emit({ type: 'status', message: 'Launching DeepSeek Harness' });
    logger.info('launching dsh', {
      profile: options.profile.id,
      permissions: options.permissionMode,
      bridge: mcpServers.length > 0,
    });
    const spawnFn = options.spawn ?? nodeSpawn;
    proc = new RuntimeProcess(
      spawnFn(launch.command, [...launch.args, '--profile', 'acp', '--patch', overlayPath], {
        cwd: scratchDir,
        env: childEnv(options, home),
        stdio: ['pipe', 'pipe', 'pipe'],
        windowsHide: true,
        // Own process group so stop() can terminate the runtime's whole subprocess tree (POSIX).
        detached: process.platform !== 'win32',
      }),
    );
    const client = proc.client;
    const toolCalls = new ToolCallCache();
    const text: string[] = [];

    client.setRequestHandler((req) => {
      if (req.method !== 'session/request_permission') return undefined;
      if (broker === undefined) return Promise.resolve(failClosed());
      return broker.handle(req.params);
    });
    client.onNotification((n) => {
      if (sessionId === undefined || n.method !== 'session/update') return;
      const update = sessionUpdate(n, sessionId);
      if (update === undefined) return;
      switch (update.sessionUpdate) {
        case 'agent_message_chunk': {
          const content = asRecord(update.content);
          if (content?.type === 'text' && typeof content.text === 'string') {
            text.push(content.text);
            emit({ type: 'text-delta', text: content.text });
          }
          break;
        }
        case 'tool_call': {
          const info = toolCalls.apply(update);
          if (info?.title !== undefined) emit({ type: 'tool-call', name: info.title });
          break;
        }
        case 'tool_call_update':
          toolCalls.apply(update);
          break;
        case 'config_option_update':
          if (modelChanged(update, expectedModel)) {
            guard.fail(
              new NexarError('POLICY_REJECTED', 'dsh changed the model route; aborting the turn', {
                details: { reason: 'model-route-changed' },
              }),
            );
          }
          break;
        default:
      }
    });

    const init = asRecord(
      await guard.race(
        client.request(
          'initialize',
          {
            protocolVersion: SUPPORTED_PROTOCOL_VERSION,
            clientCapabilities: {
              fs: { readTextFile: false, writeTextFile: false },
              terminal: false,
            },
          },
          { timeoutMs: initializeTimeoutMs },
        ),
      ),
    );
    if (init?.protocolVersion !== SUPPORTED_PROTOCOL_VERSION) {
      throw new NexarError(
        'INTEGRATION_UNAVAILABLE',
        `dsh speaks an unsupported ACP protocol version (supported: ${String(SUPPORTED_PROTOCOL_VERSION)})`,
        { details: { reason: 'protocol-version' } },
      );
    }

    const created = asRecord(
      await guard.race(
        client.request(
          'session/new',
          { cwd: scratchDir, mcpServers },
          { timeoutMs: initializeTimeoutMs },
        ),
      ),
    );
    if (typeof created?.sessionId !== 'string') {
      throw new NexarError('PROVIDER_ERROR', 'dsh answered session/new without a sessionId', {
        details: { reason: 'protocol' },
      });
    }
    const id = created.sessionId;
    sessionId = id;
    broker = new PermissionBroker({
      sessionId: id,
      policy: DENY_ALL_POLICY,
      lookupToolCall: (toolCallId) => toolCalls.get(toolCallId),
      logger,
      bridgeTools: options.bridgeTools,
      decide: options.decide,
    });
    emit({ type: 'status', message: 'DeepSeek Harness runtime ready' });

    await guard.race(
      client.request(
        'session/set_config_option',
        { sessionId: id, configId: 'model', value: expectedModel },
        { timeoutMs: initializeTimeoutMs },
      ),
    );

    const prompting = client.request('session/prompt', {
      sessionId: id,
      prompt: [{ type: 'text', text: options.prompt }],
    });
    promptSettled = prompting.then(
      () => undefined,
      () => undefined,
    );
    const response = asRecord(await guard.race(prompting));
    const stopReason = response?.stopReason;
    if (stopReason === 'cancelled') {
      throw new NexarError('EXECUTION_CANCELLED', 'dsh cancelled the prompt turn');
    }
    if (stopReason !== 'end_turn' && stopReason !== 'max_tokens') {
      throw new NexarError('PROVIDER_ERROR', 'dsh stopped the turn unexpectedly', {
        details: {
          stopReason: typeof stopReason === 'string' ? stopReason.slice(0, 80) : 'unknown',
        },
      });
    }
    if (stopReason === 'max_tokens') {
      emit({ type: 'status', message: 'dsh stopped at the token limit; output may be truncated' });
    }

    await client
      .request('session/close', { sessionId: id }, { timeoutMs: CLOSE_TIMEOUT_MS })
      .catch(() => undefined);
    emit({ type: 'status', message: 'DeepSeek Harness turn finished' });
    return { text: text.join(''), stopReason, sessionId: id };
  } catch (error) {
    if (guard.interrupted && proc !== undefined && sessionId !== undefined) {
      await cancelSession(proc.client, sessionId, broker, promptSettled);
    }
    throw await mapFailure(classifyRpcError(error), proc, [control.token]);
  } finally {
    guard.dispose();
    if (proc !== undefined) await proc.stop();
  }
}

/** The child's complete environment: allowlisted parent variables plus what the session needs. */
function childEnv(options: LocalAcpSessionOptions, home: string): Record<string, string> {
  return {
    ...allowlistedEnv(options.launch, options.parentEnv),
    HOME: home,
    USERPROFILE: home,
    DSH_HOME: home,
    DSH_PERMISSION_MODE: options.permissionMode,
    DSH_TELEMETRY_DISABLED: '1',
    [NEXAR_CONTROL_TOKEN_ENV]: options.control.token,
  };
}

/** Realpaths base and dir; the dir must be a strict descendant of the base (nothing is spawned otherwise). */
async function containedScratch(base: string, dir: string): Promise<string> {
  if (!path.isAbsolute(base) || !path.isAbsolute(dir)) throw scratchRejected();
  let realBase: string;
  let realDir: string;
  try {
    [realBase, realDir] = await Promise.all([realpath(base), realpath(dir)]);
  } catch {
    throw scratchRejected();
  }
  if (!isStrictDescendant(realBase, realDir)) throw scratchRejected();
  return realDir;
}

async function prepareHome(dshHome: string, scratchDir: string): Promise<string> {
  if (!path.isAbsolute(dshHome) || isInside(scratchDir, path.resolve(dshHome))) {
    throw homeRejected();
  }
  await mkdir(dshHome, { recursive: true, mode: 0o700 });
  await chmod(dshHome, 0o700);
  const real = await realpath(dshHome);
  if (isInside(scratchDir, real)) throw homeRejected();
  return real;
}

/** True when `child` equals `parent` or lies below it. */
function isInside(parent: string, child: string): boolean {
  const relative = path.relative(parent, child);
  return relative === '' || (!relative.startsWith('..') && !path.isAbsolute(relative));
}

function isStrictDescendant(parent: string, child: string): boolean {
  const relative = path.relative(parent, child);
  return (
    relative !== '' &&
    relative !== '..' &&
    !relative.startsWith(`..${path.sep}`) &&
    !path.isAbsolute(relative)
  );
}

function scratchRejected(): NexarError {
  return new NexarError('POLICY_REJECTED', 'the scratch directory is outside its base', {
    details: { reason: 'scratch-outside-base' },
  });
}

function homeRejected(): NexarError {
  return new NexarError('POLICY_REJECTED', 'the dsh home must be outside the scratch directory', {
    details: { reason: 'dsh-home-in-scratch' },
  });
}

/** True when a `config_option_update` sets the `model` option to anything but the Nexar route. */
function modelChanged(update: Record<string, unknown>, expected: string): boolean {
  const entries: unknown[] = Array.isArray(update.configOptions) ? update.configOptions : [update];
  for (const entry of entries) {
    const option = asRecord(entry);
    if ((option?.id ?? option?.configId) !== 'model') continue;
    const value = option?.currentValue ?? option?.value;
    if (value !== expected) return true;
  }
  return false;
}

/** Errors leave this module with codes and fixed texts only: the control token is scrubbed from both. */
function redact(error: NexarError, token: string): NexarError {
  if (token.length < 4) return error;
  const leaks = (value: string): boolean => value.includes(token);
  const detailsText = error.details === undefined ? '' : safeJson(error.details);
  if (!leaks(error.message) && !leaks(detailsText)) return error;
  return new NexarError(error.code, error.message.split(token).join('[redacted]'));
}

function safeJson(value: unknown): string {
  try {
    return JSON.stringify(value) ?? '';
  } catch {
    return '';
  }
}

function failClosed(): JsonRpcReply {
  return { error: { code: -32603, message: 'permission handler not ready; failing closed' } };
}

function sessionUpdate(
  notification: JsonRpcNotification,
  sessionId: string,
): Record<string, unknown> | undefined {
  const params = asRecord(notification.params);
  if (params === undefined || params.sessionId !== sessionId) return undefined;
  return asRecord(params.update);
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}
