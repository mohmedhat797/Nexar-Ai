import { createHash } from 'node:crypto';
import {
  lstat,
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  realpath,
  rm,
  writeFile,
} from 'node:fs/promises';
import { homedir, tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { _electron as electron, type ElectronApplication, type Page } from 'playwright-core';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { NexarApi } from '../src/shared/api.js';
import { CHANNELS } from '../src/shared/channels.js';

const MAIN = fileURLToPath(new URL('../dist/main/main.js', import.meta.url));
const EXECUTABLE = process.env['NEXAR_DESKTOP_EXECUTABLE'];
const SENTINEL = 'sk-nexar-provider-e2e-secret-must-never-cross-renderer-Q7x9';
const POLL = { timeout: 60_000, interval: 200 };
const OWNER_STATE = join(
  process.platform === 'win32'
    ? (process.env['APPDATA'] ?? join(homedir(), 'AppData', 'Roaming'))
    : process.platform === 'darwin'
      ? join(homedir(), 'Library', 'Application Support')
      : (process.env['XDG_CONFIG_HOME'] ?? join(homedir(), '.config')),
  'Nexar',
);

let base: string;
let userData: string;
let projectDir: string;
let launcher: string;
let trace: string;
let ownerBefore: string;
const apps: ElectronApplication[] = [];
const output: string[] = [];

/** Hash state without printing or retaining its contents; links are never followed. */
async function digestTree(path: string): Promise<string> {
  const digest = createHash('sha256');
  async function visit(current: string): Promise<void> {
    let info;
    try {
      info = await lstat(current);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
        digest.update('missing');
        return;
      }
      throw error;
    }
    digest.update(`${info.mode}:${info.size}:${info.mtimeMs}`);
    if (info.isSymbolicLink()) return;
    if (info.isDirectory()) {
      for (const name of (await readdir(current)).sort()) {
        digest.update(name);
        await visit(join(current, name));
      }
    } else if (info.isFile()) digest.update(await readFile(current));
  }
  await visit(path);
  return digest.digest('hex');
}

async function readOptional(path: string): Promise<string | undefined> {
  try {
    return await readFile(path, 'utf8');
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined;
    throw error;
  }
}

async function assertNoStoredSecret(path: string): Promise<void> {
  for (const entry of await readdir(path, { withFileTypes: true })) {
    const child = join(path, entry.name);
    if (entry.isDirectory()) await assertNoStoredSecret(child);
    else if (entry.isFile() && /\.(json|jsonl|log)$/.test(entry.name)) {
      expect(await readFile(child, 'utf8')).not.toContain(SENTINEL);
    }
  }
}

async function launch(): Promise<{ app: ElectronApplication; page: Page }> {
  const env = Object.fromEntries(
    Object.entries(process.env).filter(
      (entry): entry is [string, string] => entry[1] !== undefined,
    ),
  );
  env['NEXAR_DESKTOP_USER_DATA'] = userData;
  if (EXECUTABLE) {
    delete env['NEXAR_WORKFLOWS_DIR'];
    delete env['NEXAR_ENGINEERING_PLANS_DIR'];
  }
  const app = await electron.launch({
    ...(EXECUTABLE ? { executablePath: EXECUTABLE } : {}),
    args: [
      ...(EXECUTABLE ? [] : [launcher]),
      ...(process.platform === 'linux' ? ['--no-sandbox'] : []),
      '--disable-gpu',
      '--disable-dev-shm-usage',
      ...(process.platform === 'linux' && !process.env['DISPLAY']
        ? ['--ozone-platform=headless']
        : []),
    ],
    env,
    timeout: 120_000,
  });
  apps.push(app);
  app.process().stdout?.on('data', (chunk: Buffer) => output.push(chunk.toString()));
  app.process().stderr?.on('data', (chunk: Buffer) => output.push(chunk.toString()));
  const page = await app.firstWindow();
  page.on('console', (message) => output.push(message.text()));
  page.on('pageerror', (error) => output.push(error.message));
  await page.waitForSelector('.app, [data-testid="open-folder-cta"]', { timeout: 120_000 });
  expect(await app.evaluate(({ app: running }) => running.getPath('userData'))).toBe(userData);
  await app.evaluate(async ({ clipboard }) => {
    // The owner's original clipboard stays in main only.
    (globalThis as unknown as { nexarTestClipboard?: string }).nexarTestClipboard =
      await clipboard.readText();
  });
  return { app, page };
}

