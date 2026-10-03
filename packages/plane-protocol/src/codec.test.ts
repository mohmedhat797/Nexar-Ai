import { describe, expect, it } from 'vitest';
import {
  MAX_FRAME_BYTES,
  PLANE_PROTOCOL,
  createDesktopFrameDecoder,
  createPlaneFrameDecoder,
  encodeFrame,
  type DecodeResult,
  type DesktopFrame,
  type PlaneFrame,
} from './index.js';

const RUN = `run_${'a'.repeat(32)}`;
const init: DesktopFrame = { type: 'initialize', protocol: PLANE_PROTOCOL };
const cancel: DesktopFrame = { type: 'cancel', runId: RUN };
const line = (value: unknown): string => `${JSON.stringify(value)}\n`;
const frames = (results: DecodeResult<DesktopFrame>[]): DesktopFrame[] =>
  results.flatMap((r) => (r.ok ? [r.frame] : []));
const failures = (results: DecodeResult<DesktopFrame>[]): string[] =>
  results.flatMap((r) => (r.ok ? [] : [r.failure]));

describe('FrameDecoder', () => {
  it('decodes one frame per line, several per chunk', () => {
    const decoder = createDesktopFrameDecoder();
    expect(frames(decoder.push(line(init) + line(cancel)))).toEqual([init, cancel]);
  });

  it('decodes a frame split mid-line across chunks, including inside a multi-byte character', () => {
    const decoder = createDesktopFrameDecoder();
    const bytes = Buffer.from(line({ type: 'initialize', protocol: 'nexar-é/1' }));
    const split = bytes.indexOf(0xc3) + 1;
    expect(decoder.push(bytes.subarray(0, split))).toEqual([]);
    expect(frames(decoder.push(bytes.subarray(split)))).toEqual([
      { type: 'initialize', protocol: 'nexar-é/1' },
    ]);
  });

  it('decodes byte by byte', () => {
    const decoder = createDesktopFrameDecoder();
    const out: DesktopFrame[] = [];
    for (const byte of Buffer.from(line(init) + line(cancel))) {
      out.push(...frames(decoder.push(Uint8Array.of(byte))));
    }
    expect(out).toEqual([init, cancel]);
  });

  it('tolerates CRLF and ignores blank lines', () => {
    const decoder = createDesktopFrameDecoder();
    const text = `\n${JSON.stringify(init)}\r\n\r\n${JSON.stringify(cancel)}\r\n`;
    expect(frames(decoder.push(text))).toEqual([init, cancel]);
  });

  it('waits for the newline before emitting', () => {
    const decoder = createDesktopFrameDecoder();
    expect(decoder.push(JSON.stringify(init))).toEqual([]);
    expect(frames(decoder.push('\n'))).toEqual([init]);
  });

  it('reports invalid JSON and invalid UTF-8 as malformed, without content', () => {
    const decoder = createDesktopFrameDecoder();
    const results = decoder.push('{"type": nope\n');
    expect(results).toEqual([{ ok: false, failure: 'malformed' }]);
    expect(JSON.stringify(results)).not.toContain('nope');
    expect(failures(decoder.push(Buffer.from([0x7b, 0xff, 0xfe, 0x7d, 0x0a])))).toEqual([
      'malformed',
    ]);
    expect(failures(decoder.push('[1,2\n'))).toEqual(['malformed']);
  });

  it('continues after a rejected line', () => {
    const decoder = createDesktopFrameDecoder();
    const results = decoder.push(`oops\n${line(init)}`);
    expect(failures(results)).toEqual(['malformed']);
    expect(frames(results)).toEqual([init]);
  });

  it.each(['__proto__', 'constructor', 'prototype'])('rejects a %s key at any depth', (key) => {
    const decoder = createDesktopFrameDecoder();
    expect(failures(decoder.push(`{"type":"initialize","protocol":"x","${key}":1}\n`))).toEqual([
      'forbidden-key',
    ]);
    expect(failures(decoder.push(`{"type":"run","lineage":{"a":[{"${key}":{}}]}}\n`))).toEqual([
      'forbidden-key',
    ]);
  });

  it('rejects absurdly deep nesting as malformed', () => {
    const decoder = createDesktopFrameDecoder();
    expect(failures(decoder.push(`${'['.repeat(200)}${']'.repeat(200)}\n`))).toEqual(['malformed']);
  });

  it('separates schema violations from unknown frame types', () => {
    const decoder = createDesktopFrameDecoder();
    expect(
      failures(decoder.push(line({ type: 'initialize', protocol: PLANE_PROTOCOL, x: 1 }))),
    ).toEqual(['schema']);
    expect(failures(decoder.push(line({ type: 'exec', command: 'ls' })))).toEqual(['unknown-type']);
    expect(failures(decoder.push(line({ protocol: 'x' })))).toEqual(['schema']);
    expect(failures(decoder.push(line([1, 2])))).toEqual(['schema']);
    expect(failures(decoder.push('"text"\n'))).toEqual(['schema']);
    // A plane-only type is unknown to the plane's decoder.
    expect(failures(decoder.push(line({ type: 'ready' })))).toEqual(['unknown-type']);
  });

  it('decodes each direction with its own decoder', () => {
    const plane = createPlaneFrameDecoder();
    const ready: PlaneFrame = {
      type: 'ready',
      protocol: PLANE_PROTOCOL,
      planeVersion: '0.1.0',
      readiness: {
        sandbox: 'ok',
        selftest: 'pass',
        automount: 'disabled',
        interop: 'disabled',
        kernel: 'k',
        plans: [],
        projects: [],
      },
    };
    expect(plane.push(line(ready))).toEqual([{ ok: true, frame: ready }]);
    expect(failures(plane.push(line(init)) as never)).toEqual(['unknown-type']);
  });

  describe('oversize lines', () => {
    const filler = (bytes: number): string => 'x'.repeat(bytes);

    it('accepts a line of exactly the cap and rejects one byte more', () => {
      const decoder = createDesktopFrameDecoder();
      const base = JSON.stringify({ type: 'initialize', protocol: '' });
      const exact = `${base.slice(0, -2)}${filler(MAX_FRAME_BYTES - base.length)}"}`;
      expect(Buffer.byteLength(exact)).toBe(MAX_FRAME_BYTES);
      // The protocol field is capped at 64 characters, so this is a schema failure, not oversize.
      expect(failures(decoder.push(`${exact}\n`))).toEqual(['schema']);
      expect(failures(decoder.push(`${exact}x\n`))).toEqual(['oversize']);
    });

    it('reports an oversize line once, discards through the next newline, then recovers', () => {
      const decoder = createDesktopFrameDecoder();
      const results = [
        ...decoder.push(filler(MAX_FRAME_BYTES)),
        ...decoder.push(filler(10)),
        ...decoder.push(filler(MAX_FRAME_BYTES)),
        ...decoder.push(`${filler(5)}\n${line(init)}`),
      ];
      expect(failures(results)).toEqual(['oversize']);
      expect(frames(results)).toEqual([init]);
    });

    it('recovers when the oversize line ends in the same chunk', () => {
      const decoder = createDesktopFrameDecoder();
      const results = decoder.push(`${filler(MAX_FRAME_BYTES + 1)}\n${line(cancel)}`);
      expect(failures(results)).toEqual(['oversize']);
      expect(frames(results)).toEqual([cancel]);
    });

    it('does not buffer a discarded line', () => {
      const decoder = createDesktopFrameDecoder();
      decoder.push(filler(MAX_FRAME_BYTES + 1));
      for (let i = 0; i < 20; i += 1) expect(decoder.push(filler(MAX_FRAME_BYTES))).toEqual([]);
      expect(frames(decoder.push(`\n${line(init)}`))).toEqual([init]);
    });
  });

  it('reports an unterminated trailing line at the end of input', () => {
    const decoder = createDesktopFrameDecoder();
    decoder.push(JSON.stringify(init));
    expect(decoder.end()).toEqual([{ ok: false, failure: 'malformed' }]);
    expect(decoder.end()).toEqual([]);
  });
});

