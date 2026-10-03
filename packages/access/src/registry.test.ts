import * as nodeCrypto from 'node:crypto';
import { mkdtemp, readFile, readdir, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { NexarError } from '@nexar/contracts';

vi.mock('node:crypto', async (importOriginal: () => Promise<typeof nodeCrypto>) => {
  const actual = await importOriginal();
  return { ...actual, timingSafeEqual: vi.fn(actual.timingSafeEqual) };
});

import {
  ClientRegistry,
  authorize,
  effectiveMaxCost,
  generateToken,
  hashToken,
  isWellFormedToken,
  type ClientIdentity,
  type ClientScopes,
} from './index.js';

const scopes: ClientScopes = {
  tools: ['nexar_run'],
  taskKinds: ['code-review'],
  projects: ['proj-a'],
  workflows: ['wf-1'],
};
const anyScopes: ClientScopes = {
  tools: ['*'],
  taskKinds: ['*'],
  projects: ['*'],
  workflows: ['*'],
};

let dir: string;
let file: string;

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'nexar-access-'));
  file = join(dir, 'state', 'clients.json');
  vi.mocked(nodeCrypto.timingSafeEqual).mockClear();
});

afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

function failure(fn: () => unknown): NexarError {
  try {
    fn();
  } catch (error) {
    return error as NexarError;
  }
  throw new Error('expected failure');
}

describe('credentials', () => {
  it('generates nxr_ + 43 base64url chars (256 bits), unique each time', () => {
    const a = generateToken();
    const b = generateToken();
    expect(a).toMatch(/^nxr_[A-Za-z0-9_-]{43}$/);
    expect(isWellFormedToken(a)).toBe(true);
    expect(a).not.toBe(b);
    expect(Buffer.from(a.slice(4), 'base64url')).toHaveLength(32);
  });
});

describe('ClientRegistry', () => {
  it('stores only the hash, never the token', async () => {
    const registry = await ClientRegistry.open(file);
    const { client, token } = await registry.add('openworker', scopes, {
      displayName: 'OpenWorker',
    });
    const bytes = await readFile(file, 'utf8');
    expect(bytes).not.toContain(token);
    expect(bytes).toContain(hashToken(token));
    expect(client.tokenHint).toBe(token.slice(-4));
    expect(await readdir(join(dir, 'state'))).toEqual(['clients.json']);
  });

  it('list hides hashes', async () => {
    const registry = await ClientRegistry.open(file);
    await registry.add('openworker', scopes);
    const listed = registry.list();
    expect(listed).toHaveLength(1);
    expect(JSON.stringify(listed)).not.toContain('tokenSha256');
    expect(listed[0]).not.toHaveProperty('tokenSha256');
  });

  it('authenticates a valid token and returns a frozen identity', async () => {
    const registry = await ClientRegistry.open(file);
    const { token } = await registry.add('openworker', scopes);
    const identity = registry.authenticate(token);
    expect(identity.clientId).toBe('openworker');
    expect(identity.scopes).toEqual(scopes);
    expect(Object.isFrozen(identity)).toBe(true);
  });

  it('rejects duplicates, bad ids, and unknown revocations with CONFIGURATION_ERROR', async () => {
    const registry = await ClientRegistry.open(file);
    await registry.add('openworker', scopes);
    await expect(registry.add('openworker', scopes)).rejects.toMatchObject({
      code: 'CONFIGURATION_ERROR',
    });
    await expect(registry.add('Bad Id', scopes)).rejects.toMatchObject({
      code: 'CONFIGURATION_ERROR',
    });
    await expect(registry.revoke('nobody')).rejects.toMatchObject({ code: 'CONFIGURATION_ERROR' });
  });

  it('gives every authentication failure the identical error', async () => {
    const registry = await ClientRegistry.open(file);
    const { token } = await registry.add('openworker', scopes);
    const other = await registry.add('other', scopes);
    await registry.revoke('other');
    await registry.reload();

    const attempts: (string | undefined)[] = [
      undefined,
      '',
      'garbage',
      'nxr_short',
      generateToken(),
      token.slice(0, -1) + (token.endsWith('A') ? 'B' : 'A'),
      other.token,
    ];
    const errors = attempts.map((t) => failure(() => registry.authenticate(t)));
    for (const e of errors) {
      expect(e).toBeInstanceOf(NexarError);
      expect(e.name).toBe('NexarError');
      expect(e.code).toBe('AUTH_REQUIRED');
      expect(e.message).toBe('Authentication failed');
      expect(e.details).toBeUndefined();
    }
    expect(errors.map((e) => JSON.stringify(e))).toEqual(
      errors.map(() => JSON.stringify(errors[0])),
    );
  });

  it('revocation takes effect after reload, not before', async () => {
    const registry = await ClientRegistry.open(file);
    const { token } = await registry.add('openworker', scopes);
    const cli = await ClientRegistry.open(file);
    await cli.revoke('openworker');
    expect(registry.authenticate(token).clientId).toBe('openworker');
    await registry.reload();
    expect(failure(() => registry.authenticate(token)).code).toBe('AUTH_REQUIRED');
    expect(registry.list()[0]?.revokedAt).toBeDefined();
  });

  it('compares the presented hash against every client, revoked or not, without early exit', async () => {
    const registry = await ClientRegistry.open(file);
    const first = await registry.add('first', scopes);
    await registry.add('second', scopes);
    const third = await registry.add('third', scopes);
    await registry.revoke('third');
    const spy = vi.mocked(nodeCrypto.timingSafeEqual);

    spy.mockClear();
    expect(registry.authenticate(first.token).clientId).toBe('first');
    expect(spy).toHaveBeenCalledTimes(3);

    spy.mockClear();
    failure(() => registry.authenticate(third.token));
    expect(spy).toHaveBeenCalledTimes(3);

    spy.mockClear();
    failure(() => registry.authenticate(undefined));
    expect(spy).toHaveBeenCalledTimes(3);
  });

  it('fails closed on corrupt or malformed files', async () => {
    const registry = await ClientRegistry.open(file);
    await registry.add('openworker', scopes);
    const good = JSON.parse(await readFile(file, 'utf8')) as { clients: Record<string, unknown>[] };
    const bad: string[] = [
      '{not json',
      '[]',
      JSON.stringify({ version: 2, clients: [] }),
      JSON.stringify({ version: 1 }),
      JSON.stringify({ version: 1, clients: [{ ...good.clients[0], tokenSha256: 'abc' }] }),
      JSON.stringify({ version: 1, clients: [{ ...good.clients[0], id: 'BAD' }] }),
      JSON.stringify({ version: 1, clients: [{ ...good.clients[0], scopes: { tools: ['*'] } }] }),
      JSON.stringify({ version: 1, clients: [good.clients[0], good.clients[0]] }),
    ];
    for (const text of bad) {
      await writeFile(file, text);
      await expect(ClientRegistry.open(file)).rejects.toMatchObject({
        code: 'CONFIGURATION_ERROR',
      });
      await expect(registry.reload()).rejects.toMatchObject({ code: 'CONFIGURATION_ERROR' });
    }
  });

  it('treats a missing file as an empty registry that authenticates nobody', async () => {
    const registry = await ClientRegistry.open(file);
    expect(registry.list()).toEqual([]);
    expect(failure(() => registry.authenticate(generateToken())).code).toBe('AUTH_REQUIRED');
  });

  it('creates the directory 0700 and file 0600', async () => {
    const registry = await ClientRegistry.open(file);
    await registry.add('openworker', scopes);
    // Windows permissions are ACL-based; Node's mode bits do not represent them.
    if (process.platform !== 'win32') {
      expect((await stat(join(dir, 'state'))).mode & 0o777).toBe(0o700);
      expect((await stat(file)).mode & 0o777).toBe(0o600);
    }
    expect(await readFile(file, 'utf8')).toContain('openworker');
  });

  it('serializes concurrent adds without losing clients', async () => {
    const registry = await ClientRegistry.open(file);
    await Promise.all(['aa', 'bb', 'cc', 'dd'].map((id) => registry.add(id, scopes)));
    const reopened = await ClientRegistry.open(file);
    expect(
      reopened
        .list()
        .map((c) => c.id)
        .sort(),
    ).toEqual(['aa', 'bb', 'cc', 'dd']);
  });
});

