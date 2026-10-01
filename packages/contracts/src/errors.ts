/** Stable, machine-readable failure categories shared by every package and adapter. */
export const NEXAR_ERROR_CODES = [
  'RESOURCE_UNAVAILABLE',
  'AUTH_REQUIRED',
  'NO_ELIGIBLE_RESOURCE',
  'PROVIDER_ERROR',
  'EXECUTION_TIMEOUT',
  'EXECUTION_CANCELLED',
  'QUOTA_EXHAUSTED',
  'POLICY_REJECTED',
  'APPROVAL_DENIED',
  'SANDBOX_UNAVAILABLE',
  'CONFIGURATION_ERROR',
  'ADAPTER_NOT_FOUND',
  'INTEGRATION_UNAVAILABLE',
  'VALIDATION_ERROR',
  'INTERNAL_ERROR',
] as const;

/** One of the known Nexar failure categories. */
export type NexarErrorCode = (typeof NEXAR_ERROR_CODES)[number];

const RETRYABLE_BY_DEFAULT: ReadonlySet<NexarErrorCode> = new Set<NexarErrorCode>([
  'RESOURCE_UNAVAILABLE',
  'PROVIDER_ERROR',
  'EXECUTION_TIMEOUT',
  'QUOTA_EXHAUSTED',
]);

/** Options for {@link NexarError}. */
export interface NexarErrorOptions {
  readonly retryable?: boolean;
  readonly details?: Readonly<Record<string, unknown>>;
  readonly cause?: unknown;
}

/**
 * The only error type that crosses package/adapter boundaries, so callers never
 * depend on upstream provider error shapes.
 */
export class NexarError extends Error {
  readonly code: NexarErrorCode;
  readonly retryable: boolean;
  readonly details?: Readonly<Record<string, unknown>>;

  constructor(code: NexarErrorCode, message: string, options: NexarErrorOptions = {}) {
    super(message, options.cause === undefined ? undefined : { cause: options.cause });
    this.name = 'NexarError';
    this.code = code;
    this.retryable = options.retryable ?? RETRYABLE_BY_DEFAULT.has(code);
    if (options.details !== undefined) {
      this.details = options.details;
    }
  }

  /** Serializable form for logs/telemetry; deliberately omits stack and cause. */
  toJSON(): {
    name: string;
    code: NexarErrorCode;
    message: string;
    retryable: boolean;
    details: Readonly<Record<string, unknown>> | undefined;
  } {
    return {
      name: this.name,
      code: this.code,
      message: this.message,
      retryable: this.retryable,
      details: this.details,
    };
  }
}

/** Type guard that also survives duplicate copies of this package (where `instanceof` fails). */
export function isNexarError(e: unknown): e is NexarError {
  if (e instanceof NexarError) {
    return true;
  }
  if (typeof e !== 'object' || e === null) {
    return false;
  }
  const candidate = e as { name?: unknown; code?: unknown };
  return (
    candidate.name === 'NexarError' &&
    typeof candidate.code === 'string' &&
    (NEXAR_ERROR_CODES as readonly string[]).includes(candidate.code)
  );
}

/** Normalizes any thrown value into a NexarError, keeping the original as `cause`. */
export function toNexarError(e: unknown, fallback: NexarErrorCode = 'INTERNAL_ERROR'): NexarError {
  if (isNexarError(e)) {
    return e;
  }
  const message = e instanceof Error ? e.message : typeof e === 'string' ? e : 'Unknown error';
  return new NexarError(fallback, message, { cause: e });
}
