import { mkdir, mkdtemp, rm } from 'node:fs/promises';
import { join } from 'node:path';
import type { ApprovalGate, ApprovalStore } from '@nexar/approvals';
import { NexarError, isNexarError, measured, unavailable } from '@nexar/contracts';
import type {
  EngineeringWorkspace,
  ExecutionContext,
  ExecutionRequest,
  ExecutionResult,
  PreparedLaunch,
  SecretResolver,
  UsageReport,
} from '@nexar/contracts';
import { assertKeystoreCredentialStored, resolveOwnCredential } from '../env.js';
import type { CredentialSources } from '../env.js';
import { mapFailure } from '../failure.js';
import { RunGuard } from '../guard.js';
import type { JsonRpcNotification, JsonRpcReply, JsonRpcStdioClient } from '../json-rpc-client.js';
import { parseRuntimeOptions } from '../options.js';
import { isAuthFailureText } from '../run-collector.js';
import type { BinarySpec, RuntimeProcess } from '../runtime-process.js';
import {
  GATEWAY_ROUTE,
  acpModelValue,
  bridgeMcpServer,
  bridgeToolNames,
  isGatewayMode,
  requireGatewayEndpoints,
  resolveNodeCommand,
} from './gateway.js';
import { prepareAcpLaunch, spawnPrepared } from './launch.js';
import { parseAcpOptions } from './options.js';
import { PermissionBroker } from './permissions.js';
import { ToolCallCache } from './tool-calls.js';

const SUPPORTED_PROTOCOL_VERSION = 1;
const CANCEL_GRACE_MS = 2_000;
const CLOSE_TIMEOUT_MS = 2_000;
const RPC_ERROR_MAX = 300;

/**
 * The system prompt is prepended to the single text block, since `session/prompt` has no separate
 * system channel. The separator makes the boundary explicit to the model.
 */
export const SYSTEM_PROMPT_SEPARATOR =
  '\n\n--- end of system instructions; the task follows ---\n\n';

export interface AcpRunDeps {
  readonly binary: BinarySpec;
  /** Adapter state directory; each run creates and removes a private home below `acp/`. */
  readonly stateDir: string;
  readonly env: NodeJS.ProcessEnv;
  /** Resolves `keystore` credentials (the adapter's injected resolver). */
  readonly resolveSecret?: SecretResolver | undefined;
  readonly approvals?: { readonly gate: ApprovalGate; readonly store?: ApprovalStore } | undefined;
  readonly initializeTimeoutMs: number;
  readonly defaultTimeoutMs: number;
  /** Absolute in-sandbox path of the Node that runs the bridge relay (see `resolveNodeCommand`). */
  readonly nodeCommand?: string | undefined;
}

