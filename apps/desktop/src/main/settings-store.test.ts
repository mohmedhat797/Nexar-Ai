import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { inventoryResourceId } from '@nexar/resource-registry';
import {
  DEFAULT_BEHAVIOR,
  DEFAULT_ORCHESTRATION,
  DEFAULT_CODE_PLANE,
  MAX_PLANE_PROJECTS,
  SettingsStore,
  type CodePlaneConfigResult,
} from './settings-store.js';

let dir: string;
let path: string;

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'nexar-settings-'));
  path = join(dir, 'desktop-settings.json');
});
afterEach(async () => {
  await rm(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
});

const base = { theme: 'light', density: 'comfortable', mode: 'cowork' };

async function codePlaneOf(section: unknown): Promise<CodePlaneConfigResult> {
  await writeFile(path, JSON.stringify({ ...base, codePlane: section }));
  return new SettingsStore(path).getCodePlane();
}

describe('Cowork settings: dshEntry', () => {
  const coworkOf = async (section: unknown) => {
    await writeFile(path, JSON.stringify({ ...base, cowork: section }));
    return new SettingsStore(path).getCowork();
  };

  it.each([join(tmpdir(), 'dsh', 'bin.js'), 'C:\\dsh\\lib\\bin.js', '/opt/dsh/bin.JS'])(
    'accepts the absolute .js entry %s',
    async (dshEntry) => {
      expect(await coworkOf({ dshEntry })).toEqual({
        valid: true,
        value: { dshEntry },
      });
    },
  );

  it('ignores the retired keys of older builds on read and keeps them on disk on write', async () => {
    const legacy = {
      executable: 'retired-server',
      versionExecutable: '../not-even-valid',
      allowedProviders: ['openai', 'not-a-provider'],
    };
    await writeFile(path, JSON.stringify({ ...base, cowork: legacy }));
    const store = new SettingsStore(path);
    expect(await store.getCowork()).toEqual({ valid: true, value: {} });
    await store.set({ theme: 'dark' });
    const saved = JSON.parse(await readFile(path, 'utf8')) as Record<string, unknown>;
    expect(saved['cowork']).toEqual(legacy);
    expect(saved['theme']).toBe('dark');
  });

  it.each(['bin.js', './bin.js', join(tmpdir(), 'dsh.cmd'), join(tmpdir(), 'dsh'), '', 7])(
    'fails closed on %j',
    async (dshEntry) => {
      expect(await coworkOf({ dshEntry })).toEqual({ valid: false });
    },
  );
});
describe('Code plane settings', () => {
  it('defaults when the file or the section is missing', async () => {
    expect(await new SettingsStore(path).getCodePlane()).toEqual({
      valid: true,
      value: DEFAULT_CODE_PLANE,
    });
    await writeFile(path, JSON.stringify(base));
    expect(await new SettingsStore(path).getCodePlane()).toEqual({
      valid: true,
      value: DEFAULT_CODE_PLANE,
    });
    expect(DEFAULT_CODE_PLANE).toEqual({
      distro: 'nexar-plane',
      command: '/usr/local/bin/nexar',
      projects: {},
    });
  });

  it('fills defaults for omitted keys and accepts valid owner values', async () => {
    expect(await codePlaneOf({})).toEqual({ valid: true, value: DEFAULT_CODE_PLANE });
    expect(
      await codePlaneOf({
        distro: 'Ubuntu-24.04_plane',
        command: '/opt/nexar-1.2/bin/nexar',
        projects: { 'my.proj:1': 'plane_proj-2'.toLowerCase() },
      }),
    ).toEqual({
      valid: true,
      value: {
        distro: 'Ubuntu-24.04_plane',
        command: '/opt/nexar-1.2/bin/nexar',
        projects: { 'my.proj:1': 'plane_proj-2' },
      },
    });
  });

  it.each([
    ['a distro with a space', { distro: 'my distro' }],
    ['a distro starting with a dash (an option)', { distro: '-d' }],
    ['a distro with a shell metacharacter', { distro: 'x;rm' }],
    ['an empty distro', { distro: '' }],
    ['a 65-character distro', { distro: 'a'.repeat(65) }],
    ['a relative command', { command: 'nexar' }],
    ['a command with ..', { command: '/usr/../bin/sh' }],
    ['a command with a space', { command: '/usr/local/bin/nexar --x' }],
    ['a Windows command', { command: 'C:\nexar.exe' }],
    ['a command with shell characters', { command: '/bin/sh;id' }],
    ['a 257-character command', { command: `/${'a'.repeat(256)}` }],
    ['an unknown key', { shell: true }],
    ['a non-object', 'nexar-plane'],
    ['null', null],
    ['an array', []],
    ['a path as a plane project', { projects: { p: '/home/me/repo' } }],
    ['an uppercase desktop project id', { projects: { Proj: 'x' } }],
    ['a non-string mapping', { projects: { p: 1 } }],
  ])('fails closed on %s', async (_name, section) => {
    expect(await codePlaneOf(section)).toEqual({ valid: false });
  });

  it('never turns a prototype key into a mapping or pollutes Object', async () => {
    await writeFile(
      path,
      `{"theme":"light","density":"comfortable","mode":"cowork","codePlane":{"projects":{"__proto__":{"polluted":true}}}}`,
    );
    const result = await new SettingsStore(path).getCodePlane();
    if (result.valid) {
      expect(Object.keys(result.value.projects)).toEqual([]);
    }
    expect(({} as Record<string, unknown>)['polluted']).toBeUndefined();
  });

  it('refuses more than the maximum number of mappings', async () => {
    const projects = Object.fromEntries(
      Array.from({ length: MAX_PLANE_PROJECTS + 1 }, (_unused, i) => [`p${String(i)}`, 'x']),
    );
    expect(await codePlaneOf({ projects })).toEqual({ valid: false });
  });

  it('writes the section only once a mapping was set, and keeps the appearance keys', async () => {
    const store = new SettingsStore(path);
    await store.set({ theme: 'dark' });
    expect(JSON.parse(await readFile(path, 'utf8'))).toEqual({ ...base, theme: 'dark' });
    await store.setPlaneProject('proj-1', 'plane-1');
    expect(JSON.parse(await readFile(path, 'utf8'))).toEqual({
      ...base,
      theme: 'dark',
      codePlane: { ...DEFAULT_CODE_PLANE, projects: { 'proj-1': 'plane-1' } },
    });
    expect(await store.setPlaneProject('proj-1', null)).toEqual(DEFAULT_CODE_PLANE);
  });

  it('serializes concurrent mapping changes', async () => {
    const store = new SettingsStore(path);
    await Promise.all(
      Array.from({ length: 12 }, (_unused, i) => store.setPlaneProject(`p${String(i)}`, 'x')),
    );
    const stored = JSON.parse(await readFile(path, 'utf8')) as {
      codePlane: { projects: Record<string, string> };
    };
    expect(Object.keys(stored.codePlane.projects)).toHaveLength(12);
  });

  it('validates ids on write and enforces the mapping limit', async () => {
    const store = new SettingsStore(path);
    await expect(store.setPlaneProject('Bad Id', 'x')).rejects.toMatchObject({
      code: 'VALIDATION_ERROR',
    });
    await expect(store.setPlaneProject('ok', '../x')).rejects.toMatchObject({
      code: 'VALIDATION_ERROR',
    });
    await expect(store.setPlaneProject('__proto__', 'x')).rejects.toMatchObject({
      code: 'VALIDATION_ERROR',
    });
    // Seed the file at the limit (one write per mapping is slow on loaded Windows runners).
    const full = Object.fromEntries(
      Array.from({ length: MAX_PLANE_PROJECTS }, (_unused, i) => [`p${String(i)}`, 'x']),
    );
    await writeFile(
      path,
      JSON.stringify({ ...base, codePlane: { ...DEFAULT_CODE_PLANE, projects: full } }),
    );
    const atLimit = new SettingsStore(path);
    await expect(atLimit.setPlaneProject('one-too-many', 'x')).rejects.toMatchObject({
      code: 'POLICY_REJECTED',
    });
    // Replacing an existing mapping at the limit is still allowed.
    await atLimit.setPlaneProject('p0', 'y');
  });

  it('refuses to edit a damaged section', async () => {
    await writeFile(path, JSON.stringify({ ...base, codePlane: { distro: 'bad distro' } }));
    const store = new SettingsStore(path);
    await expect(store.setPlaneProject('p', 'x')).rejects.toMatchObject({
      code: 'CONFIGURATION_ERROR',
    });
    // Appearance changes still work and keep the owner's damaged text for them to fix.
    await store.set({ theme: 'sand' });
    expect(JSON.parse(await readFile(path, 'utf8'))).toMatchObject({
      theme: 'sand',
      codePlane: { distro: 'bad distro' },
    });
  });
});

describe('AI behavior settings (NXR-053)', () => {
  it('resolves legacy plan preference and control pins to the same route without rewriting settings', async () => {
    const raw = JSON.stringify({
      ...base,
      behavior: {
        cowork: { permission: 'drafts-only', preferredResourceId: 'chatgpt-plan:gpt-5.4' },
        code: { permission: 'auto-edit', preferredResourceId: 'chatgpt-plan:gpt-5.4' },
      },
      orchestration: {
        cowork: {
          controlResource: {
            mode: 'pinned',
            resourceId: 'chatgpt-plan:gpt-5.4',
            fallback: 'none',
          },
        },
      },
    });
    await writeFile(path, raw);
    const canonical = inventoryResourceId(
      {
        provider: 'openai',
        connectionId: 'openai.chatgpt-plan',
        runtimeId: 'pi',
        routeId: 'openai.responses.account',
        machine: 'desktop',
      },
      { kind: 'model', id: 'gpt-5.4' },
    );
    const store = new SettingsStore(path);
    expect(await store.getBehavior()).toEqual({
      valid: true,
      value: {
        cowork: { permission: 'drafts-only', preferredResourceId: canonical },
        code: { permission: 'auto-edit', preferredResourceId: canonical },
      },
    });
    expect(await store.getOrchestration()).toEqual({
      valid: true,
      value: {
        cowork: { controlResource: { mode: 'pinned', resourceId: canonical, fallback: 'none' } },
      },
    });
    expect(await readFile(path, 'utf8')).toBe(raw);
  });

  const behaviorOf = async (section: unknown) => {
    await writeFile(path, JSON.stringify({ ...base, behavior: section }));
    return new SettingsStore(path).getBehavior();
  };

  it('defaults to drafts only and auto-edit when the file or the section is missing', async () => {
    expect(await new SettingsStore(path).getBehavior()).toEqual({
      valid: true,
      value: DEFAULT_BEHAVIOR,
    });
    expect(DEFAULT_BEHAVIOR).toEqual({
      cowork: { permission: 'drafts-only' },
      code: { permission: 'auto-edit' },
    });
    expect(await behaviorOf({})).toEqual({ valid: true, value: DEFAULT_BEHAVIOR });
    expect(await behaviorOf({ code: { permission: 'plan' } })).toEqual({
      valid: true,
      value: { ...DEFAULT_BEHAVIOR, code: { permission: 'plan' } },
    });
  });

  it('accepts the supported permissions and a preferred resource', async () => {
    expect(
      await behaviorOf({
        cowork: { permission: 'ask-before-write', preferredResourceId: 'local-echo' },
        code: { permission: 'plan', preferredResourceId: 'dsh:deepseek' },
      }),
    ).toEqual({
      valid: true,
      value: {
        cowork: { permission: 'ask-before-write', preferredResourceId: 'local-echo' },
        code: { permission: 'plan', preferredResourceId: 'dsh:deepseek' },
      },
    });
  });

  it.each([
    ['full-auto', { code: { permission: 'full-auto' } }],
    ['ask-before-edits', { code: { permission: 'ask-before-edits' } }],
    ['a cowork value under code', { code: { permission: 'read-only' } }],
    ['a code value under cowork', { cowork: { permission: 'plan' } }],
    ['an extra top-level key', { network: 'open' }],
    ['an extra key in a mode', { code: { permission: 'plan', network: true } }],
    ['a bad resource id', { cowork: { preferredResourceId: '../etc' } }],
    ['a non-object', 'plan'],
    ['an array', []],
    ['null', null],
  ])('a damaged section fails closed: %s', async (_name, section) => {
    expect(await behaviorOf(section)).toEqual({ valid: false });
  });

  it('keeps a damaged section verbatim, refuses to patch it and still saves appearance', async () => {
    const damaged = { code: { permission: 'full-auto' } };
    await writeFile(path, JSON.stringify({ ...base, behavior: damaged }));
    const store = new SettingsStore(path);
    await expect(store.setBehavior({ code: { permission: 'plan' } })).rejects.toMatchObject({
      code: 'CONFIGURATION_ERROR',
    });
    await store.set({ theme: 'dark' });
    expect(JSON.parse(await readFile(path, 'utf8'))).toMatchObject({
      theme: 'dark',
      behavior: damaged,
    });
  });

  it('merges patches, clears a preferred resource with null and leaves other sections alone', async () => {
    await writeFile(
      path,
      JSON.stringify({ ...base, codePlane: { projects: { a: 'plane-a' } }, cowork: {} }),
    );
    const store = new SettingsStore(path);
    expect(await store.setBehavior({ cowork: { preferredResourceId: 'local-echo' } })).toEqual({
      cowork: { permission: 'drafts-only', preferredResourceId: 'local-echo' },
      code: { permission: 'auto-edit' },
    });
    expect(await store.setBehavior({ code: { permission: 'plan' } })).toEqual({
      cowork: { permission: 'drafts-only', preferredResourceId: 'local-echo' },
      code: { permission: 'plan' },
    });
    expect(await store.setBehavior({ cowork: { preferredResourceId: null } })).toEqual({
      cowork: { permission: 'drafts-only' },
      code: { permission: 'plan' },
    });
    const file = JSON.parse(await readFile(path, 'utf8')) as Record<string, unknown>;
    expect(file['behavior']).toEqual({
      cowork: { permission: 'drafts-only' },
      code: { permission: 'plan' },
    });
    expect(file['codePlane']).toMatchObject({ projects: { a: 'plane-a' } });
    // A new store sees the persisted value.
    expect(await new SettingsStore(path).getBehavior()).toMatchObject({ valid: true });
  });
});

describe('Orchestration settings (NXR-063)', () => {
  const orchestrationOf = async (section: unknown) => {
    await writeFile(path, JSON.stringify({ ...base, orchestration: section }));
    return new SettingsStore(path).getOrchestration();
  };

  it('defaults to Auto with fallback when the file or section is missing', async () => {
    expect(await new SettingsStore(path).getOrchestration()).toEqual({
      valid: true,
      value: DEFAULT_ORCHESTRATION,
    });
    expect(DEFAULT_ORCHESTRATION.cowork.controlResource).toEqual({
      mode: 'auto',
      fallback: 'auto',
    });
    expect(await orchestrationOf({})).toEqual({ valid: true, value: DEFAULT_ORCHESTRATION });
  });

  it('accepts auto and pinned policies', async () => {
    const pinned = { mode: 'pinned', resourceId: 'pi:local', fallback: 'none' };
    expect(await orchestrationOf({ cowork: { controlResource: pinned } })).toEqual({
      valid: true,
      value: { cowork: { controlResource: pinned } },
    });
  });

  it.each([
    { cowork: { controlResource: { mode: 'pinned', fallback: 'auto' } } },
    { cowork: { controlResource: { mode: 'auto', resourceId: 'x', fallback: 'auto' } } },
    {
      cowork: {
        controlResource: { mode: 'pinned', resourceId: 'x'.repeat(201), fallback: 'auto' },
      },
    },
    { cowork: { controlResource: { mode: 'auto' } } },
    { cowork: { controlResource: { mode: 'auto', fallback: 'auto', extra: 1 } } },
    { other: 1 },
    'text',
  ])('fails closed on a damaged section %#', async (section) => {
    expect(await orchestrationOf(section)).toEqual({ valid: false });
  });

  it('writes the policy, keeps other sections, and refuses to overwrite a damaged one', async () => {
    await writeFile(path, JSON.stringify({ ...base, cowork: { allowedProviders: [] } }));
    const store = new SettingsStore(path);
    await store.setCoworkControlResource({ mode: 'pinned', resourceId: 'r1', fallback: 'auto' });
    const saved = JSON.parse(await readFile(path, 'utf8')) as Record<string, unknown>;
    expect(saved['orchestration']).toEqual({
      cowork: { controlResource: { mode: 'pinned', resourceId: 'r1', fallback: 'auto' } },
    });
    expect(saved['cowork']).toEqual({ allowedProviders: [] });
    expect((await new SettingsStore(path).getOrchestration()).valid).toBe(true);
    await expect(
      store.setCoworkControlResource({ mode: 'pinned', fallback: 'auto' }),
    ).rejects.toMatchObject({ code: 'VALIDATION_ERROR' });

    const damaged = { cowork: { controlResource: { mode: 'nope' } } };
    await writeFile(path, JSON.stringify({ ...base, orchestration: damaged }));
    const broken = new SettingsStore(path);
    await expect(
      broken.setCoworkControlResource({ mode: 'auto', fallback: 'auto' }),
    ).rejects.toMatchObject({ code: 'CONFIGURATION_ERROR' });
    await broken.set({ theme: 'dark' });
    const kept = JSON.parse(await readFile(path, 'utf8')) as Record<string, unknown>;
    expect(kept['orchestration']).toEqual(damaged);
  });
});

describe('ChatGPT plan models (NXR-067)', () => {
  const modelsOf = async (section: unknown) => {
    await writeFile(path, JSON.stringify({ ...base, chatgptPlan: section }));
    return new SettingsStore(path).getChatGptPlan();
  };

  it('has no assumed model when the file or the section is missing', async () => {
    expect(await new SettingsStore(path).getChatGptPlan()).toEqual({
      valid: true,
      value: { models: [] },
    });
    await writeFile(path, JSON.stringify(base));
    expect(await new SettingsStore(path).getChatGptPlan()).toMatchObject({ valid: true });
  });

  it('accepts the owner list, de-duplicated', async () => {
    expect(await modelsOf({ models: ['gpt-5.2', 'gpt-5.4', 'gpt-5.2'] })).toEqual({
      valid: true,
      value: { models: ['gpt-5.2', 'gpt-5.4'] },
    });
  });

  it.each([
    ['an empty list', { models: [] }],
    ['an uppercase id', { models: ['GPT-5'] }],
    ['a path-like id', { models: ['../x'] }],
    ['an id with a colon', { models: ['a:b'] }],
    ['a non-string id', { models: [5] }],
    ['an unknown key', { models: ['gpt-5.2'], extra: true }],
    ['a non-object section', 'gpt-5.2'],
    ['more than sixteen models', { models: Array.from({ length: 17 }, (_, i) => `m${String(i)}`) }],
  ])('treats %s as damaged', async (_label, section) => {
    expect(await modelsOf(section)).toEqual({ valid: false });
  });

  it('keeps the owner section verbatim and the appearance keys when other settings are saved', async () => {
    const section = { models: ['gpt-5.4'] };
    await writeFile(path, JSON.stringify({ ...base, chatgptPlan: section }));
    const store = new SettingsStore(path);
    await store.set({ theme: 'dark' });
    expect(JSON.parse(await readFile(path, 'utf8'))).toMatchObject({
      theme: 'dark',
      chatgptPlan: section,
    });
    // The section does not turn the appearance keys into defaults.
    expect(await new SettingsStore(path).get()).toMatchObject({ theme: 'dark', mode: 'cowork' });
  });
});
