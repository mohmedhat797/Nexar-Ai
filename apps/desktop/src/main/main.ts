import { userInfo } from 'node:os';
import { isAbsolute, join, resolve } from 'node:path';
import { app, BrowserWindow, clipboard, dialog, ipcMain, safeStorage, shell } from 'electron';
import { isNexarError } from '@nexar/contracts';
import { FileSessionStore } from '@nexar/sessions';
import { checkProviderCredential, createNativeSubscriptions } from '@nexar/host';
import { SESSION_EVENT_CHANNEL, TASK_EVENT_CHANNEL } from '../shared/channels.js';
import { createBridge } from './bridge.js';
import { CodePlane } from './code-plane.js';
import { ConfigStore } from './config-store.js';
import { createEngineHost } from './engine-host.js';
import { DesktopKeyStore } from './desktop-key-store.js';
import { ProviderService } from './providers.js';
import { SubscriptionService } from './subscriptions.js';
import { LocalEndpointService } from './local-endpoints.js';
import { createStderrLogger } from './logger.js';
import {
  createScriptLauncher,
  createWslLauncher,
  disabledPlaneLauncher,
  type PlaneLauncher,
} from './plane-connection.js';
import { ensurePrivateStateDirectory, PrivateStateError } from './private-state.js';
import { SettingsStore } from './settings-store.js';
import {
  bundlePaths,
  createMainWindow,
  hardenSession,
  installWebContentsLockdown,
  isTrustedFrameUrl,
} from './window.js';

// Per-user state lives in `<appData>/Nexar` (%APPDATA%\Nexar on Windows, ADR-021 §4). Tests point
// the app at a throwaway directory instead. Both must happen before `ready`.
app.setName('Nexar');
const userDataOverride = process.env['NEXAR_DESKTOP_USER_DATA'];
const userDataPath =
  userDataOverride !== undefined && userDataOverride !== ''
    ? resolve(userDataOverride)
    : join(app.getPath('appData'), 'Nexar');
app.setPath('userData', userDataPath);
// Chromium's runtime data (disk caches, storage, crash dumps) is not Nexar state and grows without
// bound. Keeping it outside the ACL-guarded state tree keeps the per-entry guard small and fast;
// on Windows it lives in the owner-private %LOCALAPPDATA%, next to a test override otherwise.
const localAppData = process.env['LOCALAPPDATA'];
const runtimePath =
  userDataOverride !== undefined && userDataOverride !== ''
    ? `${userDataPath}.runtime`
    : process.platform === 'win32' && localAppData !== undefined && localAppData !== ''
      ? join(localAppData, 'Nexar', 'Runtime')
      : join(app.getPath('appData'), 'Nexar Runtime');
app.setPath('sessionData', runtimePath);
app.setPath('crashDumps', join(runtimePath, 'Crashpad'));

function decider(): string {
  try {
    return `desktop:${userInfo().username}`;
  } catch {
    return 'desktop:unknown';
  }
}

/** Startup phase timings on stderr when tracing is requested (tests); phase names and ms only. */
const traceStartup =
  process.env['NEXAR_DESKTOP_STARTUP_TRACE'] === '1'
    ? (() => {
        const began = Date.now();
        return (phase: string): void => {
          process.stderr.write(`nexar-desktop: startup ${phase} ${String(Date.now() - began)}ms\n`);
        };
      })()
    : (): void => undefined;

