import { mkdtemp, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { materializeInventory } from '@nexar/resource-registry';
import { codexDefaultInventorySource } from './inventory.js';
import { codexResource } from './resource.js';

let root: string;
beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'codex-default-inventory-'));
});
afterEach(async () => {
  await rm(root, { recursive: true, force: true });
});
describe('native Codex honest default', () => {
  it('uses only the injected native status port and never invents an explicit model or account route', async () => {
    const probe = vi.fn().mockResolvedValue({
      status: 'connected',
      authMode: 'vendor-account',
      loginSupported: true,
      version: '1.2.3',
    });
    const login = vi.fn();
    const source = codexDefaultInventorySource({
      env: {},
      privateDirectory: root,
      subscription: () => ({ probe, login }),
    });
    const result = await source.fetch(new AbortController().signal);
    expect(result.status).toBe('success');
    if (result.status !== 'success') throw new Error('Expected fixture');
    expect(result.entries[0]?.selection).toEqual({ kind: 'provider-default' });
    const resources = materializeInventory(
      {
        ...result,
        status: 'fresh',
        generation: 0,
        identity: {
          provider: 'openai',
          connectionId: 'openai.subscription',
          runtimeId: 'codex',
          routeId: 'codex.native',
          machine: 'desktop',
        },
      },
      codexResource(),
    );
    expect(resources[0]?.kind.type).toBe('agent');
    expect(resources[0]?.runtime.options?.['model']).toBeUndefined();
    expect(login).not.toHaveBeenCalled();
    expect(probe).toHaveBeenCalledOnce();
    expect(await readdir(root)).toEqual([]);
  });
  it('contains unavailable runtime details and cleans its neutral directory', async () => {
    const source = codexDefaultInventorySource({
      env: {},
      privateDirectory: root,
      subscription: () => ({
        probe: () => Promise.reject(new Error('SECRET-CANARY')),
        login: vi.fn(),
      }),
    });
    const result = await source.fetch(new AbortController().signal);
    expect(result).toMatchObject({ status: 'unavailable', reason: 'refresh-failed' });
    expect(JSON.stringify(result)).not.toContain('SECRET-CANARY');
    expect(await readdir(root)).toEqual([]);
  });
});
