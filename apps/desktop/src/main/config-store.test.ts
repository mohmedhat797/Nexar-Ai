import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { addProject, createHarness, type Harness } from './test-harness.js';

function gate(): { ready: Promise<void>; open: () => void } {
  let open!: () => void;
  const ready = new Promise<void>((resolve) => {
    open = resolve;
  });
  return { ready, open };
}

const discovery = {
  enabled: true,
  credentialSource: 'keystore',
  sources: { piCatalog: { enabled: true, providers: ['anthropic'] } },
};

let h: Harness;
beforeEach(async () => {
  h = await createHarness();
});
afterEach(async () => {
  vi.restoreAllMocks();
  await h.cleanup();
});

describe('config mutation queue', () => {
  it('restores a failed project reload before a queued provider mutation reads config', async () => {
    const projectId = await addProject(h);
    const previousText = await h.config.readText();
    const previousProjects = (await h.config.read())['projects'];
    const previousEngine = h.engine.composition();
    const written = gate();
    const reload = gate();
    const failed = h.config.update(
      (raw) => {
        raw['projects'] = [
          { id: 'missing', displayName: 'Missing', roots: [join(h.userData, 'missing-project')] },
        ];
      },
      async () => {
        written.open();
        await reload.ready;
        try {
          await h.engine.reload();
        } catch (error) {
          expect(h.engine.composition()).toBe(previousEngine);
          throw error;
        }
      },
    );
    const failure = expect(failed).rejects.toMatchObject({ code: 'CONFIGURATION_ERROR' });
    await written.ready;
    const readText = vi.spyOn(h.config, 'readText');
    let providerStarted = false;
    const provider = h.config.update(
      async (raw) => {
        providerStarted = true;
        expect(await h.config.readText()).toBe(previousText);
        expect(raw['projects']).toEqual(previousProjects);
        expect(h.engine.composition()).toBe(previousEngine);
        raw['discovery'] = discovery;
        return 'provider-saved';
      },
      () => h.engine.reload(),
    );
    try {
      // A microtask lets an incorrectly unqueued mutation start without timing-based sleeps.
      await Promise.resolve();
      expect(readText).not.toHaveBeenCalled();
      expect(providerStarted).toBe(false);
    } finally {
      reload.open();
    }
    await failure;
    await expect(provider).resolves.toBe('provider-saved');
    expect((await h.config.read())['discovery']).toEqual(discovery);
    expect(
      h.engine
        .composition()
        .runtime.projects.list()
        .map((p) => p.id),
    ).toEqual([projectId]);
    expect(h.engine.composition()).not.toBe(previousEngine);
  });

  it('keeps a provider afterWrite callback in the queue until a project can be added', async () => {
    const written = gate();
    const reload = gate();
    const previousEngine = h.engine.composition();
    const provider = h.config.update(
      (raw) => {
        raw['discovery'] = discovery;
        return 'anthropic';
      },
      async (result) => {
        expect(result).toBe('anthropic');
        written.open();
        await reload.ready;
        expect((await h.config.read())['projects']).toEqual([]);
        expect(h.engine.composition()).toBe(previousEngine);
        await h.engine.reload();
      },
    );
    await written.ready;
    const readText = vi.spyOn(h.config, 'readText');
    const project = h.config.update(
      (raw) => {
        raw['projects'] = [{ id: 'demo', displayName: 'Demo', roots: [h.projectDir] }];
        return 'demo';
      },
      () => h.engine.reload(),
    );
    try {
      await Promise.resolve();
      expect(readText).not.toHaveBeenCalled();
    } finally {
      reload.open();
    }
    await expect(provider).resolves.toBe('anthropic');
    await expect(project).resolves.toBe('demo');
    expect((await h.config.read())['discovery']).toEqual(discovery);
    expect(
      h.engine
        .composition()
        .runtime.projects.list()
        .map((p) => p.id),
    ).toEqual(['demo']);
    expect(h.engine.composition().loaded.config.discovery.credentialSource).toBe('keystore');
  });
});
