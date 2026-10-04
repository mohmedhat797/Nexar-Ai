import { request } from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterEach, describe, expect, it } from 'vitest';
import { createCallbackServer, type CallbackOutcome } from './index.js';

const STATE = 'state-sentinel-1';
const servers: ReturnType<typeof createCallbackServer>[] = [];

async function start(): Promise<{ port: number; outcomes: CallbackOutcome[] }> {
  const outcomes: CallbackOutcome[] = [];
  const server = createCallbackServer({ state: STATE, onOutcome: (o) => outcomes.push(o) });
  servers.push(server);
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  return { port: (server.address() as AddressInfo).port, outcomes };
}

afterEach(async () => {
  await Promise.all(
    servers.splice(0).map(
      (server) =>
        new Promise<void>((resolve) => {
          server.close(() => resolve());
          server.closeAllConnections();
        }),
    ),
  );
});

function get(
  port: number,
  path: string,
  options: { host?: string; method?: string } = {},
): Promise<{ status: number; body: string; headers: Record<string, unknown> }> {
  return new Promise((resolve, reject) => {
    const req = request(
      {
        host: '127.0.0.1',
        port,
        path,
        method: options.method ?? 'GET',
        headers: { host: options.host ?? `127.0.0.1:${String(port)}` },
      },
      (res) => {
        let body = '';
        res.setEncoding('utf8');
        res.on('data', (chunk: string) => (body += chunk));
        res.on('end', () => resolve({ status: res.statusCode ?? 0, body, headers: res.headers }));
      },
    );
    req.on('error', reject);
    req.end();
  });
}

describe('callback server', () => {
  it('returns the code and issued client id for the right state', async () => {
    const { port, outcomes } = await start();
    const res = await get(port, `/callback?code=code-1&state=${STATE}&client_id=oaiapp_abc`);
    expect(res.status).toBe(200);
    expect(outcomes).toEqual([{ code: 'code-1', clientId: 'oaiapp_abc' }]);
  });

  it('answers only GET /callback addressed to 127.0.0.1:<port>', async () => {
    const { port, outcomes } = await start();
    const query = `?code=code-1&state=${STATE}&client_id=oaiapp_abc`;
    expect((await get(port, `/${query}`)).status).toBe(404);
    expect((await get(port, `/callback/x${query}`)).status).toBe(404);
    expect((await get(port, `/callback${query}`, { method: 'POST' })).status).toBe(404);
    expect((await get(port, `/callback${query}`, { host: 'localhost' })).status).toBe(404);
    expect(
      (await get(port, `/callback${query}`, { host: `evil.example:${String(port)}` })).status,
    ).toBe(404);
    expect((await get(port, `/callback${query}`, { host: '127.0.0.1:1' })).status).toBe(404);
    expect(outcomes).toEqual([]);
  });

  it('refuses a wrong or missing state and keeps waiting for the real callback', async () => {
    const { port, outcomes } = await start();
    expect((await get(port, '/callback?code=c&state=nope&client_id=oaiapp_a')).status).toBe(400);
    expect((await get(port, '/callback?code=c&client_id=oaiapp_a')).status).toBe(400);
    expect(outcomes).toEqual([]);
    await get(port, `/callback?code=code-1&state=${STATE}&client_id=oaiapp_abc`);
    expect(outcomes).toEqual([{ code: 'code-1', clientId: 'oaiapp_abc' }]);
  });

  it('maps error= to denied and bad fields to invalid-callback', async () => {
    const denied = await start();
    await get(denied.port, `/callback?error=access_denied&state=${STATE}`);
    expect(denied.outcomes).toEqual([{ error: 'denied' }]);
    for (const query of [
      `state=${STATE}&client_id=oaiapp_a`,
      `state=${STATE}&code=c`,
      `state=${STATE}&code=c%20d&client_id=oaiapp_a`,
      `state=${STATE}&code=c&client_id=${'a'.repeat(200)}`,
    ]) {
      const bad = await start();
      expect((await get(bad.port, `/callback?${query}`)).status).toBe(400);
      expect(bad.outcomes).toEqual([{ error: 'invalid-callback' }]);
    }
  });

  it('reports only the first callback', async () => {
    const { port, outcomes } = await start();
    await get(port, `/callback?code=c1&state=${STATE}&client_id=oaiapp_a`);
    await get(port, `/callback?code=c2&state=${STATE}&client_id=oaiapp_a`);
    expect(outcomes).toEqual([{ code: 'c1', clientId: 'oaiapp_a' }]);
  });

  it('never reflects input and sets hardening headers', async () => {
    const { port } = await start();
    const reflected = 'reflected-sentinel<script>';
    for (const path of [
      `/callback?code=${reflected}&state=${reflected}&client_id=${reflected}&error=${reflected}`,
      `/callback?code=ok&state=${STATE}&client_id=oaiapp_a&x=${reflected}`,
      `/${encodeURIComponent(reflected)}`,
    ]) {
      const res = await get(port, path);
      expect(res.body).not.toContain('reflected-sentinel');
      expect(res.body).not.toContain('<script');
      expect(res.headers['cache-control']).toBe('no-store');
      expect(res.headers['content-security-policy']).toBe("default-src 'none'");
      expect(res.headers['referrer-policy']).toBe('no-referrer');
    }
  });
});
