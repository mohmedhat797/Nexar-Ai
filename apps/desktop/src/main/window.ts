import { fileURLToPath, pathToFileURL } from 'node:url';
import { BrowserWindow, app, session, type WebContents } from 'electron';

/** The Content-Security-Policy of every page the app loads (also set as a `<meta>` in index.html). */
export const CONTENT_SECURITY_POLICY = [
  "default-src 'self'",
  "script-src 'self'",
  "style-src 'self' 'unsafe-inline'",
  "img-src 'self' data:",
  "font-src 'self'",
  "connect-src 'none'",
  "object-src 'none'",
  "base-uri 'none'",
  "frame-ancestors 'none'",
].join('; ');

export interface WindowPaths {
  readonly preload: string;
  readonly rendererIndex: string;
}

/** Where the bundles live, relative to `dist/main/main.js`. */
export function bundlePaths(mainUrl: string): WindowPaths {
  return {
    preload: fileURLToPath(new URL('../preload/preload.cjs', mainUrl)),
    rendererIndex: fileURLToPath(new URL('../renderer/index.html', mainUrl)),
  };
}

/** True only for frames of the packaged renderer; the bridge answers nobody else. */
export function isTrustedFrameUrl(url: string | undefined, rendererIndex: string): boolean {
  if (url === undefined) return false;
  const expected = pathToFileURL(rendererIndex).href;
  return url === expected || url.startsWith(`${expected}#`) || url.startsWith(`${expected}?`);
}

/** Session-wide hardening: CSP header, no permissions, nothing but the app's own pages. */
export function hardenSession(): void {
  const { defaultSession } = session;
  defaultSession.webRequest.onHeadersReceived((details, callback) => {
    callback({
      responseHeaders: {
        ...details.responseHeaders,
        'Content-Security-Policy': [CONTENT_SECURITY_POLICY],
      },
    });
  });
  defaultSession.setPermissionRequestHandler((_contents, _permission, callback) => {
    callback(false);
  });
  defaultSession.setPermissionCheckHandler(() => false);
}

/** No navigation away from the app, no new windows, no `<webview>`: for every web contents. */
function lockDown(contents: WebContents): void {
  contents.on('will-navigate', (event) => {
    event.preventDefault();
  });
  contents.on('will-attach-webview', (event) => {
    event.preventDefault();
  });
  contents.setWindowOpenHandler(() => ({ action: 'deny' }));
}

export function installWebContentsLockdown(): void {
  app.on('web-contents-created', (_event, contents) => {
    lockDown(contents);
  });
}

export function createMainWindow(paths: WindowPaths): BrowserWindow {
  const window = new BrowserWindow({
    width: 1440,
    height: 900,
    minWidth: 1100,
    minHeight: 700,
    title: 'Nexar',
    show: false,
    webPreferences: {
      preload: paths.preload,
      sandbox: true,
      contextIsolation: true,
      nodeIntegration: false,
      webSecurity: true,
      spellcheck: false,
    },
  });
  window.setMenuBarVisibility(false);
  window.once('ready-to-show', () => window.show());
  void window.loadFile(paths.rendererIndex);
  return window;
}
