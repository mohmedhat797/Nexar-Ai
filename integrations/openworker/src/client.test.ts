import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { OpenWorkerHttpClient } from './client.js';
import { FakeOpenWorkerServer } from './test/fake-server.js';

const TOKEN = 'client-test-token';
const SECRET = 'sentinel-bridge-token-8841';
const LAUNCH = {
  command: '/abs/node',
  args: ['/abs/relay.cjs'],
  env: { ELECTRON_RUN_AS_NODE: '1', NEXAR_BRIDGE_TOKEN: SECRET },
};

let server: FakeOpenWorkerServer;
let client: OpenWorkerHttpClient;
let port: number;

beforeEach(async () => {
  server = new FakeOpenWorkerServer({ token: TOKEN });
  port = await server.listen();
  client = new OpenWorkerHttpClient({ port, token: TOKEN });
});
afterEach(() => server.close());

describe('OpenWorkerHttpClient MCP registration', () => {
  it('registers a stdio server with approval required, then deletes it', async () => {
    await client.registerMcpServer('nexar', LAUNCH);
    expect(server.mcpServers.get('nexar')).toEqual({
      command: '/abs/node',
      args: ['/abs/relay.cjs'],
      env: LAUNCH.env,
      requires_approval: true,
    });
    await client.deleteMcpServer('nexar');
    expect(server.mcpServers.size).toBe(0);
    expect(server.requests).toEqual([
      { method: 'POST', path: '/v1/mcp', status: 200 },
      { method: 'DELETE', path: '/v1/mcp/nexar', status: 200 },
    ]);
  });

  it('maps failures to a fixed code that never carries the token', async () => {
    const wrong = new OpenWorkerHttpClient({ port, token: 'x' });
    const failures: unknown[] = [];
    // An absent entry is HTTP 200 { ok: false }; a wrong token is a 401.
    await client.deleteMcpServer('missing').catch((error: unknown) => failures.push(error));
    await wrong.registerMcpServer('nexar', LAUNCH).catch((error: unknown) => failures.push(error));
    expect(failures).toHaveLength(2);
    for (const failure of failures) {
      expect(failure).toMatchObject({
        code: 'INTEGRATION_UNAVAILABLE',
        message: 'OpenWorker request failed',
      });
      expect(JSON.stringify(failure)).not.toContain(SECRET);
    }
  });

  it('encodes the server name in the DELETE path', async () => {
    await client.deleteMcpServer('a/b').catch(() => undefined);
    expect(server.requests.at(-1)?.path).toBe('/v1/mcp/a%2Fb');
  });

  it('public health succeeds while protected roots reject a wrong token', async () => {
    const wrong = new OpenWorkerHttpClient({ port, token: 'wrong' });
    expect(await wrong.health()).toBe(true);
    await expect(wrong.attachRoot('s1', '/project', false)).rejects.toMatchObject({
      code: 'INTEGRATION_UNAVAILABLE',
    });
    expect(server.roots).toHaveLength(0);
  });

  it.each([false, undefined, 'true', null])(
    'refuses unconfirmed mutation success %s',
    async (ok) => {
      const fetchImpl = vi
        .fn<typeof fetch>()
        .mockResolvedValue(new Response(JSON.stringify({ ok, error: SECRET }), { status: 200 }));
      const refusing = new OpenWorkerHttpClient({ port, token: TOKEN, fetchImpl });
      for (const operation of [
        () => refusing.registerMcpServer('nexar', LAUNCH),
        () => refusing.deleteMcpServer('nexar'),
        () => refusing.attachRoot('s1', '/project', false),
      ]) {
        await expect(operation()).rejects.toMatchObject({
          code: 'INTEGRATION_UNAVAILABLE',
          message: 'OpenWorker request failed',
        });
      }
    },
  );

  it('authenticates the upstream wire request with a header, not a URL token', async () => {
    const fetchImpl = vi
      .fn<typeof fetch>()
      .mockResolvedValue(new Response(JSON.stringify({ ok: true }), { status: 200 }));
    const inspected = new OpenWorkerHttpClient({ port, token: TOKEN, fetchImpl });
    await inspected.attachRoot('session/a', '/project', false);
    expect(fetchImpl).toHaveBeenCalledWith(
      `http://127.0.0.1:${port}/v1/sessions/session%2Fa/roots`,
      expect.objectContaining({
        method: 'POST',
        redirect: 'error',
        headers: { 'X-OpenWorker-Token': TOKEN, 'content-type': 'application/json' },
        body: JSON.stringify({ path: '/project', writable: false }),
      }),
    );
  });
});