async function close(app: ElectronApplication): Promise<void> {
  await app.evaluate(async ({ clipboard }, sentinel) => {
    const saved = globalThis as unknown as { nexarTestClipboard?: string };
    const current = await clipboard.readText();
    if (saved.nexarTestClipboard !== undefined && (current === '' || current === sentinel)) {
      await clipboard.writeText(saved.nexarTestClipboard);
    }
    delete saved.nexarTestClipboard;
  }, SENTINEL);
  await app.close();
  apps.splice(apps.indexOf(app), 1);
}

async function providers(page: Page): Promise<void> {
  await page.getByTestId('nav-settings').click();
  await page.getByRole('tab', { name: 'Providers', exact: true }).click();
  await expect.poll(() => page.getByTestId('provider-deepseek').count(), POLL).toBe(1);
  await expect
    .poll(
      () => page.getByRole('button', { name: 'Refresh providers', exact: true }).isEnabled(),
      POLL,
    )
    .toBe(true);
}

beforeAll(async () => {
  ownerBefore = await digestTree(OWNER_STATE);
  base = await realpath(await mkdtemp(join(tmpdir(), 'nexar-providers-e2e-')));
  userData = join(base, 'userData');
  projectDir = join(base, 'project');
  launcher = join(base, 'main-fixture.mjs');
  trace = join(userData, 'ipc-trace.jsonl');
  await mkdir(projectDir);
  // Record real IPC through a public API wrapper in a temporary launcher, never production code.
  await writeFile(
    launcher,
    `
import { ipcMain } from 'electron';
import { appendFileSync } from 'node:fs';
const handlers = new Map();
const checked = new Set();
globalThis.nexarTestHandlers = handlers;
const register = ipcMain.handle.bind(ipcMain);
ipcMain.handle = (channel, handler) => {
  const recording = async (event, ...args) => {
    let value;
    if (channel === 'providers:checkKey') {
      // UI binding only: the real provider service has separate fake-HTTP tests.
      const provider = args[0]?.provider;
      const listed = await handlers.get(${JSON.stringify(CHANNELS.providersList)})(event, {});
      const row = listed.ok && listed.value.find((candidate) => candidate.provider === provider);
      if (!row || row.status !== 'saved') throw new Error('Fixture requires a saved provider');
      await new Promise((resolve) => { globalThis.nexarTestCheckRelease = resolve; });
      delete globalThis.nexarTestCheckRelease;
      checked.add(provider);
      value = { ok: true, value: { ...row, keyCheckStatus: 'valid' } };
    } else {
      value = await handler(event, ...args);
      if (value.ok && (channel === ${JSON.stringify(CHANNELS.providersSaveKeyFromClipboard)} || channel === ${JSON.stringify(CHANNELS.providersRemoveKey)})) checked.delete(args[0]?.provider);
      if (value.ok && channel === ${JSON.stringify(CHANNELS.providersList)}) value = { ...value, value: value.value.map((row) => checked.has(row.provider) && row.status === 'saved' ? { ...row, keyCheckStatus: 'valid' } : row) };
    }
    appendFileSync(${JSON.stringify(trace)}, JSON.stringify({ channel, args, value }) + '\\n', { mode: 0o600 });
    return value;
  };
  handlers.set(channel, recording);
  register(channel, recording);
};
await import(${JSON.stringify(pathToFileURL(MAIN).href)});
`,
    { mode: 0o600 },
  );
});

afterAll(async () => {
  for (const app of [...apps]) await close(app);
  expect(await digestTree(OWNER_STATE)).toBe(ownerBefore);
  if (base !== undefined) await rm(base, { recursive: true, force: true });
});