describe('encodeFrame', () => {
  it('serializes one frame as a single newline-terminated line that decodes back', () => {
    const text = encodeFrame(init);
    expect(text.endsWith('\n')).toBe(true);
    expect(text.indexOf('\n')).toBe(text.length - 1);
    expect(frames(createDesktopFrameDecoder().push(text))).toEqual([init]);
  });

  it('keeps newlines inside strings on one line', () => {
    const text = encodeFrame({
      type: 'diff',
      taskId: 'eng-0123456789ab',
      text: 'a\nb\r\nc',
      truncated: false,
      files: [],
    });
    expect(text.split('\n')).toHaveLength(2);
  });

  it('refuses an invalid frame without echoing it', () => {
    const bad = { type: 'run', secret: 'SECRET-VALUE' } as unknown as DesktopFrame;
    let message = '';
    try {
      encodeFrame(bad);
    } catch (error) {
      message = (error as Error).message;
    }
    expect(message).not.toBe('');
    expect(message).not.toContain('SECRET-VALUE');
  });

  it('refuses a frame over the cap with a typed reason', () => {
    // 200 000 control characters escape to 6 bytes each, far over 1 MiB.
    const big: PlaneFrame = {
      type: 'diff',
      taskId: 'eng-0123456789ab',
      text: '\u0001'.repeat(200_000),
      truncated: false,
      files: [],
    };
    expect(() => encodeFrame(big)).toThrow(
      expect.objectContaining({ details: { reason: 'frame-too-large' } }) as Error,
    );
  });
});