/** Runs one engineering task on `dsh --profile acp`, answering every permission request via approvals. */
export async function executeAcp(
  request: ExecutionRequest,
  context: ExecutionContext,
  workspace: EngineeringWorkspace,
  deps: AcpRunDeps,
): Promise<ExecutionResult> {
  const { task, resource } = request;
  const runtime = parseRuntimeOptions(resource);
  const acp = runtime.acp ?? parseAcpOptions(undefined);
  const timeoutMs = runtime.timeoutMs ?? deps.defaultTimeoutMs;
  const emit = context.onEvent ?? (() => undefined);
  const logger = context.logger.child({ adapter: 'deepseek-harness', taskId: task.id });

  if (context.signal.aborted)
    throw new NexarError('EXECUTION_CANCELLED', 'execution was cancelled');
  if (workspace.access === 'read-write' && workspace.launcher.isolation !== 'sandbox') {
    throw new NexarError(
      'POLICY_REJECTED',
      'a read-write engineering workspace requires the sandbox launcher; refusing to start dsh',
    );
  }
  if ((task.input.attachments?.length ?? 0) > 0) {
    logger.warn('attachments are not forwarded to dsh');
  }

  let prepared: PreparedLaunch | undefined;
  let preparing: Promise<PreparedLaunch> | undefined;
  let proc: RuntimeProcess | undefined;
  let sessionId: string | undefined;
  let broker: PermissionBroker | undefined;
  let promptSettled: Promise<void> | undefined;
  let dshStateDir: string | undefined;
  let result: ExecutionResult;
  let cleanupFailed: boolean;
  const sources: CredentialSources = { env: deps.env, resolveSecret: deps.resolveSecret };
  // Gateway mode (ADR-027 section 9b): the lane's loop runs on Nexar's control route, with no DSH credential.
  const gateway = isGatewayMode(context.gateway) ? context.gateway : undefined;
  let secrets: string[];
  if (gateway === undefined) {
    assertKeystoreCredentialStored(resource, sources);
    const credential = resolveOwnCredential(resource, sources);
    secrets = credential === undefined || credential === '' ? [] : [credential];
  } else {
    secrets = [gateway.token];
  }
  const provider = gateway === undefined ? runtime.provider : GATEWAY_ROUTE.provider;
  const model = gateway === undefined ? runtime.model : GATEWAY_ROUTE.model;
  const expectedModel = acpModelValue(provider, model);
  const guard = new RunGuard(context.signal, timeoutMs);
  const preparationController = new AbortController();
  const abortPreparation = (): void => preparationController.abort();
  context.signal.addEventListener('abort', abortPreparation, { once: true });
  if (context.signal.aborted) abortPreparation();

  try {
    const acpStateBase = join(deps.stateDir, 'acp');
    await mkdir(acpStateBase, { recursive: true, mode: 0o700 });
    dshStateDir = await mkdtemp(join(acpStateBase, 'turn-'));
    preparing = prepareAcpLaunch(
      {
        binary: deps.binary,
        workspace,
        resource,
        dshStateDir,
        sources,
        allowHosts: acp.allowHosts,
        gateway,
        requiredContext: context.requiredContext,
      },
      preparationController.signal,
    );
    prepared = await guard.race(preparing);
    if (guard.interrupted) throw new NexarError('EXECUTION_CANCELLED', 'execution was cancelled');

    let mcpServers: Record<string, unknown>[] = [];
    if (gateway !== undefined) {
      const { bridge } = requireGatewayEndpoints(gateway, prepared);
      if (bridge !== undefined) {
        const node = resolveNodeCommand(deps.nodeCommand, deps.binary.command);
        // dsh rolls back a session whose MCP server cannot start, so an unknown in-sandbox Node means
        // no bridge for this lane (the control loop still runs on the gateway), never a guessed path.
        if (node === undefined)
          logger.warn('dsh bridge not offered', { reason: 'node-unavailable' });
        else mcpServers = [bridgeMcpServer(node, bridge, gateway.token)];
      }
    }

    emit({ type: 'status', message: 'Launching DeepSeek Harness (ACP)' });
    logger.info('launching dsh', {
      command: deps.binary.command,
      profile: 'acp',
      access: workspace.access,
      provider,
      model,
      permissions: acp.permissions.mode,
      ...(gateway === undefined ? {} : { gateway: true, bridge: mcpServers.length > 0 }),
    });
    proc = spawnPrepared(prepared);
    const client = proc.client;

    const toolCalls = new ToolCallCache();
    const text: string[] = [];
    let cost: UsageReport['costUsd'] = unavailable('dsh did not report cost');

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
        case 'usage_update': {
          const reported = asRecord(update.cost);
          if (reported?.currency === 'USD' && typeof reported.amount === 'number') {
            cost = measured(reported.amount);
          }
          break;
        }
        case 'config_option_update': {
          const entries: unknown[] = Array.isArray(update.configOptions)
            ? update.configOptions
            : [update];
          if (
            entries.some((entry) => {
              const option = asRecord(entry);
              return (
                (option?.id ?? option?.configId) === 'model' &&
                (option?.currentValue ?? option?.value) !== expectedModel
              );
            })
          ) {
            guard.fail(
              new NexarError('POLICY_REJECTED', 'dsh changed the model route; aborting the turn', {
                details: { reason: 'model-route-changed' },
              }),
            );
          }
          break;
        }
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
          { timeoutMs: deps.initializeTimeoutMs },
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
          { cwd: prepared.workspacePath, mcpServers },
          { timeoutMs: deps.initializeTimeoutMs },
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
      policy: acp.permissions,
      lookupToolCall: (toolCallId) => toolCalls.get(toolCallId),
      gate: deps.approvals?.gate,
      store: deps.approvals?.store,
      taskId: String(task.id),
      projectId: task.projectId === undefined ? undefined : String(task.projectId),
      logger,
      bridgeTools: mcpServers.length === 0 ? undefined : bridgeToolNames(),
    });
    emit({ type: 'status', message: 'DeepSeek Harness runtime ready' });

    // The `model` value is the opaque JSON pair DSH advertises; the control route has no reasoning option.
    const configs: [string, string | undefined][] =
      gateway === undefined
        ? [
            [
              'model',
              runtime.model === undefined
                ? undefined
                : acpModelValue(runtime.provider, runtime.model),
            ],
            ['reasoning_effort', runtime.reasoningEffort],
          ]
        : [['model', acpModelValue(GATEWAY_ROUTE.provider, GATEWAY_ROUTE.model)]];
    for (const [configId, value] of configs) {
      if (value === undefined) continue;
      await guard.race(
        client.request(
          'session/set_config_option',
          { sessionId: id, configId, value },
          { timeoutMs: deps.initializeTimeoutMs },
        ),
      );
    }

    const promptText =
      task.input.systemPrompt === undefined
        ? task.input.prompt
        : `${task.input.systemPrompt}${SYSTEM_PROMPT_SEPARATOR}${task.input.prompt}`;
    const prompting = client.request('session/prompt', {
      sessionId: id,
      prompt: [{ type: 'text', text: promptText }],
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
    if (stopReason === 'max_tokens') {
      emit({
        type: 'status',
        message: 'dsh stopped at the token limit; output may be truncated',
      });
    } else if (stopReason !== 'end_turn') {
      throw new NexarError('PROVIDER_ERROR', `dsh stopped the turn: ${describe(stopReason)}`, {
        details: { stopReason: describe(stopReason) },
      });
    }

    await client
      .request('session/close', { sessionId: id }, { timeoutMs: CLOSE_TIMEOUT_MS })
      .catch(() => undefined);
    emit({ type: 'status', message: 'DeepSeek Harness run finished' });

    result = {
      text: text.join(''),
      artifacts: [],
      // `usage_update` reports context-window occupancy, not billed tokens: stay unavailable.
      usage: {
        inputTokens: unavailable('ACP does not report billed tokens'),
        outputTokens: unavailable('ACP does not report billed tokens'),
        costUsd: gateway === undefined ? cost : unavailable('accounted by Nexar control gateway'),
      },
      resolved: { provider, model, runtimeVersion: 'dsh-acp' },
      retries: 0,
    };
  } catch (e) {
    abortPreparation();
    if (guard.interrupted && proc !== undefined && sessionId !== undefined) {
      await cancelSession(proc.client, sessionId, broker, promptSettled);
    }
    throw await mapFailure(classifyRpcError(e), proc, secrets);
  } finally {
    guard.dispose();
    context.signal.removeEventListener('abort', abortPreparation);
    try {
      if (proc !== undefined) await proc.stop();
    } finally {
      // Never delete a home that preparation may still write. An uncooperative launcher must not
      // defeat the turn deadline: keep the handled cleanup chain alive for eventual settlement.
      const cleanup = (async () => {
        const cleanupPrepared = prepared ?? (await preparing?.catch(() => undefined));
        try {
          await cleanupPrepared?.dispose();
        } finally {
          if (dshStateDir !== undefined) {
            await rm(dshStateDir, { recursive: true, force: true, maxRetries: 3, retryDelay: 50 });
          }
        }
      })().then(
        () => true,
        () => {
          logger.warn('dsh state cleanup failed', { code: 'INTEGRATION_UNAVAILABLE' });
          return false;
        },
      );
      let timer: NodeJS.Timeout | undefined;
      try {
        const cleaned = await Promise.race([
          cleanup,
          new Promise<boolean>((resolve) => {
            timer = setTimeout(() => {
              logger.warn('dsh state cleanup deferred', { code: 'EXECUTION_TIMEOUT' });
              resolve(false);
            }, CLOSE_TIMEOUT_MS);
          }),
        ]);
        cleanupFailed = !cleaned;
      } finally {
        if (timer !== undefined) clearTimeout(timer);
      }
    }
  }
  if (cleanupFailed) {
    throw new NexarError('INTEGRATION_UNAVAILABLE', 'dsh state cleanup did not complete');
  }
  return result;
}

