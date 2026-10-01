import { userInfo } from 'node:os';
import { join, resolve } from 'node:path';
import { app, dialog, ipcMain, shell, type BrowserWindow } from 'electron';
import { TASK_EVENT_CHANNEL } from '../shared/channels.js';
import { createBridge } from './bridge.js';
import { ConfigStore } from './config-store.js';
import { createEngineHost } from './engine-host.js';
import { createStderrLogger } from './logger.js';
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
  await app.whenReady();
  hardenSession();
  installWebContentsLockdown();

  const userData = app.getPath('userData');
  const logger = createStderrLogger();
  const config = new ConfigStore(join(userData, 'nexar.config.json'));
  await config.ensure();
  const settings = new SettingsStore(join(userData, 'desktop-settings.json'));
  const engine = await createEngineHost({ configPath: config.path, env: process.env, logger });
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
  // Startup failures (a broken config, say) are reported without paths or stacks.
  process.stderr.write(
    `nexar-desktop: startup failed: ${error instanceof Error ? error.name : 'unknown error'}\n`,
  );
  app.exit(1);
});
