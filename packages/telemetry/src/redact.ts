const SENSITIVE_KEY = /(api[-_]?key|token|secret|password|authorization|cookie|credential)/i;
/** Usage counters such as `inputTokens` or `maxTokens` are telemetry, not secrets. */
const TOKEN_COUNT_KEY = /(tokens|token[-_]?count|tokenizer)$/i;

function isSensitiveKey(key: string): boolean {
  return SENSITIVE_KEY.test(key) && !TOKEN_COUNT_KEY.test(key);
}

/** Replacement for any value stored under a sensitive key. */
export const REDACTED = '[REDACTED]';

function redactValue(value: unknown, ancestors: WeakSet<object>): unknown {
  if (typeof value !== 'object' || value === null) {
    return value;
  }
  if (ancestors.has(value)) {
    return '[Circular]';
  }
  ancestors.add(value);
  try {
    if (Array.isArray(value)) {
      return value.map((item) => redactValue(item, ancestors));
    }
    // Objects that define toJSON (e.g. NexarError) are walked via their serializable form.
    const source =
      typeof (value as { toJSON?: unknown }).toJSON === 'function'
        ? (value as { toJSON(): unknown }).toJSON()
        : value;
    if (typeof source !== 'object' || source === null) {
      return source;
    }
    const out: Record<string, unknown> = {};
    for (const [key, child] of Object.entries(source)) {
      out[key] = isSensitiveKey(key) ? REDACTED : redactValue(child, ancestors);
    }
    return out;
  } finally {
    // Only ancestors count as cycles; shared (non-circular) references are fine.
    ancestors.delete(value);
  }
}

/** Returns a deep copy of `fields` with values under sensitive keys masked; never mutates input. */
export function redact(fields: Readonly<Record<string, unknown>>): Record<string, unknown> {
  const result = redactValue(fields, new WeakSet());
  return typeof result === 'object' && result !== null && !Array.isArray(result)
    ? (result as Record<string, unknown>)
    : {};
}
