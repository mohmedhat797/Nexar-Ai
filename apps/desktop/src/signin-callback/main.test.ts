import { spawn, type ChildProcessByStdio } from 'node:child_process';
import type { Readable, Writable } from 'node:stream';
import { request } from 'node:http';
import { rm } from 'node:fs/promises';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { bundleSigninChild } from '../main/signin-test-kit.js';

const STATE = 'state-sentinel-abcdefgh';
let kit: Awaited<ReturnType<typeof bundleSigninChild>>;
type Child = ChildProcessByStdio<Writable, Readable, null>;
const children: Child[] = [];

beforeAll(async () => {
  kit = await bundleSigninChild();
}, 60_000);
afterAll(async () => {
  await rm(kit.dir, { recursive: true, force: true });
});
afterEach(() => {
  for (const child of children.splice(0)) child.kill();
});

interface Running {
  readonly child: Child;
  /** The next stdout line, parsed. */
  next(): Promise<Record<string, unknown>>;
  exit(): Promise<number | null>;
}

function launch(config: string): Running {
  const child = spawn(kit.launch.command, [...kit.launch.args], {
    env: { ...kit.launch.env },
    stdio: ['pipe', 'pipe', 'ignore'],
    windowsHide: true,
  });
  children.push(child);
  child.stdin.write(config);
  let buffered = '';
  const waiting: ((line: string) => void)[] = [];
  const lines: string[] = [];
  child.stdout.setEncoding('utf8');
  child.stdout.on('data', (chunk: string) => {
    buffered += chunk;
    for (let end = buffered.indexOf('\n'); end !== -1; end = buffered.indexOf('\n')) {
      const line = buffered.slice(0, end);
      buffered = buffered.slice(end + 1);
      const waiter = waiting.shift();
      if (waiter === undefined) lines.push(line);
      else waiter(line);
    }
  });
  const exited = new Promise<number | null>((resolve) =>
    child.once('close', (code) => resolve(code)),
  );
  return {
    child,
    next: async () => {
      const line = lines.shift() ?? (await new Promise<string>((resolve) => waiting.push(resolve)));
      return JSON.parse(line) as Record<string, unknown>;
    },
    exit: () => exited,
  };
}

const start = (extra: Record<string, unknown> = {}): Running =>
  launch(`${JSON.stringify({ state: STATE, ...extra })}\n`);

function get(
  port: number,
  path: string,
  host = `127.0.0.1:${String(port)}`,
): Promise<{ status: number; body: string }> {
  return new Promise((resolve, reject) => {
    const req = request({ host: '127.0.0.1', port, path, headers: { host } }, (res) => {
      let body = '';
      res.setEncoding('utf8');
      res.on('data', (chunk: string) => (body += chunk));
      res.on('end', () => resolve({ status: res.statusCode ?? 0, body }));
    });
    req.on('error', reject);
    req.end();
  });
}

describe('signin-callback child', () => {
  it('binds loopback and prints one { port } line', async () => {
    const running = start();
    const { port } = (await running.next()) as { port: number };
    expect(Number.isInteger(port)).toBe(true);
    expect(port).toBeGreaterThan(0);
    expect((await get(port, '/other')).status).toBe(404);
  });

  it('guards the Host header and answers 404 to everything but /callback', async () => {
    const running = start();
    const { port } = (await running.next()) as { port: number };
    const query = `?code=code-1&state=${STATE}&client_id=oaiapp_a`;
    expect((await get(port, `/callback${query}`, 'localhost')).status).toBe(404);
    expect((await get(port, `/callback${query}`, `evil.example:${String(port)}`)).status).toBe(404);
    expect((await get(port, `/${query}`)).status).toBe(404);
  });

  it('refuses a wrong state and still completes with the real callback', async () => {
    const running = start();
    const { port } = (await running.next()) as { port: number };
    expect((await get(port, '/callback?code=c&state=wrong&client_id=oaiapp_a')).status).toBe(400);
    await get(port, `/callback?code=code-1&state=${STATE}&client_id=oaiapp_a`);
    expect(await running.next()).toEqual({ code: 'code-1', clientId: 'oaiapp_a' });
    expect(await running.exit()).toBe(0);
  });

  it('reports error= callbacks as denied', async () => {
    const running = start();
    const { port } = (await running.next()) as { port: number };
    await get(port, `/callback?error=access_denied&state=${STATE}`);
    expect(await running.next()).toEqual({ error: 'denied' });
    expect(await running.exit()).toBe(0);
  });

  it('prints { code, clientId } for the right state, reflects nothing, and exits', async () => {
    const running = start();
    const { port } = (await running.next()) as { port: number };
    const res = await get(
      port,
      `/callback?code=code-sentinel-1&state=${STATE}&client_id=oaiapp_abc&x=reflected-sentinel`,
    );
    expect(res.status).toBe(200);
    expect(res.body).not.toContain('code-sentinel');
    expect(res.body).not.toContain('reflected-sentinel');
    expect(await running.next()).toEqual({ code: 'code-sentinel-1', clientId: 'oaiapp_abc' });
    expect(await running.exit()).toBe(0);
    await expect(get(port, '/callback')).rejects.toThrow();
  });

  it('exits when stdin closes', async () => {
    const running = start();
    await running.next();
    running.child.stdin.end();
    expect(await running.exit()).toBe(0);
  });

  it('exits with a timeout line when nobody comes', async () => {
    const running = start({ timeoutMs: 300 });
    await running.next();
    expect(await running.next()).toEqual({ error: 'timeout' });
    expect(await running.exit()).toBe(0);
  });

  it.each([
    'not json\n',
    `${JSON.stringify({})}\n`,
    `${JSON.stringify({ state: 'short' })}\n`,
    `${JSON.stringify({ state: 7 })}\n`,
    `${JSON.stringify({ state: `${STATE}!` })}\n`,
  ])('refuses a bad configuration line %j without binding', async (line) => {
    const running = launch(line);
    expect(await running.exit()).toBe(2);
  });
});
