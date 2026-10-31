import { EventEmitter } from 'node:events';
import { createServer } from 'node:http';
import { createServer as createNetServer } from 'node:net';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PassThrough } from 'node:stream';
import type { ChildProcess, spawn as nodeSpawn } from 'node:child_process';
import type { AddressInfo } from 'node:net';
import { describe, expect, it, vi } from 'vitest';
import {
  COWORK_HELPER_CAPABILITIES,
  COWORK_HELPER_PROTOCOL,
  COWORK_HELPER_PROTOCOL_VERSION,
  COWORK_HELPER_RELEASE,
  COWORK_PROFILE,
  DSH_PINNED_VERSION,
  JsonRpcStdioClient,
} from '@nexar/integration-deepseek-harness';
import type { Logger } from '@nexar/contracts';
import {
  WslCoworkBackend,
  coworkWslArguments,
  forwardCoworkBridge,
  forwardCoworkGateway,
} from './wsl-cowork.js';

const validPlane = {
  getCodePlane: () =>
    Promise.resolve({
      valid: true as const,
      value: { distro: 'nexar-plane', command: '/usr/local/bin/nexar', projects: {} },
    }),
};

const validHello = {
  protocol: COWORK_HELPER_PROTOCOL,
  protocolVersion: COWORK_HELPER_PROTOCOL_VERSION,
  helperVersion: COWORK_HELPER_RELEASE,
  version: DSH_PINNED_VERSION,
  isolation: 'WSL2_BUBBLEWRAP',
  capabilities: [...COWORK_HELPER_CAPABILITIES],
};

const noopLogger: Logger = {
  debug: () => undefined,
  info: () => undefined,
  warn: () => undefined,
  error: () => undefined,
  child: () => noopLogger,
};

function fakeHelperSpawn(
  behavior:
    | { kind: 'hello'; reply: unknown; onRun?: (peer: JsonRpcStdioClient) => Promise<unknown> }
    | { kind: 'timeout' }
    | { kind: 'missing' },
): typeof nodeSpawn {
  return (() => {
    const stdin = new PassThrough();
    const stdout = new PassThrough();
    const stderr = new PassThrough();
    const child = Object.assign(new EventEmitter(), {
      stdin,
      stdout,
      stderr,
      pid: undefined,
      kill: () => {
        stdin.end();
        stdout.end();
        child.emit('close', 0, null);
        return true;
      },
    }) as unknown as ChildProcess;

    if (behavior.kind === 'missing') {
      queueMicrotask(() => {
        const err = Object.assign(new Error('spawn wsl.exe ENOENT'), { code: 'ENOENT' });
        child.emit('error', err);
        stdout.end();
        child.emit('close', 127, null);
      });
      return child;
    }

    if (behavior.kind === 'timeout') {
      return child;
    }

    const peer = new JsonRpcStdioClient({ input: stdin, output: stdout });
    peer.setRequestHandler((req) => {
      if (req.method === 'cowork/hello') return Promise.resolve({ result: behavior.reply });
      if (req.method === 'cowork/run' && behavior.onRun !== undefined) {
        return behavior.onRun(peer).then((result) => ({ result }));
      }
      return undefined;
    });
    return child;
  }) as unknown as typeof nodeSpawn;
}

