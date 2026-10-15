import { createServer } from 'node:http';
import { createServer as createNetServer } from 'node:net';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { AddressInfo } from 'node:net';
import { describe, expect, it, vi } from 'vitest';
import {
  WslCoworkBackend,
  coworkWslArguments,
  forwardCoworkBridge,
  forwardCoworkGateway,
} from './wsl-cowork.js';

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
