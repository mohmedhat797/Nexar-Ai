import { resolve } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { NexarError, resourceId, type ResourceDescriptor } from '@nexar/contracts';
import { SANDBOX_CODEX_HOME } from './adapter.js';
import { codexResource } from './resource.js';
import { fakeLauncher, harness, task } from './test/harness.js';
import type { Harness } from './test/harness.js';

const ID = 'openai.subscription.caaaaaaaaaa';
const HOME = resolve('/private/homes/a');

function owner(options?: Record<string, unknown>, id = ID): ResourceDescriptor {
  const base = codexResource({
    id: resourceId(`codex:${id}`),
    metadata: {
      connection: {
        id,
        provider: 'openai',
        method: 'subscription',
        authClass: 'vendor-native',
        support: 'official',
      },
    },
  });
  return options === undefined ? base : { ...base, runtime: { ...base.runtime, options } };
}

let h: Harness | undefined;
afterEach(async () => {
  await h?.cleanup();
  h = undefined;
});

describe('owner connection home binding', () => {
  it('runs with the resolved home, ignoring the parent CODEX_HOME', async () => {
    const resolveHome = vi.fn(() => Promise.resolve(HOME));
    h = harness({}, { CODEX_HOME: resolve('/vendor/default') }, { resolveHome });
    await h.adapter.execute({ task: task(), resource: owner() }, h.context());
    expect(h.invocations()[0]?.env['CODEX_HOME']).toBe(HOME);
    expect(resolveHome).toHaveBeenCalledOnce();
  });

  it('keeps each connection on its own home', async () => {
    const homes: Record<string, string> = {
      [`codex:${ID}`]: HOME,
      'codex:openai.subscription.cbbbbbbbbbb': resolve('/private/homes/b'),
    };
    h = harness(
      {},
      {},
      {
        resolveHome: (resource) => Promise.resolve(homes[resource.id]!),
      },
    );
    await h.adapter.execute({ task: task(), resource: owner() }, h.context());
    await h.adapter.execute(
      { task: task(), resource: owner(undefined, 'openai.subscription.cbbbbbbbbbb') },
      h.context(),
    );
    expect(h.invocations().map((call) => call.env['CODEX_HOME'])).toEqual([
      HOME,
      resolve('/private/homes/b'),
    ]);
  });

  it('never passes an API key or token to the child', async () => {
    h = harness(
      {},
      {
        OPENAI_API_KEY: 'synthetic-owner-home-key',
        CODEX_API_KEY: 'synthetic-owner-home-key',
        CODEX_ACCESS_TOKEN: 'synthetic-owner-home-key',
      },
      { resolveHome: () => Promise.resolve(HOME) },
    );
    await h.adapter.execute({ task: task(), resource: owner() }, h.context());
    await h.adapter.probe(owner(), new AbortController().signal);
    for (const call of h.invocations()) {
      expect(JSON.stringify(call.env)).not.toContain('synthetic-owner-home-key');
      expect(call.env['CODEX_HOME']).toBe(HOME);
    }
  });

  it('refuses a home set on the resource before anything is spawned', async () => {
    const resolveHome = vi.fn(() => Promise.resolve(HOME));
    h = harness({}, {}, { resolveHome });
    await expect(
      h.adapter.execute(
        { task: task(), resource: owner({ codexHome: resolve('/elsewhere') }) },
        h.context(),
      ),
    ).rejects.toMatchObject({ code: 'CONFIGURATION_ERROR' });
    expect(resolveHome).not.toHaveBeenCalled();
    expect(h.invocations()).toEqual([]);
  });

  it('refuses without a resolver, never falling back to the default home', async () => {
    h = harness();
    await expect(
      h.adapter.execute({ task: task(), resource: owner() }, h.context()),
    ).rejects.toMatchObject({ code: 'CONFIGURATION_ERROR' });
    expect(h.invocations()).toEqual([]);
  });

  it.each(['CONFIGURATION_ERROR', 'AUTH_REQUIRED'] as const)(
    'spawns nothing when the host reports %s',
    async (code) => {
      h = harness({}, {}, { resolveHome: () => Promise.reject(new NexarError(code, 'refused')) });
      await expect(
        h.adapter.execute({ task: task(), resource: owner() }, h.context()),
      ).rejects.toMatchObject({ code });
      expect(h.invocations()).toEqual([]);
    },
  );

  it('binds the resolved home in the sandbox', async () => {
    const launcher = fakeLauncher('sandbox');
    // A directory that exists: the adapter checks it before asking the launcher.
    h = harness({}, {}, { resolveHome: () => Promise.resolve(process.cwd()) });
    await h.adapter.execute(
      { task: task(), resource: owner() },
      h.context(undefined, h.workspace(launcher, 'read-write')),
    );
    expect(launcher.specs[0]?.mounts).toEqual([
      { hostPath: process.cwd(), sandboxPath: SANDBOX_CODEX_HOME, access: 'read-write' },
    ]);
    expect(launcher.specs[0]?.env['CODEX_HOME']).toBe(SANDBOX_CODEX_HOME);
  });

  it('probes with the resolved home and never starts a login', async () => {
    h = harness({}, {}, { resolveHome: () => Promise.resolve(HOME) });
    await h.adapter.probe(owner(), new AbortController().signal);
    const calls = h.invocations();
    expect(calls.map((call) => call.env['CODEX_HOME'])).toEqual([HOME, HOME]);
    expect(calls.map((call) => call.argv.join(' '))).toEqual(['--version', 'login status']);
  });

  it('reports a home that is missing or refused without spawning', async () => {
    const { signal } = new AbortController();
    h = harness(
      {},
      {},
      { resolveHome: () => Promise.reject(new NexarError('AUTH_REQUIRED', 'sign in')) },
    );
    expect(await h.adapter.probe(owner(), signal)).toMatchObject({
      availability: 'available',
      auth: 'unauthenticated',
    });
    expect(h.invocations()).toEqual([]);
    await h.cleanup();
    h = harness(
      {},
      {},
      { resolveHome: () => Promise.reject(new NexarError('CONFIGURATION_ERROR', 'no')) },
    );
    expect(await h.adapter.probe(owner(), signal)).toMatchObject({ availability: 'unavailable' });
    expect(h.invocations()).toEqual([]);
  });

  it('leaves the built-in connection on its own home without calling the resolver', async () => {
    const resolveHome = vi.fn(() => Promise.resolve(HOME));
    h = harness({}, {}, { resolveHome });
    await h.adapter.execute({ task: task(), resource: codexResource() }, h.context());
    expect(resolveHome).not.toHaveBeenCalled();
    expect(h.invocations()[0]?.env['CODEX_HOME']).not.toBe(HOME);
  });
});