/** ACP cancellation: notify, answer pending permissions `cancelled`, then give the turn a moment to end. */
export async function cancelSession(
  client: JsonRpcStdioClient,
  sessionId: string,
  broker: PermissionBroker | undefined,
  promptSettled: Promise<void> | undefined,
): Promise<void> {
  broker?.cancelAll();
  if (client.closed) return;
  await client.notify('session/cancel', { sessionId }).catch(() => undefined);
  if (promptSettled === undefined) return;
  let timer: NodeJS.Timeout | undefined;
  const grace = new Promise<void>((resolve) => {
    timer = setTimeout(resolve, CANCEL_GRACE_MS);
  });
  await Promise.race([promptSettled, grace]);
  clearTimeout(timer);
}

/** JSON-RPC errors from dsh are provider-side failures; split out auth and quota like the sdk path. */
export function classifyRpcError(error: unknown): unknown {
  if (!isNexarError(error) || error.code !== 'PROVIDER_ERROR') return error;
  if (error.details?.rpcCode === undefined) return error;
  const message = error.message.slice(0, RPC_ERROR_MAX);
  if (isAuthFailureText(message)) {
    return new NexarError('AUTH_REQUIRED', message, { details: error.details });
  }
  if (/quota|insufficient (balance|funds)|rate.?limit|\b(402|429)\b/i.test(message)) {
    return new NexarError('QUOTA_EXHAUSTED', message, { details: error.details });
  }
  return error;
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

function describe(value: unknown): string {
  return typeof value === 'string' ? value.slice(0, 80) : 'unknown';
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}
