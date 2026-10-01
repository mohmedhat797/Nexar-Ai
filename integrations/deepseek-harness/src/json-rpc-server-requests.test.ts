import { PassThrough } from 'node:stream';
import { describe, expect, it } from 'vitest';
import { JsonRpcStdioClient } from './json-rpc-client.js';

function setup() {
  const input = new PassThrough();
  const output = new PassThrough();
  const sent: Record<string, unknown>[] = [];
  let buffer = '';
  output.setEncoding('utf8');
  output.on('data', (chunk: string) => {
    buffer += chunk;
    let i = buffer.indexOf('\n');
    while (i !== -1) {
      sent.push(JSON.parse(buffer.slice(0, i)) as Record<string, unknown>);
      buffer = buffer.slice(i + 1);
      i = buffer.indexOf('\n');
    }
  });
  const client = new JsonRpcStdioClient({ input, output });
  const tick = () => new Promise((r) => setImmediate(r));
  return { client, input, sent, tick };
}

describe('JsonRpcStdioClient server requests and notifications', () => {
  it('answers server requests through the installed handler', async () => {
    const { client, input, sent, tick } = setup();
    client.setRequestHandler((req) =>
      req.method === 'session/request_permission'
        ? Promise.resolve({ result: { echoed: req.params } })
        : undefined,
    );
    input.write(
      '{"jsonrpc":"2.0","id":7,"method":"session/request_permission","params":{"a":1}}\n',
    );
    input.write('{"jsonrpc":"2.0","id":8,"method":"fs/read_text_file","params":{}}\n');
    await tick();
    await tick();
    expect(sent).toContainEqual({ jsonrpc: '2.0', id: 7, result: { echoed: { a: 1 } } });
    expect(sent).toContainEqual({
      jsonrpc: '2.0',
      id: 8,
      error: { code: -32601, message: 'Method not found: fs/read_text_file' },
    });
  });

  it('answers -32601 with no handler and fails closed when the handler throws', async () => {
    const { client, input, sent, tick } = setup();
    input.write('{"jsonrpc":"2.0","id":1,"method":"x"}\n');
    await tick();
    expect(sent[0]).toMatchObject({ id: 1, error: { code: -32601 } });
    client.setRequestHandler(() => Promise.reject(new Error('boom')));
    input.write('{"jsonrpc":"2.0","id":2,"method":"y"}\n');
    await tick();
    await tick();
    expect(sent[1]).toMatchObject({ id: 2, error: { code: -32603 } });
    expect(sent[1]).not.toHaveProperty('result');
  });

  it('sends notifications without an id', async () => {
    const { client, sent, tick } = setup();
    await client.notify('session/cancel', { sessionId: 's' });
    await tick();
    expect(sent).toEqual([
      { jsonrpc: '2.0', method: 'session/cancel', params: { sessionId: 's' } },
    ]);
  });
});
