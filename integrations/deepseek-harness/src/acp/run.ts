import { join } from 'node:path';
import type { ApprovalGate, ApprovalStore } from '@nexar/approvals';
import { NexarError, isNexarError, measured, unavailable } from '@nexar/contracts';
import type {
  EngineeringWorkspace,
  ExecutionContext,
  ExecutionRequest,
  ExecutionResult,
  PreparedLaunch,
  UsageReport,
} from '@nexar/contracts';
import { credentialEnvName } from '../env.js';
import { mapFailure } from '../failure.js';
import { RunGuard } from '../guard.js';
import type { JsonRpcNotification, JsonRpcReply, JsonRpcStdioClient } from '../json-rpc-client.js';
import { parseRuntimeOptions } from '../options.js';
import { isAuthFailureText } from '../run-collector.js';
import type { BinarySpec, RuntimeProcess } from '../runtime-process.js';
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
  /** Adapter state directory; the per-resource DSH state lives below `acp/<resource id>`. */
  readonly stateDir: string;
  readonly env: NodeJS.ProcessEnv;
  readonly approvals?: { readonly gate: ApprovalGate; readonly store?: ApprovalStore } | undefined;
  readonly initializeTimeoutMs: number;
  readonly defaultTimeoutMs: number;
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
  if ((task.input.attachments?.length ?? 0) > 0) {
    logger.warn('attachments are not forwarded to dsh');
  }

  const guard = new RunGuard(context.signal, timeoutMs);
  let prepared: PreparedLaunch | undefined;
  let proc: RuntimeProcess | undefined;
  let sessionId: string | undefined;
  let broker: PermissionBroker | undefined;
  let promptSettled: Promise<void> | undefined;
  const credentialName = credentialEnvName(resource);
  const credential = credentialName === undefined ? undefined : deps.env[credentialName];
  const secrets = credential === undefined || credential === '' ? [] : [credential];

  try {
    prepared = await guard.race(
      prepareAcpLaunch(
        {
          binary: deps.binary,
          workspace,
          resource,
          dshStateDir: join(deps.stateDir, 'acp', String(resource.id)),
          env: deps.env,
          allowHosts: acp.allowHosts,
        },
        context.signal,
      ),
    );
    if (guard.interrupted) throw new NexarError('EXECUTION_CANCELLED', 'execution was cancelled');

    emit({ type: 'status', message: 'Launching DeepSeek Harness (ACP)' });
    logger.info('launching dsh', {
      command: deps.binary.command,
      profile: 'acp',
      access: workspace.access,
      provider: runtime.provider,
      model: runtime.model,
      permissions: acp.permissions.mode,
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
          { cwd: prepared.workspacePath, mcpServers: [] },
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
    });
    emit({ type: 'status', message: 'DeepSeek Harness runtime ready' });

    const configs: [string, string | undefined][] = [
      ['model', runtime.model],
      ['reasoning_effort', runtime.reasoningEffort],
    ];
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

    return {
      text: text.join(''),
      artifacts: [],
      // `usage_update` reports context-window occupancy, not billed tokens: stay unavailable.
      usage: {
        inputTokens: unavailable('ACP does not report billed tokens'),
        outputTokens: unavailable('ACP does not report billed tokens'),
        costUsd: cost,
      },
      resolved: { provider: runtime.provider, model: runtime.model, runtimeVersion: 'dsh-acp' },
      retries: 0,
    };
  } catch (e) {
    if (guard.interrupted && proc !== undefined && sessionId !== undefined) {
      await cancelSession(proc.client, sessionId, broker, promptSettled);
    }
    throw await mapFailure(classifyRpcError(e), proc, secrets);
  } finally {
    guard.dispose();
    try {
      if (proc !== undefined) await proc.stop();
    } finally {
      await prepared?.dispose().catch(() => undefined);
    }
  }
}

/** ACP cancellation: notify, answer pending permissions `cancelled`, then give the turn a moment to end. */
async function cancelSession(
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
function classifyRpcError(error: unknown): unknown {
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
