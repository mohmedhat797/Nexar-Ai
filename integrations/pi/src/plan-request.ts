import { NexarError } from '@nexar/contracts';
import {
  planFailureReasonForCode,
  planRequestError,
  type PlanRequestFailureReason,
} from './result.js';

const MAX_ERROR_BYTES = 64 * 1024;
const object = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

async function abortable<T>(promise: Promise<T>, signal: AbortSignal): Promise<T> {
  const cancelled = (): NexarError =>
    new NexarError('EXECUTION_CANCELLED', 'Execution was cancelled');
  if (signal.aborted) throw cancelled();
  let rejectAbort: ((error: NexarError) => void) | undefined;
  const onAbort = (): void => {
    rejectAbort?.(cancelled());
  };
  const abort = new Promise<never>((_resolve, reject) => {
    rejectAbort = reject;
  });
  signal.addEventListener('abort', onAbort, { once: true });
  try {
    return await Promise.race([promise, abort]);
  } finally {
    signal.removeEventListener('abort', onAbort);
  }
}

function reasonFor(
  error: unknown,
  genericModelRejection = false,
): PlanRequestFailureReason | undefined {
  if (!object(error)) return undefined;
  const known = planFailureReasonForCode(error.code);
  if (known !== undefined) return known;
  // A generic model-parameter rejection is inspected locally only. It is never forwarded.
  if (
    genericModelRejection &&
    (error.code === 'invalid_request_error' || error.type === 'invalid_request_error') &&
    error.param === 'model' &&
    typeof error.message === 'string' &&
    error.message.length <= 4_000 &&
    /(?:\bmodel\b.{0,300}\b(?:not supported|unsupported|not available|does not exist)\b|\bunsupported model\b)/i.test(
      error.message,
    )
  )
    return 'model-unavailable';
  return undefined;
}

/** Per-attempt boundary. No provider error body or thrown cause crosses it. */
export function createPlanRequestGuard(doFetch: typeof fetch = fetch, signal: AbortSignal) {
  let reason: PlanRequestFailureReason | undefined;
  const failure = (): NexarError =>
    signal.aborted
      ? new NexarError('EXECUTION_CANCELLED', 'Execution was cancelled')
      : planRequestError(reason ?? 'unknown');
  const guardedFetch: typeof fetch = async (input, init) => {
    let response: Response;
    try {
      if (signal.aborted) throw failure();
      response = await abortable(doFetch(input, { ...init, redirect: 'error' }), signal);
      if (response.ok) return response;
      reason =
        response.status === 401
          ? 'invalid-user'
          : response.status === 429
            ? 'usage-limit-exceeded'
            : 'unknown';
      const reader = (response.body as ReadableStream<Uint8Array> | null)?.getReader();
      if (reader !== undefined) {
        const chunks: Uint8Array[] = [];
        let bytes = 0;
        const onAbort = (): void => {
          void reader.cancel().catch(() => undefined);
        };
        signal.addEventListener('abort', onAbort, { once: true });
        try {
          for (;;) {
            signal.throwIfAborted();
            const next = await abortable(reader.read(), signal);
            if (next.done) break;
            bytes += next.value.byteLength;
            if (bytes > MAX_ERROR_BYTES) break;
            chunks.push(next.value);
          }
          if (bytes <= MAX_ERROR_BYTES) {
            let body: unknown;
            try {
              body = JSON.parse(Buffer.concat(chunks).toString('utf8'));
            } catch {
              body = undefined;
            }
            if (object(body)) reason = reasonFor(body.error, response.status === 400) ?? reason;
          }
        } finally {
          signal.removeEventListener('abort', onAbort);
          void reader.cancel().catch(() => undefined);
        }
      }
      // The SDK sees a bounded synthetic body; raw text stays in this attempt only.
      return new Response(
        JSON.stringify({
          error: { code: 'nexar_plan_request_failed', message: 'The ChatGPT plan request failed' },
        }),
        { status: response.status, headers: { 'content-type': 'application/json' } },
      );
    } catch {
      throw failure();
    }
  };
  return {
    fetch: guardedFetch,
    onPayload(this: void, payload: unknown): unknown {
      if (!object(payload) || !Array.isArray(payload.input)) throw failure();
      const out = { ...payload };
      const input: readonly unknown[] = payload.input;
      // Initial legacy context.tools otherwise become flat top-level Responses tools.
      // This account route explicitly supports developer additional_tools input items.
      if (Array.isArray(out.tools) && out.tools.length > 0) {
        out.input = [{ type: 'additional_tools', role: 'developer', tools: out.tools }, ...input];
        delete out.tools;
      }
      for (const field of [
        'reasoning',
        'temperature',
        'max_output_tokens',
        'max_tool_calls',
        'previous_response_id',
        'background',
        'conversation',
        'metadata',
        'moderation',
        'multi_agent',
        'prompt',
        'prompt_cache_retention',
        'safety_identifier',
        'top_logprobs',
        'top_p',
        'truncation',
        'user',
      ])
        delete out[field];
      out.store = false;
      out.stream = true;
      return out;
    },
    onProviderStreamEvent(this: void, event: unknown): void {
      if (!object(event)) return;
      if (event.type === 'response.failed')
        reason = object(event.response)
          ? (reasonFor(event.response.error) ?? 'unknown')
          : 'unknown';
      else if (event.type === 'error') reason = reasonFor(event) ?? 'unknown';
    },
    failure,
    get rejectedModel(): boolean {
      return reason === 'model-unavailable';
    },
  };
}

/** Invalidation observers cannot replace the fixed request error. */
export function notifyPlanModelRejected<T>(
  callback: ((descriptor: T) => void) | undefined,
  descriptor: T,
): void {
  try {
    callback?.(descriptor);
  } catch {
    /* Observer failure cannot expose a different error. */
  }
}
