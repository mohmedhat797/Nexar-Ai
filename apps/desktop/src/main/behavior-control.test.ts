import { readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { CHANNELS } from '../shared/channels.js';
import type { PlaneStatusDto, ResourceRow } from '../shared/api.js';
import type { BehaviorView } from '../shared/behavior.js';
import type { BridgeDeps } from './channel.js';
import type { CodePlane } from './code-plane.js';
import type { CoworkService } from './cowork.js';
import { SettingsStore } from './settings-store.js';
import { createHarness, type Harness } from './test-harness.js';

const SENTINEL = 'sk-test-0000';

const ALL_CAPS = [
  'text-generation',
  'knowledge-work',
  'reasoning',
  'code-generation',
  'tool-use',
] as const;

function resource(
  id: string,
  kind: unknown,
  capabilities: readonly string[],
  extra: Record<string, unknown> = {},
): Record<string, unknown> {
  return {
    id,
    displayName: `Name ${id}`,
    kind,
    capabilities,
    runtime: { adapter: 'echo', locality: 'local' },
    auth: { mode: 'none' },
    cost: { model: 'free' },
    dataLocality: 'local',
    ...extra,
  };
}

let h: Harness | undefined;
afterEach(async () => {
  await h?.cleanup();
  h = undefined;
});

/** A harness whose registry also holds a control-capable model, a plain model and a native agent. */
async function harness(overrides: Partial<BridgeDeps> = {}): Promise<Harness> {
  h = await createHarness(overrides);
  await h.config.update((raw) => {
    raw.resources = [
      ...(raw.resources as unknown[]),
      resource(
        'ctl-model',
        { type: 'model', provider: 'anthropic', model: 'm1', access: 'api' },
        [...ALL_CAPS, 'model-turn'],
        { metadata: { apiKey: SENTINEL } },
      ),
      resource('plain-model', { type: 'model', provider: 'openai', model: 'm2', access: 'api' }, [
        ...ALL_CAPS,
      ]),
      resource('native-agent', { type: 'agent', agent: 'claude-code', interface: 'cli' }, [
        ...ALL_CAPS,
      ]),
    ];
  });
  await h.engine.reload();
  return h;
}

const settingsPath = (x: Harness): string => join(x.userData, 'desktop-settings.json');
/** A section of the settings file; `undefined` when the section or the whole file is absent. */
async function readFileSection(x: Harness, key: string): Promise<unknown> {
  try {
    return (JSON.parse(await readFile(settingsPath(x), 'utf8')) as Record<string, unknown>)[key];
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined;
    throw error;
  }
}

async function view(x: Harness): Promise<BehaviorView> {
  const result = await x.call<BehaviorView>(CHANNELS.behaviorGet);
  if (!result.ok) throw new Error('behavior:get failed');
  return result.value;
}

const fakeCowork = (effective: string | undefined) => {
  const refresh = vi.fn(() => Promise.resolve({}));
  const service = {
    effectiveControlResourceId: () => Promise.resolve(effective),
    refresh,
  } as unknown as CoworkService;
  return { service, refresh };
};

describe('behavior control view (NXR-065a)', () => {
  it('lists only control-compatible Cowork candidates and a read-only default for Code', async () => {
    const x = await harness();
    const { control } = await view(x);
    expect(control.cowork.candidates.map((c) => c.id)).toEqual(['ctl-model']);
    expect(control.cowork.candidates[0]).toEqual({
      id: 'ctl-model',
      label: 'Name ctl-model',
      provider: 'anthropic',
      method: 'api',
      support: 'official',
    });
    expect(control.cowork).toMatchObject({
      editable: true,
      policy: { mode: 'auto', fallback: 'auto' },
    });
    expect(control.code).toMatchObject({
      editable: false,
      policy: { mode: 'auto', fallback: 'auto' },
      candidates: [],
      reason: "Set orchestration.code.controlResource in the engineering plane's config",
    });
    expect(JSON.stringify(control)).not.toContain(SENTINEL);
  });

  it("shows the gateway's preview as the effective Cowork resource", async () => {
    const x = await harness({ cowork: fakeCowork('ctl-model').service });
    expect((await view(x)).control.cowork.effectiveResourceId).toBe('ctl-model');
  });

  it('takes the Code policy and candidates from the plane, read only', async () => {
    const status: Partial<PlaneStatusDto> = {
      codeControl: { mode: 'pinned', resourceId: 'plane-model', fallback: 'none' },
      planeResources: [
        {
          id: 'plane-model',
          provider: 'deepseek',
          method: 'api',
          support: 'official',
          auth: 'unknown',
          availability: 'unknown',
          control: { openworker: true, dsh: true },
        },
        {
          id: 'plane-agent',
          auth: 'unknown',
          availability: 'unknown',
          control: { openworker: false, dsh: false },
        },
      ],
    };
    const codePlane = { cachedStatus: () => status, refresh: vi.fn() } as unknown as CodePlane;
    const x = await harness({ codePlane });
    const { code } = (await view(x)).control;
    expect(code).toEqual({
      policy: { mode: 'pinned', resourceId: 'plane-model', fallback: 'none' },
      editable: false,
      candidates: [
        {
          id: 'plane-model',
          label: 'plane-model',
          provider: 'deepseek',
          method: 'api',
          support: 'official',
        },
      ],
    });
  });

  it('keeps defaults for an older plane that reports no Code policy', async () => {
    const codePlane = {
      cachedStatus: () => ({ planeResources: [] }),
      refresh: vi.fn(),
    } as unknown as CodePlane;
    const x = await harness({ codePlane });
    expect((await view(x)).control.code).toMatchObject({
      policy: { mode: 'auto', fallback: 'auto' },
      candidates: [],
      reason: expect.stringContaining('engineering plane') as string,
    });
  });
});

describe('behavior control patch (NXR-065a)', () => {
  const pin = { mode: 'pinned', resourceId: 'ctl-model', fallback: 'none' };

  it('pins a compatible resource, persists it and refreshes the Cowork status', async () => {
    const { service, refresh } = fakeCowork('ctl-model');
    const x = await harness({ cowork: service });
    const result = await x.call<BehaviorView>(CHANNELS.behaviorSet, {
      cowork: { controlResource: pin },
    });
    expect(result.ok && result.value.control.cowork.policy).toEqual(pin);
    expect(await readFileSection(x, 'orchestration')).toEqual({ cowork: { controlResource: pin } });
    expect(refresh).toHaveBeenCalledTimes(1);
    expect((await view(x)).control.cowork.policy).toEqual(pin);
  });

  it('auto drops the resource id', async () => {
    const x = await harness();
    await x.call(CHANNELS.behaviorSet, { cowork: { controlResource: pin } });
    const result = await x.call<BehaviorView>(CHANNELS.behaviorSet, {
      cowork: { controlResource: { mode: 'auto', resourceId: 'ctl-model', fallback: 'auto' } },
    });
    expect(result.ok && result.value.control.cowork.policy).toEqual({
      mode: 'auto',
      fallback: 'auto',
    });
    expect(await readFileSection(x, 'orchestration')).toEqual({
      cowork: { controlResource: { mode: 'auto', fallback: 'auto' } },
    });
  });

  it.each(['plain-model', 'native-agent', 'no-such-resource'])(
    'rejects a pin of %s and writes nothing',
    async (resourceId) => {
      const x = await harness();
      const result = await x.call(CHANNELS.behaviorSet, {
        cowork: { permission: 'read-only', controlResource: { ...pin, resourceId } },
      });
      expect(result).toMatchObject({ ok: false, error: { code: 'VALIDATION_ERROR' } });
      expect(await readFileSection(x, 'orchestration')).toBeUndefined();
      expect(await readFileSection(x, 'behavior')).toBeUndefined();
    },
  );

  it('rejects malformed control patches', async () => {
    const x = await harness();
    for (const bad of [
      { mode: 'pinned', fallback: 'auto' },
      { mode: 'pinned', resourceId: 'Bad Id', fallback: 'auto' },
      { mode: 'other', fallback: 'auto' },
      { mode: 'auto', fallback: 'auto', extra: 1 },
    ]) {
      const result = await x.call(CHANNELS.behaviorSet, { cowork: { controlResource: bad } });
      expect(result).toMatchObject({ ok: false, error: { code: 'VALIDATION_ERROR' } });
    }
  });

  it('refuses a Code control patch and writes nothing', async () => {
    const x = await harness();
    const result = await x.call(CHANNELS.behaviorSet, {
      code: { permission: 'plan', controlResource: pin },
    });
    expect(result).toMatchObject({ ok: false, error: { code: 'POLICY_REJECTED' } });
    expect(await readFileSection(x, 'behavior')).toBeUndefined();
    expect(await readFileSection(x, 'orchestration')).toBeUndefined();
  });

  it('is not editable on a damaged orchestration section, which stays untouched', async () => {
    const x = await harness();
    // x owns the temp directory (removed with it); y reads a damaged copy of the settings file.
    const path = join(x.userData, 'damaged-settings.json');
    const damaged = { cowork: { controlResource: { mode: 'pinned' } } };
    await writeFile(path, JSON.stringify({ orchestration: damaged }));
    const y = await createHarness({ settings: new SettingsStore(path) });
    try {
      const { control } = await view(y);
      expect(control.cowork).toMatchObject({
        editable: false,
        policy: { mode: 'auto', fallback: 'auto' },
        reason: 'The Cowork orchestration settings are not valid',
      });
      const result = await y.call(CHANNELS.behaviorSet, {
        cowork: { permission: 'read-only', controlResource: { mode: 'auto', fallback: 'auto' } },
      });
      expect(result).toMatchObject({ ok: false, error: { code: 'CONFIGURATION_ERROR' } });
      const file = JSON.parse(await readFile(path, 'utf8')) as Record<string, unknown>;
      expect(file['orchestration']).toEqual(damaged);
      expect(file['behavior']).toBeUndefined();
    } finally {
      await y.cleanup();
    }
  });
});

describe('resource rows (NXR-065a)', () => {
  it('carry the connection and the control flags, never a secret', async () => {
    const x = await harness();
    const result = await x.call<ResourceRow[]>(CHANNELS.resourcesList, { refresh: true });
    if (!result.ok) throw new Error('resources:list failed');
    const row = (id: string): ResourceRow | undefined => result.value.find((r) => r.id === id);
    expect(row('ctl-model')).toMatchObject({
      connection: { provider: 'anthropic', method: 'api', support: 'official' },
      control: { openworker: true, dsh: true },
    });
    expect(row('plain-model')?.control).toEqual({ openworker: false, dsh: false });
    expect(row('native-agent')).toMatchObject({
      connection: { provider: 'anthropic', method: 'subscription', support: 'official' },
      control: { openworker: false, dsh: false },
    });
    expect(row('local-echo')).toMatchObject({
      connection: { provider: 'local', method: 'local' },
      control: { openworker: false, dsh: false },
    });
    const json = JSON.stringify(result);
    expect(json).not.toContain(SENTINEL);
    expect(json).not.toContain('authClass');
  });
});
