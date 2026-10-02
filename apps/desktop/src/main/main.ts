import { userInfo } from 'node:os';
import { join, resolve } from 'node:path';
import { app, dialog, ipcMain, shell, type BrowserWindow } from 'electron';
import { TASK_EVENT_CHANNEL } from '../shared/channels.js';
import { createBridge } from './bridge.js';
import { ConfigStore } from './config-store.js';
import { createEngineHost } from './engine-host.js';
import { createStderrLogger } from './logger.js';
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
app.setPath(
  'userData',
  userDataOverride !== undefined && userDataOverride !== ''
    ? resolve(userDataOverride)
    : join(app.getPath('appData'), 'Nexar'),
);

function decider(): string {
  try {
    return `desktop:${userInfo().username}`;
  } catch {
    return 'desktop:unknown';
  }
}

async function start(): Promise<void> {
  const userData = app.getPath('userData');
  await ensurePrivateStateDirectory(userData, { forbiddenPaths: [app.getPath('appData')] });
  await app.whenReady();
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
  const engine = await createEngineHost({ configPath: config.path, env: engineEnv, logger });
  const bridge = createBridge({
    engine,
    config,
    settings,
    logger,
    // Looked up per call, so a test can replace `dialog.showOpenDialog`.
    dialog: { showOpenDialog: (options) => dialog.showOpenDialog(options) },
    shell,
    appInfo: { version: app.getVersion(), platform: process.platform },
    decider: decider(),
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
