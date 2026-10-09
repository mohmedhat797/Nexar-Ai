import { mkdir, mkdtemp, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { defaultConfig } from '@nexar/core';
import { FileProjectMemoryStore } from '@nexar/project-memory';
import { FileSessionStore } from '@nexar/sessions';
import type { BridgeResult, SessionEvent, TaskEvent } from '../shared/api.js';
import { createBridge, type Bridge } from './bridge.js';
import type { BridgeDeps, DialogPort, ShellPort } from './channel.js';
import { ConfigStore } from './config-store.js';
import { createEngineHost, type EngineHost } from './engine-host.js';
import { createStderrLogger } from './logger.js';
import { SettingsStore } from './settings-store.js';

export interface Harness {
  readonly bridge: Bridge;
  readonly engine: EngineHost;
  readonly config: ConfigStore;
  readonly userData: string;
  /** A real (canonical) empty directory outside userData, for use as a project. */
  readonly projectDir: string;
  readonly events: TaskEvent[];
  readonly sessionEvents: SessionEvent[];
  /** The dependencies the bridge was built with, so a test can build a second bridge over them. */
  readonly deps: BridgeDeps;
  /** The session store behind the default bridge (unless the test replaced `sessions`). */
  readonly sessionStore: FileSessionStore;
  readonly opened: string[];
  readonly revealed: string[];
  /** The folder the fake dialog returns next; `null` means the user cancelled. */
  pick: string | null;
  call<T = unknown>(channel: string, args?: unknown): Promise<BridgeResult<T>>;
  cleanup(): Promise<void>;
}

/** A bridge over a temp userData directory, the echo resource and a fake dialog and shell. */
export async function createHarness(overrides: Partial<BridgeDeps> = {}): Promise<Harness> {
  const base = await realpath(await mkdtemp(join(tmpdir(), 'nexar-desktop-')));
  const userData = join(base, 'userData');
  const projectDir = join(base, 'project');
  await mkdir(projectDir, { recursive: true });

  const config = new ConfigStore(join(userData, 'nexar.config.json'));
  await config.ensure();
  // The first-run config configures nothing; tests that route need the echo test double explicitly.
  await config.update((raw) => {
    raw.resources = JSON.parse(JSON.stringify(defaultConfig().resources)) as unknown;
    raw.routing = { policy: 'resource-intelligence', defaultResourceId: 'local-echo' };
  });
  const logger = createStderrLogger('error', {}, () => undefined);
  // An empty environment: discovery finds no CLIs, so the registry holds only configured resources.
  const engine = await createEngineHost({ configPath: config.path, env: {}, logger });

  const opened: string[] = [];
  const revealed: string[] = [];
  const events: TaskEvent[] = [];
  const sessionEvents: SessionEvent[] = [];
  const sessionStore = new FileSessionStore(join(userData, '.nexar', 'sessions'));
  // A test that passes its own `sessions` (even `undefined`) owns the lease question itself.
  if (!('sessions' in overrides)) await sessionStore.acquireLease();
  const state: { pick: string | null } = { pick: null };
  const dialog: DialogPort = {
    showOpenDialog: () =>
      Promise.resolve(
        state.pick === null
          ? { canceled: true, filePaths: [] }
          : { canceled: false, filePaths: [state.pick] },
      ),
  };
  const shell: ShellPort = {
    openPath: (path) => {
      opened.push(path);
      return Promise.resolve('');
    },
    showItemInFolder: (path) => {
      revealed.push(path);
    },
  };
  const deps: BridgeDeps = {
    engine,
    config,
    settings: new SettingsStore(join(userData, 'desktop-settings.json')),
    logger,
    dialog,
    shell,
    appInfo: { version: '0.0.0-test', platform: 'test' },
    decider: 'desktop:test',
    sessions: sessionStore,
    projectMemory: new FileProjectMemoryStore({
      stateDir: join(userData, '.nexar'),
      isWriter: () => sessionStore.holdsLease(),
    }),
    broadcastSession: (event) => {
      sessionEvents.push(event);
    },
    ...overrides,
  };
  const bridge = createBridge(deps);

  return {
    bridge,
    engine,
    config,
    userData,
    projectDir,
    events,
    sessionEvents,
    deps,
    sessionStore,
    opened,
    revealed,
    get pick() {
      return state.pick;
    },
    set pick(value: string | null) {
      state.pick = value;
    },
    call: (channel, args = {}) =>
      bridge.invoke(channel, args, (event) => events.push(event)) as Promise<BridgeResult<never>>,
    cleanup: () => rm(base, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 }),
  };
}

/** Adds `projectDir` as a project through the real `projects:add` channel; returns its id. */
export async function addProject(h: Harness): Promise<string> {
  h.pick = h.projectDir;
  const added = await h.call<{ id: string } | null>('projects:add');
  if (!added.ok || added.value === null) throw new Error('projects:add failed in the test harness');
  return added.value.id;
}

export async function seed(dir: string, files: Readonly<Record<string, string>>): Promise<void> {
  for (const [name, content] of Object.entries(files)) {
    const path = join(dir, name);
    await mkdir(join(path, '..'), { recursive: true });
    await writeFile(path, content);
  }
}