describe('scopes', () => {
  const identity = (s: ClientScopes): ClientIdentity => ({ clientId: 'c', scopes: s });

  function scopeOf(fn: () => void): unknown {
    const error = failure(fn);
    expect(error.code).toBe('POLICY_REJECTED');
    expect(error.message).toBe('Not permitted for this client');
    return error.details?.scope;
  }

  it('allows listed values and omitted optional dimensions', () => {
    expect(() =>
      authorize(identity(scopes), {
        tool: 'nexar_run',
        taskKind: 'code-review',
        projectId: 'proj-a',
        workflowId: 'wf-1',
      }),
    ).not.toThrow();
    expect(() => authorize(identity(scopes), { tool: 'nexar_run' })).not.toThrow();
  });

  it('rejects each dimension and names it', () => {
    const id = identity(scopes);
    expect(scopeOf(() => authorize(id, { tool: 'other' }))).toBe('tool');
    expect(scopeOf(() => authorize(id, { tool: 'nexar_run', taskKind: 'x' }))).toBe('task-kind');
    expect(scopeOf(() => authorize(id, { tool: 'nexar_run', projectId: 'x' }))).toBe('project');
    expect(scopeOf(() => authorize(id, { tool: 'nexar_run', workflowId: 'x' }))).toBe('workflow');
    expect(scopeOf(() => authorize(id, { tool: 'nexar_run', maxCostUsd: -1 }))).toBe('cost');
    expect(scopeOf(() => authorize(id, { tool: 'nexar_run', maxCostUsd: NaN }))).toBe('cost');
  });

  it("'*' allows anything, and empty lists allow nothing", () => {
    expect(() =>
      authorize(identity(anyScopes), {
        tool: 'any',
        taskKind: 'any',
        projectId: 'any',
        workflowId: 'any',
      }),
    ).not.toThrow();
    const none: ClientScopes = { tools: [], taskKinds: [], projects: [], workflows: [] };
    expect(scopeOf(() => authorize(identity(none), { tool: 'nexar_run' }))).toBe('tool');
  });

  it('effectiveMaxCost is min(requested, client cap)', () => {
    const capped = identity({ ...anyScopes, maxCostUsd: 1 });
    expect(effectiveMaxCost(capped, 5)).toBe(1);
    expect(effectiveMaxCost(capped, 0.25)).toBe(0.25);
    expect(effectiveMaxCost(capped)).toBe(1);
    expect(effectiveMaxCost(identity(anyScopes), 5)).toBe(5);
    expect(effectiveMaxCost(identity(anyScopes))).toBeUndefined();
  });
});
