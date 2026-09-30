/** A metric that states how trustworthy it is, since providers expose different telemetry. */
export type Measured<T> =
  | { readonly status: 'measured'; readonly value: T }
  | { readonly status: 'estimated'; readonly value: T; readonly basis: string }
  | { readonly status: 'unavailable'; readonly reason?: string };

/** Wraps a value reported directly by the provider/runtime. */
export function measured<T>(v: T): Measured<T> {
  return { status: 'measured', value: v };
}

/** Wraps a derived value, recording how it was estimated. */
export function estimated<T>(v: T, basis: string): Measured<T> {
  return { status: 'estimated', value: v, basis };
}

/** Represents a metric the provider does not expose. */
export function unavailable<T = never>(reason?: string): Measured<T> {
  return reason === undefined ? { status: 'unavailable' } : { status: 'unavailable', reason };
}

/** Extracts the value when present (measured or estimated), else undefined. */
export function valueOf<T>(m: Measured<T>): T | undefined {
  return m.status === 'unavailable' ? undefined : m.value;
}
