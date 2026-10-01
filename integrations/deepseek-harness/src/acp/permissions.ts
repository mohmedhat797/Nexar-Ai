import { canonicalJson, recordPolicyDecision } from '@nexar/approvals';
import type { ApprovalGate, ApprovalStore, OutwardAction } from '@nexar/approvals';
import type { Logger } from '@nexar/contracts';
import type { JsonRpcReply } from '../json-rpc-client.js';
import type { PermissionPolicy } from './options.js';
import type { ToolCallInfo } from './tool-calls.js';

export const ACP_ACTION_TYPE = 'agent.tool';
const ADAPTER_NAME = 'deepseek-harness';

export interface PermissionBrokerOptions {
  readonly sessionId: string;
  readonly policy: PermissionPolicy;
  readonly lookupToolCall: (toolCallId: string) => ToolCallInfo | undefined;
  readonly gate?: ApprovalGate | undefined;
  readonly store?: ApprovalStore | undefined;
  readonly taskId?: string | undefined;
  readonly projectId?: string | undefined;
  readonly logger: Logger;
}

interface PermissionRequest {
  readonly sessionId: string;
  readonly toolCallId: string;
  readonly options: readonly { readonly optionId: string; readonly kind: string }[];
}

type Decision = 'allow' | 'reject';

const CANCELLED: JsonRpcReply = { result: { outcome: { outcome: 'cancelled' } } };
const NO_REJECT_OPTION: JsonRpcReply = {
  error: { code: -32000, message: 'no reject option offered; failing closed' },
};

function selected(optionId: string): JsonRpcReply {
  return { result: { outcome: { outcome: 'selected', optionId } } };
}

/**
 * Answers ACP `session/request_permission` through Nexar's approvals (ADR-019 section 6).
 *
 * Deny by default: every path that is not an explicit, fingerprint-bound, single-use grant (or an
 * allow-listed policy decision that was recorded) answers with the `reject_once` option. The answer
 * is chosen by option KIND, never by id, and `*_always` options are never selected. Tool arguments
 * (`rawInput`) feed the fingerprint only; they are never logged.
 */
export class PermissionBroker {
  private cancelled = false;
  private readonly abort = new AbortController();

  constructor(private readonly options: PermissionBrokerOptions) {}

  /** Nexar sent `session/cancel`: stop waiting on humans and answer every request `cancelled`. */
  cancelAll(): void {
    this.cancelled = true;
    this.abort.abort();
  }

  async handle(params: unknown): Promise<JsonRpcReply> {
    const request = parseRequest(params);
    const reply = await this.answer(request).catch((): JsonRpcReply => rejectReply(request));
    // `cancelled` is only ever sent after Nexar's own `session/cancel`.
    return this.cancelled ? CANCELLED : reply;
  }

  private async answer(request: PermissionRequest | undefined): Promise<JsonRpcReply> {
    if (request === undefined || request.sessionId !== this.options.sessionId) {
      return rejectReply(request);
    }
    if (this.cancelled) return CANCELLED;
    const decision = await this.decide(request).catch((): Decision => 'reject');
    if (decision === 'allow') {
      const allow = request.options.find((o) => o.kind === 'allow_once');
      if (allow !== undefined) return selected(allow.optionId);
    }
    return rejectReply(request);
  }

  private async decide(request: PermissionRequest): Promise<Decision> {
    const { policy, gate, store } = this.options;
    const info = this.options.lookupToolCall(request.toolCallId);
    if (info === undefined || info.title === undefined || info.rawInput === undefined) {
      this.options.logger.warn('acp permission rejected: no preceding tool_call');
      return 'reject';
    }
    try {
      canonicalJson(info.rawInput);
    } catch {
      this.options.logger.warn('acp permission rejected: tool input is not JSON', {
        tool: info.title,
      });
      return 'reject';
    }

    const tool = info.title;
    const action: OutwardAction = {
      type: ACP_ACTION_TYPE,
      target: `${ADAPTER_NAME}:${tool}`,
      parameters: {
        adapter: ADAPTER_NAME,
        tool,
        kind: info.kind ?? 'other',
        args: info.rawInput as OutwardAction['parameters'][string],
      },
    };
    const ctx = {
      summary: `DeepSeek Harness wants to run ${tool}`,
      risk: 'medium' as const,
      ...(this.options.taskId === undefined ? {} : { taskId: this.options.taskId }),
      ...(this.options.projectId === undefined ? {} : { projectId: this.options.projectId }),
      metadata: { tool, toolCallId: request.toolCallId },
    };

    if (policy.mode === 'deny') {
      await this.record(action, ctx, 'denied');
      return 'reject';
    }
    // Nothing Nexar could answer an approval with: do not bother a human.
    if (!request.options.some((o) => o.kind === 'allow_once')) return 'reject';

    if (
      policy.mode === 'allow-listed' &&
      policy.allowTools.includes(tool) &&
      store !== undefined &&
      // An allow needs its audit record; if it cannot be written, fall through to `ask`.
      (await this.record(action, ctx, 'allowed'))
    ) {
      this.options.logger.info('acp permission allowed by policy', { tool });
      return 'allow';
    }

    // `ask`, or an allow-listed policy that does not cover this tool.
    if (gate === undefined) return 'reject';
    const grant = await gate.request(action, {
      ...ctx,
      ttlMs: policy.ttlMs,
      signal: this.abort.signal,
    });
    await grant.consume(action);
    this.options.logger.info('acp permission approved', { tool, approvalId: grant.approvalId });
    return 'allow';
  }

  /** Records a policy decision; true only when it was written. */
  private async record(
    action: OutwardAction,
    ctx: Parameters<typeof recordPolicyDecision>[2],
    outcome: 'allowed' | 'denied',
  ): Promise<boolean> {
    const { store } = this.options;
    if (store === undefined) return false;
    try {
      await recordPolicyDecision(store, action, ctx, outcome);
      return true;
    } catch {
      this.options.logger.warn('could not record acp policy decision', { outcome });
      return false;
    }
  }
}

/** The `reject_once` option, else a JSON-RPC error (DSH maps client errors to `unavailable`: fail closed). */
function rejectReply(request: PermissionRequest | undefined): JsonRpcReply {
  const reject = request?.options.find((o) => o.kind === 'reject_once');
  return reject === undefined ? NO_REJECT_OPTION : selected(reject.optionId);
}

function parseRequest(params: unknown): PermissionRequest | undefined {
  if (typeof params !== 'object' || params === null) return undefined;
  const p = params as Record<string, unknown>;
  const toolCall = p.toolCall as { toolCallId?: unknown } | null | undefined;
  if (typeof p.sessionId !== 'string' || typeof toolCall?.toolCallId !== 'string') return undefined;
  if (!Array.isArray(p.options)) return undefined;
  const options: { optionId: string; kind: string }[] = [];
  for (const o of p.options as unknown[]) {
    const entry = o as { optionId?: unknown; kind?: unknown } | null;
    if (typeof entry?.optionId === 'string' && typeof entry.kind === 'string') {
      options.push({ optionId: entry.optionId, kind: entry.kind });
    }
  }
  return { sessionId: p.sessionId, toolCallId: toolCall.toolCallId, options };
}
