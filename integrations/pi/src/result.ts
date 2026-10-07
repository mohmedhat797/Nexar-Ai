import {
  NexarError,
  estimated,
  isNexarError,
  measured,
  toNexarError,
  unavailable,
} from '@nexar/contracts';
import type { ExecutionEvent, ExecutionResult } from '@nexar/contracts';
import { PI_AI_RUNTIME_VERSION } from './pi-models.js';
import type { PiAssistantMessageLike } from './pi-models.js';

const MAX_ERROR_MESSAGE_CHARS = 300;
const AUTH_PATTERN = /401|unauthori[sz]ed|invalid api key|not configured/i;
const QUOTA_PATTERN = /429|rate limit|quota/i;

/** Extras for {@link toExecutionResult}. */
export interface ToExecutionResultOptions {
  readonly onEvent?: (event: ExecutionEvent) => void;
  /** Secret values scrubbed from any error text (a provider may echo the key it rejected). */
  readonly secrets?: readonly string[];
  readonly costMode?: 'catalog' | 'unavailable';
}

/** Removes every non-empty secret from `text`. */
export function redactSecrets(text: string, secrets: readonly string[] = []): string {
  let out = text;
  for (const secret of secrets) {
    if (secret.length > 0) out = out.split(secret).join('[redacted]');
  }
  return out;
}

function truncate(text: string): string {
  return text.length > MAX_ERROR_MESSAGE_CHARS
    ? `${text.slice(0, MAX_ERROR_MESSAGE_CHARS)}…`
    : text;
}

/** Why a ChatGPT plan call failed; ids only, never any part of the provider's response. */
export type ChatGptPlanFailureReason =
  | 'invalid-user'
  | 'usage-limit-exceeded'
  | 'plan-not-eligible'
  | 'unsupported-capability'
  | 'usage-unavailable'
  | 'route-not-supported';
export type PlanRequestFailureReason = ChatGptPlanFailureReason | 'model-unavailable' | 'unknown';

/** All plan failures are fixed text, including failures without a recognized provider code. */
export function planRequestError(reason: PlanRequestFailureReason): NexarError {
  if (reason === 'model-unavailable')
    return new NexarError(
      'PROVIDER_ERROR',
      'This model is no longer available through the ChatGPT connection',
      { details: { reason } },
    );
  const known = PLAN_FAILURES.find((failure) => failure.reason === reason);
  if (known !== undefined)
    return new NexarError(known.code, known.message, {
      retryable: known.retryable,
      details: { reason },
    });
  return new NexarError('PROVIDER_ERROR', 'The ChatGPT plan request failed', {
    details: { reason: 'unknown' },
  });
}

/** Recognized codes only; arbitrary provider messages cannot become an auth or quota failure. */
export function planFailureReasonForCode(code: unknown): PlanRequestFailureReason | undefined {
  if (code === 'model_not_found' || code === 'unsupported_model') return 'model-unavailable';
  return PLAN_FAILURES.find((failure) => failure.marker === code)?.reason;
}

interface PlanFailure {
  readonly marker: string;
  readonly reason: ChatGptPlanFailureReason;
  readonly code: 'AUTH_REQUIRED' | 'QUOTA_EXHAUSTED' | 'PROVIDER_ERROR';
  readonly message: string;
  readonly retryable: boolean;
}

// The documented Sign in with ChatGPT error codes (token-sharing errors-and-recovery). Fixed
// messages only: the body, which may echo request content, is never forwarded.
const PLAN_FAILURES: readonly PlanFailure[] = [
  {
    marker: 'subscription_sharing_invalid_user',
    reason: 'invalid-user',
    code: 'AUTH_REQUIRED',
    message: 'The ChatGPT sign-in was rejected',
    retryable: false,
  },
  {
    marker: 'subscription_sharing_usage_limit_exceeded',
    reason: 'usage-limit-exceeded',
    code: 'QUOTA_EXHAUSTED',
    message: 'The ChatGPT plan usage limit was reached. Check your usage in ChatGPT settings.',
    retryable: false,
  },
  {
    marker: 'subscription_sharing_user_not_eligible',
    reason: 'plan-not-eligible',
    code: 'AUTH_REQUIRED',
    message: 'This ChatGPT plan cannot be used by Nexar',
    retryable: false,
  },
  {
    marker: 'subscription_sharing_unsupported_capability',
    reason: 'unsupported-capability',
    code: 'PROVIDER_ERROR',
    message: 'The ChatGPT plan does not support this request',
    retryable: false,
  },
  {
    marker: 'subscription_sharing_usage_unavailable',
    reason: 'usage-unavailable',
    code: 'PROVIDER_ERROR',
    message: 'ChatGPT plan usage is temporarily unavailable',
    retryable: true,
  },
  {
    marker: 'subscription_sharing_route_not_supported',
    reason: 'route-not-supported',
    code: 'PROVIDER_ERROR',
    message: 'The ChatGPT plan cannot be used for this request',
    retryable: false,
  },
  {
    marker: 'chatpass_v2_scope_not_authorized',
    reason: 'route-not-supported',
    code: 'PROVIDER_ERROR',
    message: 'The ChatGPT plan cannot be used for this request',
    retryable: false,
  },
];