describe('Desktop Providers', () => {
  it('stores a clipboard key privately, preserves the conversation and removes the key', async () => {
    let { app, page } = await launch();
    await app.evaluate(({ dialog }, dir) => {
      dialog.showOpenDialog = () => Promise.resolve({ canceled: false, filePaths: [dir] });
    }, projectDir);
    await page.getByRole('button', { name: 'Open folder as project…' }).first().click();
    await page.getByLabel('Message').fill('Outline a quiet milestone');
    await page.getByRole('button', { name: 'Send', exact: true }).click();
    await expect.poll(() => page.getByTestId('result-text').count(), POLL).toBe(1);
    const originalConversation = await page.getByTestId('conversation-item').first().innerText();
    await providers(page);
    expect(await page.locator('input[type="password"], input[type="text"]').count()).toBe(0);
    expect(await page.getByTestId('providers-list').innerText()).toContain('Network: Not checked');
    const backend = await app.evaluate(({ safeStorage }) => ({
      available: safeStorage.isEncryptionAvailable(),
      backend: process.platform === 'linux' ? safeStorage.getSelectedStorageBackend() : 'os',
    }));
    const secure =
      backend.available &&
      ['os', 'gnome_libsecret', 'kwallet', 'kwallet5', 'kwallet6'].includes(backend.backend);
    const row = page.getByTestId('provider-deepseek');
    expect(await row.getByRole('button', { name: 'Check DeepSeek API key' }).isDisabled()).toBe(
      true,
    );
    if (!secure) {
      expect(await row.innerText()).toContain('Unavailable');
      expect(
        await row
          .getByRole('button', { name: 'Save DeepSeek API key from clipboard' })
          .isDisabled(),
      ).toBe(true);
      await app.evaluate(async ({ clipboard }, key) => {
        await clipboard.writeText(key);
      }, SENTINEL);
      const refused = await page.evaluate(async () => {
        const api = (globalThis as unknown as { nexar: NexarApi }).nexar;
        return api.saveProviderKeyFromClipboard('deepseek');
      });
      expect(refused).toMatchObject({ ok: false });
      expect(JSON.stringify(refused)).not.toContain(SENTINEL);
      expect(await readOptional(join(userData, 'credentials.json'))).toBeUndefined();
      await assertNoStoredSecret(userData);
      expect(await page.locator('body').innerText()).not.toContain(SENTINEL);
      expect(output.join('\n')).not.toContain(SENTINEL);
      await close(app);
      return;
    }

    await app.evaluate(async ({ clipboard }, key) => {
      await clipboard.writeText(key);
    }, SENTINEL);
    await row.getByRole('button', { name: 'Save DeepSeek API key from clipboard' }).click();
    await expect.poll(() => row.innerText(), POLL).toContain('ending in Q7x9');
    await expect
      .poll(() => page.getByTestId('provider-status').innerText(), POLL)
      .toContain('DeepSeek API key saved.');
    await expect
      .poll(() => page.getByRole('button', { name: 'Refresh providers' }).isEnabled(), POLL)
      .toBe(true);
    expect(await row.innerText()).toContain('Saved');
    expect(await row.innerText()).toContain('Catalog models:');
    expect(await row.innerText()).toContain('pi-ai');
    expect(await row.innerText()).toContain('DeepSeek Harness');
    expect(await row.innerText()).toContain('Network: Not checked');
    if (!EXECUTABLE) {
      await row.getByRole('button', { name: 'Check DeepSeek API key' }).click();
      await expect
        .poll(
          () =>
            app.evaluate(
              () =>
                typeof (globalThis as unknown as { nexarTestCheckRelease?: unknown })
                  .nexarTestCheckRelease === 'function',
            ),
          POLL,
        )
        .toBe(true);
      const controls = page
        .getByRole('region', { name: 'Providers', exact: true })
        .getByRole('button');
      expect(await controls.count()).toBeGreaterThan(0);
      for (const button of await controls.all()) expect(await button.isDisabled()).toBe(true);
      await app.evaluate(() => {
        (globalThis as unknown as { nexarTestCheckRelease: () => void }).nexarTestCheckRelease();
      });
      await expect.poll(() => row.innerText(), POLL).toContain('Network: Metadata access verified');
      await expect
        .poll(() => page.getByRole('button', { name: 'Refresh providers' }).isEnabled(), POLL)
        .toBe(true);
      expect(
        await page.getByRole('region', { name: 'Providers', exact: true }).innerText(),
      ).toContain('It performs no generation');
    }
    expect(await app.evaluate(async ({ clipboard }) => clipboard.readText())).toBe('');
    const ciphertext = await readFile(join(userData, 'credentials.json'), 'utf8');
    expect(ciphertext).not.toContain(SENTINEL);
    const metadata = await page.evaluate(async () =>
      (globalThis as unknown as { nexar: NexarApi }).nexar.listProviders(),
    );
    expect(metadata).toMatchObject({ ok: true });
    expect(JSON.stringify(metadata)).not.toContain(SENTINEL);
    expect(await page.locator('body').innerText()).not.toContain(SENTINEL);
    await assertNoStoredSecret(userData);

    // Reopening proves both key metadata and the conversation survive a real host restart.
    await close(app);
    ({ app, page } = await launch());
    await providers(page);
    const reopened = page.getByTestId('provider-deepseek');
    await expect.poll(() => reopened.innerText(), POLL).toContain('ending in Q7x9');
    await reopened.getByRole('button', { name: 'Remove DeepSeek API key' }).click();
    await expect.poll(() => reopened.innerText(), POLL).toContain('Not saved');
    await expect
      .poll(() => page.getByRole('button', { name: 'Refresh providers' }).isEnabled(), POLL)
      .toBe(true);
    expect(await reopened.innerText()).not.toContain('Q7x9');
    expect(await reopened.innerText()).toContain('Network: Not checked');
    expect(
      await reopened.getByRole('button', { name: 'Check DeepSeek API key' }).isDisabled(),
    ).toBe(true);
    expect(
      await reopened.getByRole('button', { name: 'Remove DeepSeek API key' }).isDisabled(),
    ).toBe(true);
    const remaining = await readOptional(join(userData, 'credentials.json'));
    expect(remaining === undefined || !remaining.includes('Q7x9')).toBe(true);
    await page.getByTestId('nav-chat').click();
    await page.getByTestId('conversation-item').filter({ hasText: originalConversation }).click();
    await expect.poll(() => page.getByTestId('result-text').count(), POLL).toBe(1);
    await page.getByLabel('Message').fill('Outline the next quiet milestone');
    await page.getByRole('button', { name: 'Send', exact: true }).click();
    await expect.poll(() => page.getByTestId('result-text').count(), POLL).toBe(2);
    expect(await page.getByTestId('conversation-item').count()).toBe(1);

    if (!EXECUTABLE) {
      // Exercise strict unknown-field rejection through the actual main handler and sender.
      const invalid = await app.evaluate(async ({ BrowserWindow }, channel) => {
        const contents = BrowserWindow.getAllWindows()[0]?.webContents;
        if (contents === undefined) throw new Error('No application window');
        const handlers = (
          globalThis as unknown as {
            nexarTestHandlers: Map<string, (event: unknown, args: unknown) => Promise<unknown>>;
          }
        ).nexarTestHandlers;
        const handler = handlers.get(channel);
        if (handler === undefined) throw new Error('No provider handler');
        return handler(
          { sender: contents, senderFrame: contents.mainFrame },
          { provider: 'deepseek', extra: true },
        );
      }, CHANNELS.providersSaveKeyFromClipboard);
      expect(invalid).toMatchObject({ ok: false, error: { code: 'VALIDATION_ERROR' } });
      const frames = (await readFile(trace, 'utf8'))
        .trim()
        .split('\n')
        .map(
          (line) =>
            JSON.parse(line) as {
              channel: string;
              args: unknown[];
              value: unknown;
            },
        );
      expect(frames.length).toBeGreaterThan(0);
      const channels = Object.values(CHANNELS);
      for (const frame of frames) {
        expect(Object.keys(frame).sort()).toEqual(['args', 'channel', 'value']);
        expect(channels).toContain(frame.channel);
        expect(JSON.stringify(frame)).not.toContain(SENTINEL);
      }
      expect(
        frames.some(
          (frame) =>
            frame.channel === CHANNELS.providersSaveKeyFromClipboard &&
            JSON.stringify(frame.args) === JSON.stringify([{ provider: 'deepseek' }]),
        ),
      ).toBe(true);
      expect(frames.some((frame) => frame.channel === CHANNELS.providersRemoveKey)).toBe(true);
      expect(
        frames.some(
          (frame) =>
            frame.channel === 'providers:checkKey' &&
            JSON.stringify(frame.args) === JSON.stringify([{ provider: 'deepseek' }]),
        ),
      ).toBe(true);
    }
    await assertNoStoredSecret(userData);
    expect(output.join('\n')).not.toContain(SENTINEL);
    await close(app);
  });
});
