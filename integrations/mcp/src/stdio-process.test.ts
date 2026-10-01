import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { mkdir, mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Client } from '@modelcontextprotocol/client';
import { StdioClientTransport } from '@modelcontextprotocol/client/stdio';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { ClientRegistry } from '@nexar/access';
import { echoResource } from '@nexar/integration-echo';

// Process-level: drives the BUILT CLI (`pnpm build` first), exactly as OpenWorker would launch it.
const MAIN = fileURLToPath(new URL('../../../apps/cli/dist/main.js', import.meta.url));

const SECRET_PROMPT = 'TOP-SECRET-PROMPT-TEXT';

describe.skipIf(!existsSync(MAIN))('nexar mcp serve (real process, stdio)', () => {
  let dir: string;
  let configPath: string;
  let token: string;

  beforeAll(async () => {
    dir = await realpath(await mkdtemp(join(tmpdir(), 'nexar-mcp-proc-')));
    await mkdir(join(dir, 'demo'));
    configPath = join(dir, 'nexar.config.json');
    await writeFile(
      configPath,
      JSON.stringify({
        version: 1,
        resources: [echoResource()],
        routing: { policy: 'deterministic', defaultResourceId: 'local-echo' },
        projects: [{ id: 'demo', displayName: 'Demo', roots: [join(dir, 'demo')] }],
      }),
    );
    const registry = await ClientRegistry.open(join(dir, '.nexar', 'clients.json'));
    ({ token } = await registry.add('openworker', {
      tools: ['nexar.submit_work', 'nexar.work_status', 'nexar.route', 'nexar.resources'],
      taskKinds: ['documentation'],
      projects: ['demo'],
      workflows: [],
    }));
  });

  afterAll(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  const args = (): string[] => [MAIN, '--config', configPath, 'mcp', 'serve'];
  const env = (clientToken: string | undefined): Record<string, string> => ({
    PATH: process.env['PATH'] ?? '',
    ...(clientToken === undefined ? {} : { NEXAR_CLIENT_TOKEN: clientToken }),
  });

  function textOf(result: unknown): Record<string, unknown> {
    const content = (result as { content: { type: string; text: string }[] }).content;
    expect(content).toHaveLength(1);
    return JSON.parse(content[0]?.text ?? '') as Record<string, unknown>;
  }

  it('serves every tool through the real stdio client transport, logging only to stderr', async () => {
    const transport = new StdioClientTransport({
      command: process.execPath,
      args: args(),
      cwd: dir,
      env: env(token),
      stderr: 'pipe',
    });
    let stderr = '';
    transport.stderr?.on('data', (chunk: Buffer) => (stderr += chunk.toString('utf8')));
    const client = new Client({ name: 'stdio-test', version: '1' });
    try {
      await client.connect(transport);
      const { tools } = await client.listTools();
      expect(tools.map((t) => t.name).sort()).toEqual([
        'nexar.resources',
        'nexar.route',
        'nexar.submit_work',
        'nexar.work_status',
        'nexar.workflows',
      ]);

      const submit = textOf(
        await client.callTool({
          name: 'nexar.submit_work',
          arguments: {
            requestId: 'proc-1',
            project: 'demo',
            taskKind: 'documentation',
            request: SECRET_PROMPT,
            output: { filename: 'out' },
          },
        }),
      );
      expect(submit).toMatchObject({
        status: 'completed',
        output: { text: `[echo:local-echo] ${SECRET_PROMPT}` },
        route: { resourceId: 'local-echo' },
      });
      expect((submit['artifacts'] as unknown[]).length).toBe(1);

      const status = textOf(
        await client.callTool({ name: 'nexar.work_status', arguments: { requestId: 'proc-1' } }),
      );
      expect(status['status']).toBe('completed');

      const route = textOf(
        await client.callTool({
          name: 'nexar.route',
          arguments: { project: 'demo', taskKind: 'documentation' },
        }),
      );
      expect(route).toMatchObject({ outcome: 'selected', selected: { resourceId: 'local-echo' } });

      const resources = textOf(await client.callTool({ name: 'nexar.resources', arguments: {} }));
      expect((resources['resources'] as { id: string }[]).map((r) => r.id)).toEqual(['local-echo']);

      const invalid = await client.callTool({
        name: 'nexar.submit_work',
        arguments: { requestId: 'proc-2', project: 'demo' },
      });
      expect((invalid as { isError?: boolean }).isError).toBe(true);
      expect(textOf(invalid)['status']).toBe('rejected');
    } finally {
      await client.close();
    }

    expect(stderr).toContain('nexar mcp serve: listening on stdio');
    expect(stderr).not.toContain(token);
    expect(stderr).not.toContain(SECRET_PROMPT);

    const audit = (await readFile(join(dir, '.nexar', 'audit.jsonl'), 'utf8'))
      .split('\n')
      .filter((l) => l !== '')
      .map((l) => JSON.parse(l) as { tool: string; requestId: string; clientId: string });
    expect(audit.map((a) => a.tool)).toEqual([
      'nexar.submit_work',
      'nexar.work_status',
      'nexar.route',
      'nexar.resources',
      'nexar.submit_work',
    ]);
    expect(audit.every((a) => a.clientId === 'openworker')).toBe(true);
    const rawAudit = await readFile(join(dir, '.nexar', 'audit.jsonl'), 'utf8');
    expect(rawAudit).not.toContain(SECRET_PROMPT);
    expect(rawAudit).not.toContain(token);
  }, 30_000);

  it('refuses calls without a token, through the real transport', async () => {
    const transport = new StdioClientTransport({
      command: process.execPath,
      args: args(),
      cwd: dir,
      env: env(undefined),
      stderr: 'pipe',
    });
    let stderr = '';
    transport.stderr?.on('data', (chunk: Buffer) => (stderr += chunk.toString('utf8')));
    const client = new Client({ name: 'stdio-test', version: '1' });
    try {
      await client.connect(transport);
      const res = await client.callTool({ name: 'nexar.resources', arguments: {} });
      expect((res as { isError?: boolean }).isError).toBe(true);
      expect(textOf(res)).toEqual({
        error: { code: 'AUTH_REQUIRED', message: 'Authentication failed' },
      });
    } finally {
      await client.close();
    }
    expect(stderr).toContain('NEXAR_CLIENT_TOKEN is not set');
  }, 30_000);

  it('writes nothing but JSON-RPC messages to stdout (raw bytes, hand-written requests)', async () => {
    const child = spawn(process.execPath, args(), {
      cwd: dir,
      env: env(token),
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    const stdout: Buffer[] = [];
    let stderr = '';
    child.stdout.on('data', (chunk: Buffer) => stdout.push(chunk));
    child.stderr.on('data', (chunk: Buffer) => (stderr += chunk.toString('utf8')));
    const exited = new Promise<number | null>((resolve) => child.on('close', resolve));

    const send = (message: Record<string, unknown>): void => {
      child.stdin.write(JSON.stringify({ jsonrpc: '2.0', ...message }) + '\n');
    };
    const responses = (): number =>
      Buffer.concat(stdout)
        .toString('utf8')
        .split('\n')
        .filter((l) => l.trim() !== '').length;
    const until = async (count: number): Promise<void> => {
      const deadline = Date.now() + 20_000;
      while (responses() < count) {
        if (Date.now() > deadline) throw new Error(`timed out waiting for ${String(count)} frames`);
        await new Promise((r) => setTimeout(r, 25));
      }
    };

    send({
      id: 1,
      method: 'initialize',
      params: {
        protocolVersion: '2025-06-18',
        capabilities: {},
        clientInfo: { name: 'raw', version: '1' },
      },
    });
    await until(1);
    send({ method: 'notifications/initialized' });
    send({ id: 2, method: 'tools/list' });
    send({
      id: 3,
      method: 'tools/call',
      params: {
        name: 'nexar.submit_work',
        arguments: {
          requestId: 'raw-1',
          project: 'demo',
          taskKind: 'documentation',
          request: 'hello raw',
        },
      },
    });
    send({
      id: 4,
      method: 'tools/call',
      params: { name: 'nexar.route', arguments: { project: 'demo', taskKind: 'documentation' } },
    });
    send({ id: 5, method: 'tools/call', params: { name: 'nexar.resources', arguments: {} } });
    send({
      id: 6,
      method: 'tools/call',
      params: { name: 'nexar.submit_work', arguments: { bad: 1 } },
    });
    send({ id: 7, method: 'tools/call', params: { name: 'nexar.unknown', arguments: {} } });
    send({ id: 8, method: 'no/such/method' });
    await until(8);
    child.stdin.end();
    expect(await exited).toBe(0);

    const raw = Buffer.concat(stdout).toString('utf8');
    expect(raw.endsWith('\n')).toBe(true);
    const lines = raw.split('\n');
    expect(lines.pop()).toBe('');
    expect(lines).toHaveLength(8);
    const ids: unknown[] = [];
    for (const line of lines) {
      // Every line is exactly one JSON-RPC 2.0 message: no banner, no log line, no blank line.
      expect(line).not.toBe('');
      const message = JSON.parse(line) as Record<string, unknown>;
      expect(message['jsonrpc']).toBe('2.0');
      expect('id' in message || 'method' in message).toBe(true);
      ids.push(message['id']);
    }
    expect(ids.sort()).toEqual([1, 2, 3, 4, 5, 6, 7, 8]);
    const byId = new Map(lines.map((l) => [(JSON.parse(l) as { id: number }).id, JSON.parse(l)]));
    expect(JSON.stringify(byId.get(3))).toContain('[echo:local-echo] hello raw');
    expect(byId.get(7)).toHaveProperty('error');
    expect(byId.get(8)).toHaveProperty('error');

    expect(stderr).toContain('nexar mcp serve: listening on stdio');
    expect(stderr).not.toContain(token);
  }, 40_000);
});
