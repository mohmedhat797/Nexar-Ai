import type { BridgeResult, NexarApi } from '../shared/api.js';

declare global {
  interface Window {
    /** Exposed by the preload script; the only door to the main process. */
    readonly nexar: NexarApi;
  }
}

export const nexar: NexarApi = window.nexar;

export class BridgeError extends Error {
  readonly code: string;
  constructor(code: string, message: string) {
    super(message);
    this.name = 'BridgeError';
    this.code = code;
  }
}

/** Unwraps a bridge result; a failure becomes a `BridgeError` with a safe message. */
export async function call<T>(request: Promise<BridgeResult<T>>): Promise<T> {
  const result = await request;
  if (result.ok) return result.value;
  throw new BridgeError(result.error.code, result.error.message);
}

export function errorText(error: unknown): string {
  if (error instanceof BridgeError) return `${error.message} (${error.code})`;
  return 'Something went wrong.';
}

let counter = 0;
/** A renderer-chosen request id matching `^[A-Za-z0-9-]{1,64}$`. */
export function newRequestId(): string {
  counter += 1;
  return `r-${Date.now().toString(36)}-${counter.toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
}