async function start(): Promise<void> {
  const userData = app.getPath('userData');
  traceStartup('begin');
  await ensurePrivateStateDirectory(userData, { forbiddenPaths: [app.getPath('appData')] });
  traceStartup('state-guard');
  await app.whenReady();
  traceStartup('ready');
  hardenSession();
  installWebContentsLockdown();

  const logger = createStderrLogger();
  const config = new ConfigStore(join(userData, 'nexar.config.json'));
  await config.ensure();
  const settings = new SettingsStore(join(userData, 'desktop-settings.json'));
  // The installed app's catalogs are shipped beside app.asar, outside the workspace layout.
  // Keep owner-declared catalog overrides; only supply packaged defaults for missing values.
  const engineEnv = { ...process.env };
  if (app.isPackaged) {
    if (!engineEnv['NEXAR_WORKFLOWS_DIR']) {
      engineEnv['NEXAR_WORKFLOWS_DIR'] = join(process.resourcesPath, 'workflows');
    }
    if (!engineEnv['NEXAR_ENGINEERING_PLANS_DIR']) {
      engineEnv['NEXAR_ENGINEERING_PLANS_DIR'] = join(
        process.resourcesPath,
        'engineering',
        'plans',
      );
    }
  }
  const keys = new DesktopKeyStore({ userData, encryption: safeStorage });
  traceStartup('stores');
  const engine = await createEngineHost({
    configPath: config.path,
    env: engineEnv,
    logger,
    resolveSecret: keys.resolveSecret,
  });
  const providers = new ProviderService({
    keys,
    clipboard,
    config,
    engine,
    checkKey: (provider) =>
      checkProviderCredential(provider, { resolveSecret: keys.resolveSecret }),
  });
  const subscriptions = new SubscriptionService(
    createNativeSubscriptions({ env: engineEnv, cwd: app.getPath('home') }),
  );
  app.on('before-quit', () => subscriptions.dispose());

  // Operating Sessions (ADR-024): this process is the single writer. If another Nexar process holds
  // the lease, sessions stay unavailable (every session channel answers CONFLICT) instead of racing it.
  const sessionStore = new FileSessionStore(join(userData, '.nexar', 'sessions'));
  let sessions: FileSessionStore | undefined;
  try {
    traceStartup('engine');
    const { interruptedTurns } = await sessionStore.acquireLease();
    traceStartup('sessions');
    sessions = sessionStore;
    if (interruptedTurns > 0) logger.info('marked running turns interrupted', { interruptedTurns });
  } catch (error) {
    if (!isNexarError(error) || error.code !== 'CONFLICT') throw error;
    logger.warn('sessions are open in another Nexar process', { code: error.code });
  }
  let leaseReleased = false;
  app.on('will-quit', (event) => {
    if (sessions === undefined || leaseReleased) return;
    // Best effort: give the lease back before exiting so the next launch needs no stale recovery.
    event.preventDefault();
    leaseReleased = true;
    void sessionStore
      .releaseLease()
      .catch(() => undefined)
      .finally(() => app.quit());
  });

  // The Code lane (ADR-025): Desktop reaches the WSL2 engineering plane through `wsl.exe`. Under the
  // test-only `NEXAR_DESKTOP_USER_DATA` override the real WSL is never touched: the lane uses the
  // fake plane named by `NEXAR_DESKTOP_TEST_PLANE`, or is simply unavailable. Neither variable is
  // ever set in production.
  const testPlane = process.env['NEXAR_DESKTOP_TEST_PLANE'];
  let planeLauncher: PlaneLauncher = createWslLauncher();
  if (userDataOverride !== undefined && userDataOverride !== '') {
    planeLauncher =
      testPlane !== undefined && isAbsolute(testPlane)
        ? createScriptLauncher(testPlane)
        : disabledPlaneLauncher;
  }
  const codePlane = new CodePlane({
    settings,
    launcher: planeLauncher,
    logger,
    decider: decider(),
  });
  app.on('before-quit', () => codePlane.dispose());
  // Non-blocking: the lane reports "still being checked" until the first probe finishes.
  void codePlane.refresh();

  const bridge = createBridge({
    engine,
    config,
    settings,
    providers,
    subscriptions,
    localEndpoints: new LocalEndpointService(config, engine),
    logger,
    // Looked up per call, so a test can replace `dialog.showOpenDialog`.
    dialog: { showOpenDialog: (options) => dialog.showOpenDialog(options) },
    shell,
    appInfo: { version: app.getVersion(), platform: process.platform },
    decider: decider(),
    sessions,
    codePlane,
    // A turn outlives the call that started it; every live window hears about it.
    broadcastSession: (event) => {
      for (const window of BrowserWindow.getAllWindows()) {
        if (!window.isDestroyed() && !window.webContents.isDestroyed()) {
          window.webContents.send(SESSION_EVENT_CHANNEL, event);
        }
      }
    },
  });

  const paths = bundlePaths(import.meta.url);
  let main: BrowserWindow | undefined;

  for (const channel of Object.keys(bridge.table)) {
    ipcMain.handle(channel, (event, args: unknown) => {
      // Only the app's own page, in the main window, may use the bridge.
      if (
        main === undefined ||
        event.sender !== main.webContents ||
        !isTrustedFrameUrl(event.senderFrame?.url, paths.rendererIndex)
      ) {
        return {
          ok: false,
          error: { code: 'POLICY_REJECTED', message: 'Request not accepted from this sender' },
        };
      }
      return bridge.invoke(channel, args, (taskEvent) => {
        if (!event.sender.isDestroyed()) event.sender.send(TASK_EVENT_CHANNEL, taskEvent);
      });
    });
  }

  main = createMainWindow(paths);
  traceStartup('window');
  main.on('closed', () => {
    main = undefined;
  });
}

app.on('window-all-closed', () => {
  app.quit();
});

start().catch((error: unknown) => {
  // Startup failures (a broken config, say) are reported without paths or stacks; a state
  // guard failure adds only its fixed category, phase, exit code and duration.
  const name = error instanceof Error ? error.name : 'unknown error';
  const detail = error instanceof PrivateStateError ? ` ${JSON.stringify(error.diagnostic)}` : '';
  process.stderr.write(`nexar-desktop: startup failed: ${name}${detail}\n`);
  app.exit(1);
});
