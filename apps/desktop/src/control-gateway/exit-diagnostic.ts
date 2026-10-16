/*
 * The one line the control-gateway child writes to stderr before a non-zero exit, and the strict parser
 * the supervising parent reads it with. It carries a phase and a short code and nothing else: never an
 * error message, a stack, a path or the endpoint. It is diagnostics only and changes no behavior.
 */

export const GATEWAY_EXIT_PHASES = ['config', 'stdin', 'listen', 'uncaught'] as const;
export type GatewayExitPhase = (typeof GATEWAY_EXIT_PHASES)[number];

export interface GatewayExit {
  readonly phase: GatewayExitPhase;
  readonly code: string;
}

/** A Node/system error code such as `EADDRINUSE` or `ERR_STREAM_DESTROYED`. */
const ERROR_CODE = /^[A-Z0-9_]{1,40}$/;
/** What the parent accepts: an error code or a constructor name such as `TypeError`. */
const SAFE_CODE = /^[A-Za-z0-9_]{1,40}$/;

const PREFIX = '{"nexarGatewayExit"';

/**
 * The error's `code` when it is a short `[A-Z0-9_]` string, else its constructor name when that is a
 * plain identifier, else `unknown`. Never reads the message or stack, and never throws (it runs inside
 * an `uncaughtException` handler).
 */
export function gatewayExitCode(error: unknown): string {
  try {
    if (typeof error !== 'object' || error === null) return 'unknown';
    const code = (error as { readonly code?: unknown }).code;
    if (typeof code === 'string' && ERROR_CODE.test(code)) return code;
    const name = (error as { readonly constructor?: { readonly name?: unknown } }).constructor
      ?.name;
    return typeof name === 'string' && SAFE_CODE.test(name) ? name : 'unknown';
  } catch {
    return 'unknown';
  }
}

/** The stderr line (no trailing newline) for a non-zero exit in `phase`. */
export function formatGatewayExit(phase: GatewayExitPhase, error?: unknown): string {
  return JSON.stringify({ nexarGatewayExit: { phase, code: gatewayExitCode(error) } });
}

function parseLine(line: string): GatewayExit | undefined {
  if (!line.startsWith(PREFIX)) return undefined;
  let value: unknown;
  try {
    value = JSON.parse(line);
  } catch {
    return undefined;
  }
  const inner = onlyKeys(value, ['nexarGatewayExit']);
  const fields =
    inner === undefined ? undefined : onlyKeys(inner['nexarGatewayExit'], ['code', 'phase']);
  if (fields === undefined) return undefined;
  const { phase, code } = fields;
  if (typeof code !== 'string' || !SAFE_CODE.test(code)) return undefined;
  const known = GATEWAY_EXIT_PHASES.find((candidate) => candidate === phase);
  return known === undefined ? undefined : { phase: known, code };
}

/** `value` as a record when it is a plain object with exactly the given own keys. */
function onlyKeys(value: unknown, keys: readonly string[]): Record<string, unknown> | undefined {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return undefined;
  const own = Object.keys(value).sort();
  return own.length === keys.length && own.every((key, i) => key === keys[i])
    ? (value as Record<string, unknown>)
    : undefined;
}

/**
 * The last well-formed diagnostic line in `text` (a bounded stderr tail), or `undefined`. Anything else
 * in the text is ignored and is never returned.
 */
export function parseGatewayExit(text: string): GatewayExit | undefined {
  const lines = text.split('\n');
  for (let i = lines.length - 1; i >= 0; i -= 1) {
    const parsed = parseLine((lines[i] ?? '').trim());
    if (parsed !== undefined) return parsed;
  }
  return undefined;
}
