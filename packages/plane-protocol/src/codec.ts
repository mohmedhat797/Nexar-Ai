import { NexarError } from '@nexar/contracts';
import { z } from 'zod';
import { MAX_FRAME_BYTES } from './limits.js';
import {
  DESKTOP_FRAME_TYPES,
  PLANE_FRAME_TYPES,
  desktopFrameSchema,
  planeFrameSchema,
  type DesktopFrame,
  type PlaneFrame,
} from './schemas.js';

/** Why a line was not accepted. Never carries the offending content. */
export type DecodeFailure = 'oversize' | 'malformed' | 'forbidden-key' | 'unknown-type' | 'schema';

export type DecodeResult<T> =
  | { readonly ok: true; readonly frame: T }
  | { readonly ok: false; readonly failure: DecodeFailure };

const NEWLINE = 0x0a;
const CARRIAGE_RETURN = 0x0d;
const FORBIDDEN_KEYS: ReadonlySet<string> = new Set(['__proto__', 'constructor', 'prototype']);
const MAX_JSON_DEPTH = 32;

/** True when any object key at any depth is a prototype-pollution key (or nesting is absurd). */
function hasForbiddenKey(root: unknown): 'none' | 'forbidden' | 'too-deep' {
  const stack: { value: unknown; depth: number }[] = [{ value: root, depth: 0 }];
  for (let item = stack.pop(); item !== undefined; item = stack.pop()) {
    const { value, depth } = item;
    if (typeof value !== 'object' || value === null) continue;
    if (depth > MAX_JSON_DEPTH) return 'too-deep';
    if (Array.isArray(value)) {
      for (const element of value) stack.push({ value: element, depth: depth + 1 });
      continue;
    }
    for (const key of Object.keys(value)) {
      if (FORBIDDEN_KEYS.has(key)) return 'forbidden';
      stack.push({ value: (value as Record<string, unknown>)[key], depth: depth + 1 });
    }
  }
  return 'none';
}

export interface FrameDecoderOptions<T> {
  readonly schema: z.ZodType<T>;
  /** The frame types this receiver knows; any other `type` string is `unknown-type`. */
  readonly types: readonly string[];
}

/**
 * Incremental newline-delimited UTF-8 JSON decoder (ADR-025 section 1). A line over
 * `MAX_FRAME_BYTES` is reported once and discarded up to the next newline; each rejected line is a
 * typed failure that never echoes the content. CRLF is tolerated and blank lines are ignored.
 */
export class FrameDecoder<T> {
  private pending: Buffer[] = [];
  private pendingBytes = 0;
  private discarding = false;

  constructor(private readonly options: FrameDecoderOptions<T>) {}

  push(chunk: string | Uint8Array): DecodeResult<T>[] {
    const buffer =
      typeof chunk === 'string'
        ? Buffer.from(chunk, 'utf8')
        : Buffer.from(chunk.buffer, chunk.byteOffset, chunk.byteLength);
    const results: DecodeResult<T>[] = [];
    let start = 0;
    for (;;) {
      const newline = buffer.indexOf(NEWLINE, start);
      const end = newline === -1 ? buffer.length : newline;
      const segment = buffer.subarray(start, end);
      if (this.discarding) {
        if (newline !== -1) this.discarding = false;
      } else if (this.pendingBytes + segment.length > MAX_FRAME_BYTES) {
        results.push({ ok: false, failure: 'oversize' });
        this.reset();
        this.discarding = newline === -1;
      } else if (newline === -1) {
        this.pending.push(Buffer.from(segment));
        this.pendingBytes += segment.length;
      } else {
        const line = this.pendingBytes === 0 ? segment : Buffer.concat([...this.pending, segment]);
        this.reset();
        const result = this.decodeLine(line);
        if (result !== undefined) results.push(result);
      }
      if (newline === -1) return results;
      start = newline + 1;
    }
  }

  /** Call at end of input: an unterminated trailing line is reported as malformed. */
  end(): DecodeResult<T>[] {
    const incomplete = this.pendingBytes > 0;
    this.reset();
    this.discarding = false;
    return incomplete ? [{ ok: false, failure: 'malformed' }] : [];
  }

  private reset(): void {
    this.pending = [];
    this.pendingBytes = 0;
  }

  private decodeLine(raw: Buffer): DecodeResult<T> | undefined {
    const line =
      raw.length > 0 && raw[raw.length - 1] === CARRIAGE_RETURN ? raw.subarray(0, -1) : raw;
    if (line.length === 0) return undefined;
    let value: unknown;
    try {
      value = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(line));
    } catch {
      return { ok: false, failure: 'malformed' };
    }
    const scan = hasForbiddenKey(value);
    if (scan === 'too-deep') return { ok: false, failure: 'malformed' };
    if (scan === 'forbidden') return { ok: false, failure: 'forbidden-key' };
    if (typeof value === 'object' && value !== null && !Array.isArray(value)) {
      const type = (value as Record<string, unknown>)['type'];
      if (typeof type === 'string' && !this.options.types.includes(type)) {
        return { ok: false, failure: 'unknown-type' };
      }
    }
    const parsed = this.options.schema.safeParse(value);
    return parsed.success ? { ok: true, frame: parsed.data } : { ok: false, failure: 'schema' };
  }
}

/** Decodes what Desktop sends (read by the plane). */
export function createDesktopFrameDecoder(): FrameDecoder<DesktopFrame> {
  return new FrameDecoder({ schema: desktopFrameSchema, types: DESKTOP_FRAME_TYPES });
}

/** Decodes what the plane sends (read by Desktop). */
export function createPlaneFrameDecoder(): FrameDecoder<PlaneFrame> {
  return new FrameDecoder({ schema: planeFrameSchema, types: PLANE_FRAME_TYPES });
}

const anyFrameSchema = z.union([desktopFrameSchema, planeFrameSchema]);

/**
 * Validates, then serializes one frame plus its newline. Throws `VALIDATION_ERROR` (never echoing
 * the frame) for an invalid frame, and the same code with `details.reason: 'frame-too-large'` for
 * a frame over `MAX_FRAME_BYTES`.
 */
export function encodeFrame(frame: DesktopFrame | PlaneFrame): string {
  if (!anyFrameSchema.safeParse(frame).success) {
    throw new NexarError('VALIDATION_ERROR', 'Invalid plane protocol frame');
  }
  const line = JSON.stringify(frame);
  if (Buffer.byteLength(line, 'utf8') > MAX_FRAME_BYTES) {
    throw new NexarError('VALIDATION_ERROR', 'Plane protocol frame is too large', {
      details: { reason: 'frame-too-large' },
    });
  }
  return `${line}\n`;
}
