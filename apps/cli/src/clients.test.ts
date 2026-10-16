import { mkdtemp, readFile, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { ClientRegistry, hashToken } from '@nexar/access';
import { runCli } from './cli.js';
import type { CliIo } from './io.js';

const TOKEN = /^nxr_[A-Za-z0-9_-]{43}$/;

interface Captured {
  readonly io: CliIo;
  readonly out: () => string;
  readonly err: () => string;
}

function capture(cwd: string): Captured {
  let out = '';
  let err = '';
  const io: CliIo = {
    stdout: (s) => (out += s),
    stderr: (s) => (err += s),
    env: { PATH: process.env['PATH'] ?? '' },
    cwd,
  };
  return { io, out: () => out, err: () => err };
}

const ADD = [
  'clients',
  'add',
  'mcp-client',
  '--tools',
  'nexar.submit_work,nexar.work_status',
  '--task-kinds',
  'documentation,analysis',
  '--projects',
  'demo',
];

describe('nexar clients (in-process, offline)', () => {
  let dir: string;
  const file = (): string => join(dir, '.nexar', 'clients.json');

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'nexar-clients-'));
  });
  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it('add prints the token once, on stdout only, and stores only its hash', async () => {
    const c = capture(dir);
    expect(await runCli(ADD, c.io)).toBe(0);
    const token = c.out().trim();
    expect(c.out()).toBe(token + '\n');
    expect(token).toMatch(TOKEN);
    expect(c.err()).toContain('will not be shown again');
    expect(c.err()).not.toContain(token);

    const stored = await readFile(file(), 'utf8');
    expect(stored).not.toContain(token);
    expect(stored).toContain(hashToken(token));
    // Windows chmod cannot express owner-only POSIX permission bits.
    if (process.platform !== 'win32') expect((await stat(file())).mode & 0o777).toBe(0o600);

    const registry = await ClientRegistry.open(file());
    expect(registry.authenticate(token).clientId).toBe('mcp-client');
    expect(registry.list()[0]?.scopes).toEqual({
      tools: ['nexar.submit_work', 'nexar.work_status'],
      taskKinds: ['documentation', 'analysis'],
      projects: ['demo'],
      workflows: [],
    });
  });

  it('never shows the token again: not in list, not in --json list', async () => {
    const add = capture(dir);
    await runCli(ADD, add.io);
    const token = add.out().trim();
    const hash = hashToken(token);

    const text = capture(dir);
    expect(await runCli(['clients', 'list'], text.io)).toBe(0);
    expect(text.out()).toContain('mcp-client');
    expect(text.out()).toContain('active');
    expect(text.out()).not.toContain(token);
    expect(text.out()).not.toContain(hash);

    const json = capture(dir);
    expect(await runCli(['clients', 'list', '--json'], json.io)).toBe(0);
    expect(json.out()).not.toContain(token);
    expect(json.out()).not.toContain(hash);
    expect(json.out()).not.toContain('tokenSha256');
    const parsed = JSON.parse(json.out()) as { id: string; scopes: { tools: string[] } }[];
    expect(parsed).toHaveLength(1);
    expect(parsed[0]).toMatchObject({ id: 'mcp-client' });
  });

  it('prints the created client and token as JSON with --json', async () => {
    const c = capture(dir);
    expect(await runCli([...ADD, '--json'], c.io)).toBe(0);
    const parsed = JSON.parse(c.out()) as { client: Record<string, unknown>; token: string };
    expect(parsed.token).toMatch(TOKEN);
    expect(parsed.client).not.toHaveProperty('tokenSha256');
  });

  it('lists an empty registry', async () => {
    const c = capture(dir);
    expect(await runCli(['clients', 'list'], c.io)).toBe(0);
    expect(c.out()).toBe('no clients\n');
  });

  it('revoke stops the credential from working and is reflected in list', async () => {
    const add = capture(dir);
    await runCli(ADD, add.io);
    const token = add.out().trim();

    const revoke = capture(dir);
    expect(await runCli(['clients', 'revoke', 'mcp-client'], revoke.io)).toBe(0);
    expect(revoke.out()).toBe('revoked mcp-client\n');

    const registry = await ClientRegistry.open(file());
    expect(() => registry.authenticate(token)).toThrow('Authentication failed');
    const list = capture(dir);
    await runCli(['clients', 'list'], list.io);
    expect(list.out()).toContain('revoked');
  });

  it('revoking an unknown client is an error', async () => {
    const c = capture(dir);
    expect(await runCli(['clients', 'revoke', 'ghost'], c.io)).toBe(1);
    expect(c.err()).toContain('Unknown client');
  });

  it('refuses a duplicate client id without printing a token', async () => {
    await runCli(ADD, capture(dir).io);
    const again = capture(dir);
    expect(await runCli(ADD, again.io)).toBe(1);
    expect(again.out()).toBe('');
    expect(again.err()).toContain('already exists');
  });

  it('records the cost ceiling and workflows', async () => {
    const c = capture(dir);
    expect(await runCli([...ADD, '--max-cost', '1.5', '--workflows', 'weekly-report'], c.io)).toBe(
      0,
    );
    const [client] = (await ClientRegistry.open(file())).list();
    expect(client?.scopes).toMatchObject({ maxCostUsd: 1.5, workflows: ['weekly-report'] });
  });

  describe('usage errors (exit 2, no token issued)', () => {
    const cases: [string, string[]][] = [
      ['missing --tools', ['clients', 'add', 'x', '--task-kinds', 'a', '--projects', 'p']],
      ['missing --task-kinds', ['clients', 'add', 'x', '--tools', '*', '--projects', 'p']],
      ['missing --projects', ['clients', 'add', 'x', '--tools', '*', '--task-kinds', 'a']],
      [
        'unknown tool',
        ['clients', 'add', 'x', '--tools', 'nexar.nope', '--task-kinds', 'a', '--projects', 'p'],
      ],
      ['bad --max-cost', [...ADD, '--max-cost', 'lots']],
      ['negative --max-cost', [...ADD, '--max-cost', '-1']],
      ['no id', ['clients', 'add']],
      ['no action', ['clients']],
      ['bad action', ['clients', 'frobnicate']],
      ['list with an id', ['clients', 'list', 'x']],
    ];
    it.each(cases)('%s', async (_name, argv) => {
      const c = capture(dir);
      expect(await runCli(argv, c.io)).toBe(2);
      expect(c.out()).toBe('');
    });
  });

  it('accepts * as "any" and rejects an invalid client id', async () => {
    const ok = capture(dir);
    expect(
      await runCli(
        ['clients', 'add', 'all-access', '--tools', '*', '--task-kinds', '*', '--projects', '*'],
        ok.io,
      ),
    ).toBe(0);
    const bad = capture(dir);
    expect(await runCli([...ADD.slice(0, 2), 'Bad Id', ...ADD.slice(3)], bad.io)).toBe(1);
    expect(bad.err()).toContain('Invalid client id');
  });
});
