import { chmod, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { delimiter, dirname, join } from 'node:path';
import type { Page } from 'playwright-core';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { NexarApi } from '../src/shared/api.js';
import { createHarness, POLL, type Harness } from './harness.js';

/**
 * Drives the real bridge, service and process layers with a fake CLI: no vendor binary, account or
 * network is involved. The fake keeps its sign-in as a file in the home it was given.
 */
const FAKE_CODEX = String.raw`#!${process.platform === 'win32' ? '/usr/bin/env node' : process.execPath}
import { appendFileSync, existsSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
const here = dirname(fileURLToPath(import.meta.url));
const home = process.env.CODEX_HOME;
const args = process.argv.slice(2).join(' ');
const keys = ['OPENAI_API_KEY', 'CODEX_API_KEY'].filter((name) => process.env[name] !== undefined);
appendFileSync(join(here, 'runs.jsonl'), JSON.stringify({ args, home: home ?? null, keys, pid: process.pid }) + '\n');
const signedIn = home !== undefined && existsSync(join(home, 'fake-sign-in'));
if (args === '--version') {
  console.log('codex-cli 0.159.3');
} else if (args === 'login status') {
  console.log(signedIn ? 'Logged in using ChatGPT' : 'Not logged in');
  process.exitCode = signedIn ? 0 : 1;
} else if (args === 'login' && existsSync(join(here, 'hang'))) {
  setInterval(() => undefined, 1000);
} else if (args === 'login') {
  writeFileSync(join(home, 'fake-sign-in'), 'synthetic');
} else {
  process.exitCode = 2;
}
`;

interface Run {
  readonly args: string;
  readonly home: string | null;
  readonly keys: readonly string[];
  readonly pid: number;
}

let harness: Harness;
let bin: string;

beforeAll(async () => {
  harness = await createHarness();
  bin = join(harness.base, 'fake-codex-bin');
  await mkdir(bin, { recursive: true });
  await writeFile(join(bin, 'fake-codex.mjs'), FAKE_CODEX);
  if (process.platform === 'win32') {
    await writeFile(join(bin, 'codex.cmd'), '@"%~dp0\\fake-codex.mjs" %*\r\n');
  } else {
    await writeFile(join(bin, 'package.json'), '{"type":"module"}');
    await writeFile(join(bin, 'codex'), FAKE_CODEX);
    await chmod(join(bin, 'codex'), 0o755);
  }
});
afterAll(async () => {
  await harness.dispose();
});

const launch = (name: string) =>
  harness.launch(harness.newUserData(name), {
    PATH: [bin, dirname(process.execPath), process.env['PATH'] ?? ''].join(delimiter),
    OPENAI_API_KEY: 'sk-synthetic-parent-key-must-not-reach-a-child',
    CODEX_API_KEY: 'sk-synthetic-parent-key-must-not-reach-a-child',
  });

async function runs(): Promise<Run[]> {
  const text = await readFile(join(bin, 'runs.jsonl'), 'utf8').catch(() => '');
  return text
    .split('\n')
    .filter((line) => line !== '')
    .map((line) => JSON.parse(line) as Run);
}

function alive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

/** Calls one bridge method from inside the page, as the renderer would. */
function call<K extends keyof NexarApi>(
  page: Page,
  method: K,
  ...args: Parameters<NexarApi[K]>
): Promise<Awaited<ReturnType<NexarApi[K]>>> {
  return page.evaluate(
    ([name, input]) => {
      const api = (globalThis as unknown as { nexar: Record<string, (...a: unknown[]) => unknown> })
        .nexar;
      return api[name as string]!(...(input as unknown[]));
    },
    [method, args] as const,
  ) as Promise<Awaited<ReturnType<NexarApi[K]>>>;
}

async function add(page: Page, label: string): Promise<string> {
  const added = await call(page, 'addCodexConnection', { label });
  if (!added.ok) throw new Error('Add failed');
  return added.value.id;
}

async function settled(page: Page, connectionId: string): Promise<string | undefined> {
  const status = await call(page, 'codexLoginStatus', { connectionId });
  return status.ok ? status.value.loginState : undefined;
}

async function signIn(page: Page, connectionId: string, sameAccount?: true): Promise<void> {
  const started = await call(page, 'startCodexLogin', {
    connectionId,
    ...(sameAccount === undefined ? {} : { sameAccount }),
  });
  expect(started.ok).toBe(true);
  await expect.poll(() => settled(page, connectionId), POLL).toBe('succeeded');
}

async function resourceIds(page: Page): Promise<string[]> {
  const listed = await call(page, 'listResources', { refresh: true });
  if (!listed.ok) throw new Error('Resource listing failed');
  return listed.value.map((resource) => resource.id);
}

describe('owner Codex connections over the bridge', () => {
  it('signs two connections in, each in its own home, and deletes one home', async () => {
    const { app, page } = await launch('two-homes');
    try {
      const work = await add(page, 'Work');
      const personal = await add(page, 'Personal');
      expect(await resourceIds(page)).not.toContain(`codex:${work}`);

      await signIn(page, work);
      await signIn(page, personal);
      await expect
        .poll(() => resourceIds(page), POLL)
        .toEqual(expect.arrayContaining([`codex:${work}`, `codex:${personal}`]));

      const logins = (await runs()).filter((run) => run.args === 'login');
      expect(logins).toHaveLength(2);
      expect(logins[0]?.home).toContain(work);
      expect(logins[1]?.home).toContain(personal);
      expect((await runs()).every((run) => run.keys.length === 0)).toBe(true);

      const refused = await call(page, 'startCodexLogin', { connectionId: work });
      expect(refused).toMatchObject({ ok: false, error: { code: 'POLICY_REJECTED' } });
      await signIn(page, work, true);
      const listed = await call(page, 'listConnections');
      expect(listed.ok && listed.value.find((row) => row.id === work)).toMatchObject({
        identityAssurance: 'OWNER_ASSERTED_SAME_ACCOUNT',
        hasCredential: true,
      });

      const ticket = await call(page, 'prepareConnectionAction', {
        connectionId: work,
        action: 'delete-home',
      });
      if (!ticket.ok) throw new Error('Prepare failed');
      const deleted = await call(page, 'deleteCodexHome', {
        connectionId: work,
        confirmation: ticket.value.token,
        confirmationName: 'Work',
      });
      expect(deleted).toMatchObject({ ok: true, value: { id: work, hasCredential: false } });
      const after = await resourceIds(page);
      expect(after).not.toContain(`codex:${work}`);
      expect(after).toContain(`codex:${personal}`);
    } finally {
      await harness.close(app);
    }
  });

  it('refuses malformed requests, and nothing crosses but an opaque id', async () => {
    const { app, page } = await launch('validation');
    try {
      const invalid = [
        { connectionId: 'openai.subscription.cabcdefghij', home: 'C:\\elsewhere' },
        { connectionId: '../escape' },
        { connectionId: 'openai.subscription.cabcdefghij', sameAccount: false },
      ];
      for (const args of invalid) {
        const result = await call(page, 'startCodexLogin', args as never);
        expect(result).toMatchObject({ ok: false, error: { code: 'VALIDATION_ERROR' } });
      }
      const builtIn = await call(page, 'startCodexLogin', { connectionId: 'openai.subscription' });
      expect(builtIn).toMatchObject({ ok: false, error: { code: 'POLICY_REJECTED' } });
      const added = await call(page, 'addCodexConnection', { label: 'Work' });
      expect(JSON.stringify(added)).not.toMatch(/runtime-homes|nativeHome|marker/);
    } finally {
      await harness.close(app);
    }
  });

  it('stays busy during a sign-in, cancels it, and leaves no process after quit', async () => {
    await writeFile(join(bin, 'hang'), '');
    const { app, page } = await launch('process-lifecycle');
    let quitPid: number | undefined;
    try {
      const id = await add(page, 'Work');
      expect(await call(page, 'startCodexLogin', { connectionId: id })).toMatchObject({ ok: true });
      await expect
        .poll(
          async () =>
            (await runs()).filter((run) => run.args === 'login' && run.home?.includes(id)).length,
          POLL,
        )
        .toBe(1);
      const first = (await runs()).filter(
        (run) => run.args === 'login' && run.home?.includes(id),
      )[0]!;
      expect(alive(first.pid)).toBe(true);
      expect(await settled(page, id)).toBe('running');

      const ticket = await call(page, 'prepareConnectionAction', {
        connectionId: id,
        action: 'delete-home',
      });
      if (!ticket.ok) throw new Error('Prepare failed');
      const busy = await call(page, 'deleteCodexHome', {
        connectionId: id,
        confirmation: ticket.value.token,
        confirmationName: 'Work',
      });
      expect(busy).toMatchObject({ ok: false, error: { code: 'POLICY_REJECTED' } });

      expect(await call(page, 'cancelCodexLogin', { connectionId: id })).toMatchObject({
        ok: true,
        value: { loginState: 'cancelled' },
      });
      await expect.poll(() => alive(first.pid), POLL).toBe(false);

      await expect
        .poll(async () => (await call(page, 'startCodexLogin', { connectionId: id })).ok, POLL)
        .toBe(true);
      await expect
        .poll(
          async () =>
            (await runs()).filter((run) => run.args === 'login' && run.home?.includes(id)).length,
          POLL,
        )
        .toBe(2);
      quitPid = (await runs()).filter((run) => run.args === 'login' && run.home?.includes(id))[1]!
        .pid;
    } finally {
      await harness.close(app);
      await rm(join(bin, 'hang'));
    }
    await expect.poll(() => alive(quitPid), POLL).toBe(false);
  });
});