/** The ChatGPT plan failure named by the documented error code in `raw`, if any. */
export function chatGptPlanFailure(
  raw: string,
  details: Readonly<Record<string, unknown>> = {},
): NexarError | undefined {
  const found = PLAN_FAILURES.find((f) => raw.includes(f.marker));
  if (found === undefined) return undefined;
  return new NexarError(found.code, found.message, {
    retryable: found.retryable,
    details: { ...details, reason: found.reason },
  });
}

export function failureFor(
  message: PiAssistantMessageLike,
  secrets: readonly string[],
): NexarError {
  const raw = message.errorMessage ?? 'pi-ai reported an error without a message';
  const text = truncate(redactSecrets(raw, secrets));
  const details = { provider: message.provider, model: message.model };
  const plan = chatGptPlanFailure(raw, details);
  if (plan !== undefined) return plan;
  if (AUTH_PATTERN.test(raw)) return new NexarError('AUTH_REQUIRED', text, { details });
  if (QUOTA_PATTERN.test(raw)) return new NexarError('QUOTA_EXHAUSTED', text, { details });
  return new NexarError('PROVIDER_ERROR', text, { details });
}

/**
 * Maps a finished pi-ai assistant message to a Nexar result, or throws the matching
 * `NexarError` when pi-ai reported `error`/`aborted` through `stopReason`.
 */
export function toExecutionResult(
  message: PiAssistantMessageLike,
  options: ToExecutionResultOptions = {},
): ExecutionResult {
  const secrets = options.secrets ?? [];
  switch (message.stopReason) {
    case 'aborted':
      throw new NexarError('EXECUTION_CANCELLED', 'Execution was cancelled', {
        details: { provider: message.provider, model: message.model },
      });
    case 'error':
      throw failureFor(message, secrets);
    case 'length':
      options.onEvent?.({ type: 'status', message: 'output truncated' });
      break;
    default:
      // 'stop', and 'toolUse' (no tools are offered in v0.1, so keep the text produced so far).
      break;
  }
  const text = message.content
    .filter((block) => block.type === 'text')
    .map((block) => block.text ?? '')
    .join('');
  return {
    text,
    artifacts: [],
    usage: {
      inputTokens: measured(message.usage.input),
      outputTokens: measured(message.usage.output),
      cacheReadTokens: measured(message.usage.cacheRead),
      cacheWriteTokens: measured(message.usage.cacheWrite),
      costUsd:
        options.costMode === 'unavailable'
          ? unavailable('ChatGPT plan usage has no reported cash cost')
          : estimated(message.usage.cost.total, 'pi-ai catalog rates'),
    },
    resolved: {
      provider: message.provider,
      model: message.model,
      runtimeVersion: PI_AI_RUNTIME_VERSION,
    },
    retries: 0,
  };
}

/** Normalizes anything thrown while calling pi-ai; abort-caused failures become cancellations. */
export function toThrownNexarError(
  e: unknown,
  signal: AbortSignal,
  secrets: readonly string[] = [],
): NexarError {
  if (isNexarError(e)) return e;
  if (signal.aborted || (e instanceof Error && e.name === 'AbortError')) {
    return new NexarError('EXECUTION_CANCELLED', 'Execution was cancelled', { cause: e });
  }
  const mapped = toNexarError(e, 'PROVIDER_ERROR');
  const plan = chatGptPlanFailure(mapped.message);
  if (plan !== undefined) return plan;
  const text = truncate(redactSecrets(mapped.message, secrets));
  return new NexarError(mapped.code, text, { cause: e });
}
