import { NexarError, estimated, isNexarError, measured, toNexarError } from '@nexar/contracts';
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

function failureFor(message: PiAssistantMessageLike, secrets: readonly string[]): NexarError {
  const raw = message.errorMessage ?? 'pi-ai reported an error without a message';
  const text = truncate(redactSecrets(raw, secrets));
  const details = { provider: message.provider, model: message.model };
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
      costUsd: estimated(message.usage.cost.total, 'pi-ai catalog rates'),
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
  const text = truncate(redactSecrets(mapped.message, secrets));
  return new NexarError(mapped.code, text, { cause: e });
}