describe('isolated Cowork host boundary', () => {
  it('launches only the owner-selected helper with fixed arguments', () => {
    expect(coworkWslArguments({ distro: 'nexar-plane', command: '/usr/local/bin/nexar' })).toEqual([
      '-d',
      'nexar-plane',
      '--exec',
      '/usr/local/bin/nexar',
      'cowork',
      'serve',
      '--stdio',
    ]);
    expect(() => coworkWslArguments({ distro: 'bad;echo', command: '/bin/sh' })).toThrow();
    expect(() => coworkWslArguments({ distro: 'nexar-plane', command: '/a/../bin/sh' })).toThrow();
  });
  it('fails closed for damaged owner configuration without spawning any process', async () => {
    const spawn = vi.fn();
    const backend = new WslCoworkBackend(
      { getCodePlane: () => Promise.resolve({ valid: false }) },
      spawn,
    );
    expect(await backend.probe()).toEqual({ state: 'startup-failed' });
    expect(spawn).not.toHaveBeenCalled();
  });
  it.skipIf(process.platform !== 'win32')(
    'verifies helper protocol, version, capabilities, malformed handshakes, timeouts and missing executables (SEC02-F02)',
    async () => {
      // 1. Matching helper
      const matching = new WslCoworkBackend(
        validPlane,
        fakeHelperSpawn({ kind: 'hello', reply: validHello }),
      );
      expect(await matching.probe()).toEqual({ state: 'ready', version: '0.2.1-rc.5' });

      // 2. Outdated helper (pre-SEC02B missing helperVersion, or mismatched helperVersion)
      const legacyHelper = new WslCoworkBackend(
        validPlane,
        fakeHelperSpawn({
          kind: 'hello',
          reply: {
            protocol: 'nexar-cowork@1',
            version: '0.2.1-rc.5',
            isolation: 'WSL2_BUBBLEWRAP',
          },
        }),
      );
      expect(await legacyHelper.probe()).toEqual({
        state: 'unsupported-version',
        version: '0.2.1-rc.5',
      });
      const outdatedHelper = new WslCoworkBackend(
        validPlane,
        fakeHelperSpawn({
          kind: 'hello',
          reply: { ...validHello, helperVersion: '0.1.0-old' },
        }),
      );
      expect(await outdatedHelper.probe()).toEqual({
        state: 'unsupported-version',
        version: '0.2.1-rc.5',
      });

      // 3. Unsupported protocol version / unexpected protocol identity
      const badProtocolVersion = new WslCoworkBackend(
        validPlane,
        fakeHelperSpawn({
          kind: 'hello',
          reply: { ...validHello, protocolVersion: 2 },
        }),
      );
      expect(await badProtocolVersion.probe()).toEqual({
        state: 'unsupported-version',
        version: '0.2.1-rc.5',
      });
      const badProtocolId = new WslCoworkBackend(
        validPlane,
        fakeHelperSpawn({
          kind: 'hello',
          reply: { ...validHello, protocol: 'other-protocol@1' },
        }),
      );
      expect(await badProtocolId.probe()).toEqual({
        state: 'unsupported-version',
        version: '0.2.1-rc.5',
      });

      // 4. Missing required capability
      const missingCap = new WslCoworkBackend(
        validPlane,
        fakeHelperSpawn({
          kind: 'hello',
          reply: { ...validHello, capabilities: ['stdio-rpc', 'gateway-socket'] },
        }),
      );
      expect(await missingCap.probe()).toEqual({
        state: 'unsupported-version',
        version: '0.2.1-rc.5',
      });

      // 5. Malformed handshake
      for (const badReply of [
        'not-an-object',
        { invalid: true },
        { ...validHello, extra: 'unexpected' },
        { ...validHello, isolation: 'HOST_LOCAL' },
      ]) {
        const malformed = new WslCoworkBackend(
          validPlane,
          fakeHelperSpawn({ kind: 'hello', reply: badReply }),
        );
        expect(await malformed.probe()).toEqual({ state: 'startup-failed' });
      }

      // 6. Helper timeout
      const timedOut = new WslCoworkBackend(validPlane, fakeHelperSpawn({ kind: 'timeout' }), 40);
      expect(await timedOut.probe()).toEqual({ state: 'startup-failed' });

      // 7. Missing helper executable
      const missingExec = new WslCoworkBackend(validPlane, fakeHelperSpawn({ kind: 'missing' }));
      expect(await missingExec.probe()).toEqual({ state: 'startup-failed' });
    },
  );
  it.skipIf(process.platform !== 'win32')(
    'supports concurrent gateway and permission callbacks up to per-channel limits and rejects nested /work paths (SEC02-F03, SEC02-F04)',
    async () => {
      const root = await mkdtemp(join(tmpdir(), 'sec02-concurrency-'));
      const server = createServer((req, res) => {
        req.resume();
        req.on('end', () => {
          setTimeout(() => {
            res.writeHead(200, { 'content-type': 'application/json' });
            res.end('{"ok":true}');
          }, 25);
        });
      });
      await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
      const baseURL = `http://127.0.0.1:${String((server.address() as AddressInfo).port)}/v1`;
      const body = Buffer.from('{"model":"nexar-control"}').toString('base64');
      try {
        const backend = new WslCoworkBackend(
          validPlane,
          fakeHelperSpawn({
            kind: 'hello',
            reply: validHello,
            onRun: async (peer) => {
              // 4 concurrent gateway requests + 1 concurrent permission request (5 total > old limit of 4)
              const [g1, g2, g3, g4, permFlat] = await Promise.all([
                peer.request('cowork/gateway', { body }),
                peer.request('cowork/gateway', { body }),
                peer.request('cowork/gateway', { body }),
                peer.request('cowork/gateway', { body }),
                peer.request('cowork/permission', {
                  tool: 'write',
                  kind: 'edit',
                  toolCallId: 'c1',
                  rawInput: { file_path: '/work/draft.md' },
                }),
              ]);
              expect([g1, g2, g3, g4].every((g) => (g as { status: number }).status === 200)).toBe(
                true,
              );
              expect(permFlat).toBe('allow');

              // Nested /work/sub/draft.md write is rejected at host permission boundary (SEC02-F04)
              const permNested = await peer.request('cowork/permission', {
                tool: 'write',
                kind: 'edit',
                toolCallId: 'c2',
                rawInput: { file_path: '/work/sub/draft.md' },
              });
              expect(permNested).toBe('reject');

              return { text: 'done', sessionId: 's1', stopReason: 'end_turn', files: [] };
            },
          }),
        );
        const result = await backend.run(
          {
            launch: { command: 'unused', args: [], env: {} },
            profile: COWORK_PROFILE,
            scratchBase: root,
            scratchDir: root,
            dshHome: root,
            permissionMode: 'read-only',
            control: { baseURL, token: 'synthetic-token-123456' },
            prompt: 'test',
            parentEnv: {},
            signal: new AbortController().signal,
            timeoutMs: 10_000,
            logger: noopLogger,
            decide: () => Promise.resolve('allow'),
          },
          { endpoint: 'unused', standalone: true, inputs: [] },
        );
        expect(result.text).toBe('done');
      } finally {
        server.closeAllConnections();
        await new Promise<void>((resolve) => server.close(() => resolve()));
        await rm(root, { recursive: true, force: true });
      }
    },
  );
  it('forwards only to the fixed authenticated gateway and rejects URL/header injection', async () => {
    const seen: { url?: string; authorization?: string; body?: string } = {};
    const server = createServer((req, res) => {
      let body = '';
      req.setEncoding('utf8');
      req.on('data', (s: string) => (body += s));
      req.on('end', () => {
        seen.url = req.url ?? '';
        seen.authorization = req.headers.authorization ?? '';
        seen.body = body;
        res.writeHead(200, { 'content-type': 'text/event-stream' });
        res.end('data: [DONE]\n\n');
      });
    });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    const base = `http://127.0.0.1:${String((server.address() as AddressInfo).port)}/v1`;
    const body = Buffer.from('{"model":"nexar-control"}').toString('base64');
    const signal = new AbortController().signal;
    try {
      expect(await forwardCoworkGateway(base, 'synthetic-grant', { body }, signal)).toMatchObject({
        status: 200,
        contentType: 'text/event-stream',
      });
      expect(seen).toEqual({
        url: '/v1/chat/completions',
        authorization: 'Bearer synthetic-grant',
        body: '{"model":"nexar-control"}',
      });
      await expect(
        forwardCoworkGateway(
          base,
          'synthetic-grant',
          { body, url: 'http://outside.invalid' },
          signal,
        ),
      ).rejects.toThrow();
      await expect(
        forwardCoworkGateway('http://outside.invalid/v1', 'synthetic-grant', { body }, signal),
      ).rejects.toThrow();
    } finally {
      server.closeAllConnections();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  });
  it('rejects cross-grant, control-op, document-reference and standalone review bridge frames before opening a socket', async () => {
    const signal = new AbortController().signal;
    const base = {
      v: 1,
      id: '1',
      token: 'synthetic-grant',
      op: 'submit',
      request: { unitId: 'one', input: 'synthetic', access: 'draft' },
    };
    for (const frame of [
      { ...base, token: 'other-grant' },
      { ...base, op: 'control' },
      { ...base, request: { ...base.request, documentRefs: ['file:///outside'] } },
      { ...base, request: { ...base.request, reviewOf: 'earlier' } },
    ])
      await expect(
        forwardCoworkBridge(
          'never-opened',
          'synthetic-grant',
          { frame: JSON.stringify(frame) + '\n' },
          true,
          signal,
        ),
      ).rejects.toThrow();
  });
  it.skipIf(process.platform === 'win32')(
    'preserves the existing bridge authentication protocol over a private socket',
    async () => {
      const root = await mkdtemp(join(tmpdir(), 'sec02-bridge-'));
      const path = join(root, 'bridge.sock');
      let received = '';
      const server = createNetServer((s) => {
        s.on('data', (b: Buffer) => {
          received += b.toString();
          s.end('{"id":"1","ok":true,"value":{"state":"running"}}\n');
        });
      });
      await new Promise<void>((resolve) => server.listen(path, resolve));
      try {
        const frame =
          JSON.stringify({ v: 1, id: '1', token: 'synthetic-grant', op: 'status', jobId: 'j' }) +
          '\n';
        expect(
          await forwardCoworkBridge(
            path,
            'synthetic-grant',
            { frame },
            false,
            new AbortController().signal,
          ),
        ).toContain('running');
        expect(received).toBe(frame);
      } finally {
        await new Promise<void>((resolve) => server.close(() => resolve()));
        await rm(root, { recursive: true, force: true });
      }
    },
  );
});
