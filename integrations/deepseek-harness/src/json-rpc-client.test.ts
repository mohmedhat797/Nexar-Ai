import { PassThrough } from 'node:stream';
import { describe, expect, it, vi } from 'vitest';
import type { NexarError } from '@nexar/contracts';
import { JsonRpcStdioClient } from './json-rpc-client.js';

function setup() {
  const input = new PassThrough();
  const output = new PassThrough();
  const sent: Record<string, unknown>[] = [];
  let outBuf = '';
  output.setEncoding('utf8');
  output.on('data', (c: string) => {
    outBuf += c;
    let i = outBuf.indexOf('\n');
    while (i !== -1) {
      sent.push(JSON.parse(outBuf.slice(0, i)) as Record<string, unknown>);
      outBuf = outBuf.slice(i + 1);
      i = outBuf.indexOf('\n');
    }
  });
  const errors: NexarError[] = [];
  const client = new JsonRpcStdioClient({
    input,
    output,
    onProtocolError: (e) => errors.push(e),
  });
  const tick = () => new Promise((r) => setImmediate(r));
  return { client, input, output, sent, errors, tick };
}

describe('JsonRpcStdioClient', () => {
  it('writes requests as single JSON lines and resolves the matching result', async () => {
    const { client, input, sent, tick } = setup();
    const p = client.request('initialize', { a: 1 });
    await tick();
    expect(sent).toEqual([{ jsonrpc: '2.0', id: 1, method: 'initialize', params: { a: 1 } }]);
    input.write('{"jsonrpc":"2.0","id":1,"result":{"ok":true}}\n');
    await expect(p).resolves.toEqual({ ok: true });
  });

  it('omits params when none are given', async () => {
    const { client, sent, tick } = setup();
    void client.request('shutdown').catch(() => undefined);
    await tick();
    expect(sent[0]).toEqual({ jsonrpc: '2.0', id: 1, method: 'shutdown' });
  });

  it('reassembles lines split across chunks, including multi-byte characters', async () => {
    const { client, input } = setup();
    const p = client.request('x');
    const bytes = Buffer.from('{"jsonrpc":"2.0","id":1,"result":"héllo ✓"}\n');
    const cut = bytes.indexOf(0xc3) + 1; // split inside the two-byte 'é'
    input.write(bytes.subarray(0, cut));
    input.write(bytes.subarray(cut, cut + 14));
    input.write(bytes.subarray(cut + 14));
    await expect(p).resolves.toBe('héllo ✓');
  });

  it('handles several messages in one chunk and ignores blank lines', async () => {
    const { client, input } = setup();
    const a = client.request('a');
    const b = client.request('b');
    input.write(
      '\n\n{"jsonrpc":"2.0","id":2,"result":"B"}\n   \n{"jsonrpc":"2.0","id":1,"result":"A"}\n',
    );
    await expect(Promise.all([a, b])).resolves.toEqual(['A', 'B']);
  });

  it('keeps concurrent requests independent', async () => {
    const { client, input, sent, tick } = setup();
    const a = client.request('a');
    const b = client.request('b');
    await tick();
    expect(sent.map((m) => m.id)).toEqual([1, 2]);
    input.write('{"jsonrpc":"2.0","id":2,"error":{"code":-1,"message":"nope"}}\n');
    input.write('{"jsonrpc":"2.0","id":1,"result":1}\n');
    await expect(a).resolves.toBe(1);
    await expect(b).rejects.toMatchObject({ code: 'PROVIDER_ERROR' });
  });

  it('maps JSON-RPC errors to PROVIDER_ERROR with the rpc code', async () => {
    const { client, input } = setup();
    const p = client.request('x');
    input.write('{"jsonrpc":"2.0","id":1,"error":{"code":-32602,"message":"bad params"}}\n');
    await expect(p).rejects.toMatchObject({
      code: 'PROVIDER_ERROR',
      details: { rpcCode: -32602 },
      message: expect.stringContaining('bad params') as unknown,
    });
  });

  it('dispatches notifications to handlers and supports unsubscribe', async () => {
    const { client, input, tick } = setup();
    const seen: unknown[] = [];
    const off = client.onNotification((n) => seen.push(n));
    input.write('{"jsonrpc":"2.0","method":"session.status","params":{"status":"idle"}}\n');
    await tick();
    off();
    input.write('{"jsonrpc":"2.0","method":"session.status","params":{"status":"running"}}\n');
    await tick();
    expect(seen).toEqual([{ method: 'session.status', params: { status: 'idle' } }]);
  });

  it('surfaces a malformed line via onProtocolError, rejects pending, and never echoes the line', async () => {
    const { client, input, errors } = setup();
    const p = client.request('x');
    input.write('SECRET garbage\n');
    await expect(p).rejects.toMatchObject({ code: 'PROVIDER_ERROR' });
    expect(errors).toHaveLength(1);
    expect(errors[0]?.message).not.toContain('SECRET');
  });

  it('treats a response with an unknown id as a protocol error and fails pending requests', async () => {
    const { client, input, errors } = setup();
    const p = client.request('x');
    input.write('{"jsonrpc":"2.0","id":99,"result":1}\n');
    await expect(p).rejects.toMatchObject({ code: 'PROVIDER_ERROR' });
    expect(errors).toHaveLength(1);
  });

  it('answers server-to-client requests with method-not-found', async () => {
    const { client, input, sent, tick } = setup();
    void client;
    input.write('{"jsonrpc":"2.0","id":"s1","method":"fs/read"}\n');
    await tick();
    expect(sent[0]).toMatchObject({ id: 's1', error: { code: -32601 } });
  });

  it('contains handler exceptions as protocol errors', async () => {
    const { client, input, errors, tick } = setup();
    client.onNotification(() => {
      throw new Error('boom');
    });
    input.write('{"jsonrpc":"2.0","method":"n"}\n');
    await tick();
    expect(errors).toHaveLength(1);
  });

  it('rejects all pending requests and fires onClose when the input ends', async () => {
    const { client, input } = setup();
    const onClose = vi.fn();
    client.onClose(onClose);
    const a = client.request('a');
    const b = client.request('b');
    input.end();
    await expect(a).rejects.toMatchObject({
      code: 'PROVIDER_ERROR',
      details: { reason: 'closed' },
    });
    await expect(b).rejects.toMatchObject({ code: 'PROVIDER_ERROR' });
    expect(onClose).toHaveBeenCalledTimes(1);
    expect(client.closed).toBe(true);
    await expect(client.request('c')).rejects.toMatchObject({ code: 'PROVIDER_ERROR' });
  });

  it('times out a request', async () => {
    const { client } = setup();
    await expect(client.request('slow', undefined, { timeoutMs: 20 })).rejects.toMatchObject({
      code: 'EXECUTION_TIMEOUT',
    });
  });

  it('cancels a request via AbortSignal, including one already aborted', async () => {
    const { client } = setup();
    const ac = new AbortController();
    const p = client.request('slow', undefined, { signal: ac.signal });
    ac.abort();
    await expect(p).rejects.toMatchObject({ code: 'EXECUTION_CANCELLED' });
    await expect(client.request('again', undefined, { signal: ac.signal })).rejects.toMatchObject({
      code: 'EXECUTION_CANCELLED',
    });
  });

  it('close() rejects pending requests and ends the output', async () => {
    const { client, output } = setup();
    const p = client.request('x');
    client.close();
    await expect(p).rejects.toMatchObject({ code: 'PROVIDER_ERROR' });
    expect(output.writableEnded).toBe(true);
  });

  it('rejects oversized lines', async () => {
    const input = new PassThrough();
    const output = new PassThrough();
    const client = new JsonRpcStdioClient({ input, output, maxLineChars: 16 });
    const p = client.request('x');
    input.write('x'.repeat(64));
    await expect(p).rejects.toMatchObject({ code: 'PROVIDER_ERROR' });
    expect(client.closed).toBe(true);
  });
});
