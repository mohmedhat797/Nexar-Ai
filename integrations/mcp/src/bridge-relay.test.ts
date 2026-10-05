import { createServer, type Server, type Socket } from 'node:net';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PassThrough } from 'node:stream';
import { Client, InMemoryTransport } from '@modelcontextprotocol/client';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { bridgeRelayEntry, createBridgeRelayServer, runBridgeRelay } from './bridge-relay.js';

const TOKEN = 'SENTINEL-relay-token-0123456789abcdef';

type Frame = Record<string, unknown>;

describe('bridge relay', () => {
  let dir: string;
  let endpoint: string;
  let server: Server;
  let frames: Frame[];
  let reply: (frame: Frame) => Frame | string | undefined;
  const sockets = new Set<Socket>();
  const relays: { close(): void }[] = [];

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'nexar-relay-'));
    endpoint =
      process.platform === 'win32'
        ? `\\\\.\\pipe\\nexar-relay-test-${String(Date.now())}-${String(Math.random()).slice(2)}`
        : join(dir, 'e.sock');
    frames = [];
    reply = (frame) => ({ id: frame['id'], ok: true, value: { echoed: frame['op'] } });
    server = createServer((socket) => {
      sockets.add(socket);
      let buffered = '';
      socket.on('data', (chunk: Buffer) => {
        buffered += chunk.toString('utf8');
        for (let i = buffered.indexOf('\n'); i !== -1; i = buffered.indexOf('\n')) {
          const frame = JSON.parse(buffered.slice(0, i)) as Frame;
          buffered = buffered.slice(i + 1);
          frames.push(frame);
          const out = reply(frame);
          if (out !== undefined)
            socket.write(`${typeof out === 'string' ? out : JSON.stringify(out)}\n`);
        }
      });
      socket.on('error', () => undefined);
    });
    await new Promise<void>((resolve) => server.listen(endpoint, resolve));
  });

  afterEach(async () => {
    for (const relay of relays.splice(0)) relay.close();
    for (const socket of sockets) socket.destroy();
    sockets.clear();
    await new Promise<void>((resolve) => server.close(() => resolve()));
    await rm(dir, { recursive: true, force: true });
  });

  async function connectClient(callTimeoutMs?: number): Promise<Client> {
    const relay = createBridgeRelayServer({
      endpoint,
      token: TOKEN,
      version: '0.0.0',
      ...(callTimeoutMs === undefined ? {} : { callTimeoutMs }),
    });
    relays.push(relay);
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    await relay.create().connect(serverTransport);
    const client = new Client({ name: 'test', version: '0.0.0' });
    await client.connect(clientTransport);
    return client;
  }

  function textOf(result: unknown): { text: Frame; isError: boolean | undefined } {
    const { content, isError } = result as {
      content: { type: string; text: string }[];
      isError?: boolean;
    };
    expect(content).toHaveLength(1);
    expect(content[0]?.type).toBe('text');
    return { text: JSON.parse(content[0]?.text ?? '') as Frame, isError };
  }

  it('lists exactly the two tools, with short descriptions', async () => {
    const client = await connectClient();
    const { tools } = await client.listTools();
    expect(tools.map((t) => t.name).sort()).toEqual([
      'nexar.intelligence_status',
      'nexar.intelligence_submit',
    ]);
    for (const tool of tools) expect((tool.description ?? '').length).toBeLessThanOrEqual(1024);
  });

  it('lists reviewOf in the submit schema and forwards it', async () => {
    const client = await connectClient();
    const { tools } = await client.listTools();
    const submitTool = tools.find((t) => t.name === 'nexar.intelligence_submit');
    expect(Object.keys(submitTool?.inputSchema.properties ?? {})).toContain('reviewOf');
    await client.callTool({
      name: 'nexar.intelligence_submit',
      arguments: { unitId: 'u2', reviewOf: 'u1', input: 'x', access: 'read-only' },
    });
    expect(frames[0]).toMatchObject({ op: 'submit', request: { unitId: 'u2', reviewOf: 'u1' } });
  });

  it('forwards submit and status as one request each and returns one JSON text block', async () => {
    const client = await connectClient();
    const submit = await client.callTool({
      name: 'nexar.intelligence_submit',
      arguments: { unitId: 'u1', input: 'hello', access: 'draft', capabilities: ['reasoning'] },
    });
    expect(textOf(submit)).toEqual({ text: { echoed: 'submit' }, isError: undefined });
    const status = await client.callTool({
      name: 'nexar.intelligence_status',
      arguments: { jobId: 'j1' },
    });
    expect(textOf(status).text).toEqual({ echoed: 'status' });

    expect(frames).toHaveLength(2);
    expect(frames[0]).toMatchObject({
      v: 1,
      token: TOKEN,
      op: 'submit',
      request: { unitId: 'u1', input: 'hello', access: 'draft', capabilities: ['reasoning'] },
    });
    expect(frames[1]).toMatchObject({ v: 1, op: 'status', jobId: 'j1' });
    expect(frames[0]?.['id']).not.toBe(frames[1]?.['id']);
  });

  it('maps host failures to isError text with only the code', async () => {
    reply = (frame) => ({ id: frame['id'], ok: false, code: 'POLICY_REJECTED' });
    const client = await connectClient();
    const result = await client.callTool({
      name: 'nexar.intelligence_submit',
      arguments: { unitId: 'u1', input: 'x', access: 'read-only' },
    });
    expect(textOf(result)).toEqual({ text: { error: 'POLICY_REJECTED' }, isError: true });
  });

  it('maps malformed, mismatched and unknown-code replies to INTERNAL_ERROR', async () => {
    const client = await connectClient();
    const call = (): Promise<unknown> =>
      client.callTool({ name: 'nexar.intelligence_status', arguments: { jobId: 'j' } });
    for (const bad of [
      'not json',
      JSON.stringify({ id: 'wrong', ok: true, value: {} }),
      JSON.stringify({ id: 'r1', ok: false, code: 'SECRET-LEAK-xyz' }),
    ]) {
      reply = () => bad;
      const { text, isError } = textOf(await call());
      expect(isError).toBe(true);
      expect(text).toEqual({ error: 'INTERNAL_ERROR' });
    }
  });

  it('rejects invalid arguments locally without contacting the endpoint', async () => {
    const client = await connectClient();
    const bad = [
      { name: 'nexar.intelligence_submit', arguments: { unitId: 'u1', input: 'x' } },
      {
        name: 'nexar.intelligence_submit',
        arguments: { unitId: 'u1', input: 'x', access: 'draft', projectId: 'other' },
      },
      { name: 'nexar.intelligence_status', arguments: {} },
    ];
    for (const call of bad) {
      expect(textOf(await client.callTool(call))).toEqual({
        text: { error: 'VALIDATION_ERROR' },
        isError: true,
      });
    }
    expect(frames).toHaveLength(0);
  });

  it('reports an unreachable endpoint and a silent one without hanging', async () => {
    const client = await connectClient(100);
    reply = () => undefined;
    expect(
      textOf(
        await client.callTool({ name: 'nexar.intelligence_status', arguments: { jobId: 'j' } }),
      ).text,
    ).toEqual({ error: 'EXECUTION_TIMEOUT' });

    await new Promise<void>((resolve) => {
      for (const socket of sockets) socket.destroy();
      server.close(() => resolve());
    });
    const result = await client.callTool({
      name: 'nexar.intelligence_status',
      arguments: { jobId: 'j' },
    });
    expect(textOf(result)).toEqual({ text: { error: 'INTEGRATION_UNAVAILABLE' }, isError: true });
    server = createServer();
  });

  it('never echoes the token in a result', async () => {
    reply = (frame) => ({ id: frame['id'], ok: false, code: 'AUTH_REQUIRED' });
    const client = await connectClient();
    const result = await client.callTool({
      name: 'nexar.intelligence_status',
      arguments: { jobId: 'j' },
    });
    expect(JSON.stringify(result)).not.toContain(TOKEN);
  });

  describe('runBridgeRelay', () => {
    it('exits non-zero with a fixed stderr line when the environment is incomplete', async () => {
      for (const env of [
        {},
        { NEXAR_BRIDGE_ENDPOINT: endpoint },
        { NEXAR_BRIDGE_TOKEN: TOKEN },
        { NEXAR_BRIDGE_ENDPOINT: '', NEXAR_BRIDGE_TOKEN: TOKEN },
      ]) {
        const lines: string[] = [];
        const output = new PassThrough();
        const written: Buffer[] = [];
        output.on('data', (c: Buffer) => written.push(c));
        const code = await runBridgeRelay({ env, output, stderr: (l) => lines.push(l) });
        expect(code).toBe(1);
        expect(lines).toEqual([
          'nexar-bridge-relay: NEXAR_BRIDGE_ENDPOINT and NEXAR_BRIDGE_TOKEN are required\n',
        ]);
        expect(Buffer.concat(written).length).toBe(0);
      }
    });

    it('serves MCP over the given streams; stdout carries frames only and never the token', async () => {
      const input = new PassThrough();
      const output = new PassThrough();
      const out: string[] = [];
      output.setEncoding('utf8');
      output.on('data', (c: string) => out.push(c));
      const errs: string[] = [];
      const done = runBridgeRelay({
        env: { NEXAR_BRIDGE_ENDPOINT: endpoint, NEXAR_BRIDGE_TOKEN: TOKEN },
        input,
        output,
        stderr: (l) => errs.push(l),
      });
      const send = (message: unknown): void => void input.write(`${JSON.stringify(message)}\n`);
      send({
        jsonrpc: '2.0',
        id: 1,
        method: 'initialize',
        params: {
          protocolVersion: '2025-06-18',
          capabilities: {},
          clientInfo: { name: 't', version: '0' },
        },
      });
      send({ jsonrpc: '2.0', method: 'notifications/initialized' });
      send({
        jsonrpc: '2.0',
        id: 2,
        method: 'tools/call',
        params: { name: 'nexar.intelligence_status', arguments: { jobId: 'j1' } },
      });
      for (let i = 0; i < 100 && !out.join('').includes('"id":2'); i++) {
        await new Promise((resolve) => setTimeout(resolve, 20));
      }
      input.end();
      expect(await done).toBe(0);

      const lines = out.join('').split('\n').filter(Boolean);
      expect(lines.length).toBeGreaterThanOrEqual(2);
      for (const line of lines) expect(JSON.parse(line)).toHaveProperty('jsonrpc', '2.0');
      expect(out.join('')).not.toContain(TOKEN);
      expect(errs.join('')).not.toContain(TOKEN);
      expect(frames[0]).toMatchObject({ token: TOKEN, op: 'status', jobId: 'j1' });
    });
  });

  it('exports the built entry path beside the module', () => {
    expect(bridgeRelayEntry).toMatch(/bridge-relay-main\.js$/);
  });
});
