import { rm } from 'node:fs/promises';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Logger } from '@nexar/contracts';
import { createOpenAiAccountClient } from '@nexar/integration-openai-account';
import {
  FAKE_SUB,
  startFakeAuthServer,
  type FakeAuthServer,
} from '@nexar/integration-openai-account/testing';
import { CHANNELS } from '../shared/channels.js';
import { ChatGptPlanStatusSchema } from '../shared/chatgpt-plan.js';
import {
  ChatGptPlanService,
  CHATGPT_PLAN_CONNECTION,
  type ChatGptPlanDeps,
} from './chatgpt-plan.js';
import { SigninCallbackSupervisor } from './signin-callback-child.js';
import { bundleSigninChild } from './signin-test-kit.js';
import { createBridge } from './bridge.js';
import { createHarness, type Harness } from './test-harness.js';

const INSTALLATION = '00000000-0000-4000-8000-000000000001';

let kit: Awaited<ReturnType<typeof bundleSigninChild>>;
beforeAll(async () => {
  kit = await bundleSigninChild();
}, 60_000);
afterAll(async () => {
  await rm(kit.dir, { recursive: true, force: true });
});

function fakeKeys() {
  const blobs = new Map<string, string>();
  const state = {
    available: true,
    saves: 0,
    get blob(): string | undefined {
      return blobs.get(CHATGPT_PLAN_CONNECTION);
    },
    set blob(value: string | undefined) {
      if (value === undefined) blobs.delete(CHATGPT_PLAN_CONNECTION);
      else blobs.set(CHATGPT_PLAN_CONNECTION, value);
    },
    availability: (): boolean => state.available,
    saveBlob: (name: string, value: string): Promise<void> => {
      if (name === CHATGPT_PLAN_CONNECTION) state.saves += 1;
      blobs.set(name, value);
      return Promise.resolve();
    },
    readBlob: (name: string): string | undefined => blobs.get(name),
    removeBlob: (name: string): Promise<void> => {
      blobs.delete(name);
      return Promise.resolve();
    },
  };
  return state;
}

function recordingLogger(): { logger: Logger; text: () => string } {
  const records: unknown[] = [];
  const logger: Logger = {
    debug: (msg, fields) => void records.push([msg, fields]),
    info: (msg, fields) => void records.push([msg, fields]),
    warn: (msg, fields) => void records.push([msg, fields]),
    error: (msg, fields) => void records.push([msg, fields]),
    child: () => logger,
  };
  return { logger, text: () => JSON.stringify(records) };
}

let fake: FakeAuthServer;
let keys: ReturnType<typeof fakeKeys>;
let log: ReturnType<typeof recordingLogger>;
let opened: string[];
let now: number;
let browse: (url: string) => Promise<void>;
let services: ChatGptPlanService[];

function make(overrides: Partial<ChatGptPlanDeps> = {}, timeoutMs?: number): ChatGptPlanService {
  const service = new ChatGptPlanService({
    keys,
    callback: new SigninCallbackSupervisor({
      launch: kit.launch,
      ...(timeoutMs === undefined ? {} : { timeoutMs }),
    }),
    openExternal: (url) => {
      opened.push(url);
      return browse(url);
    },
    installationId: () => Promise.resolve(INSTALLATION),
    logger: log.logger,
    client: createOpenAiAccountClient({ issuer: fake.issuer, timeoutMs: 3000 }),
    clock: () => now,
    ...overrides,
  });
  services.push(service);
  return service;
}

beforeEach(async () => {
  fake = await startFakeAuthServer();
  keys = fakeKeys();
  log = recordingLogger();
  opened = [];
  now = Date.now();
  services = [];
  // The owner's browser: follows the authorize URL, which redirects to the loopback callback.
  browse = (url) => {
    void fetch(url)
      .then((response) => response.text())
      .catch(() => undefined);
    return Promise.resolve();
  };
});
afterEach(async () => {
  for (const service of services) service.dispose();
  await fake.close();
});

function decode(blob: string | undefined): Record<string, unknown> {
  return JSON.parse(Buffer.from(blob ?? '', 'base64url').toString('utf8')) as Record<
    string,
    unknown
  >;
}

const refreshes = (): Record<string, string>[] =>
  fake.tokenRequests.filter((form) => form['grant_type'] === 'refresh_token');

async function rejection(promise: Promise<unknown>): Promise<Error> {
  try {
    await promise;
  } catch (error) {
    return error as Error;
  }
  throw new Error('expected a rejection');
}

describe('connect', () => {
  it('signs in through the child, stores the tokens encrypted, and reports a safe status', async () => {
    const service = make();
    const status = await service.connect();
    expect(status).toMatchObject({ state: 'connected', planSharing: true });
    expect(ChatGptPlanStatusSchema.safeParse(status).success).toBe(true);

    const authorize = new URL(opened[0] ?? '');
    expect(Object.fromEntries(authorize.searchParams)).toMatchObject({
      client_id: 'dynamic_agent_client',
      agent_name_hint: 'Nexar',
      ext_agent_host_id: `urn:uuid:${INSTALLATION}`,
      code_challenge_method: 'S256',
    });
    const redirect = new URL(authorize.searchParams.get('redirect_uri') ?? '');
    expect(redirect.hostname).toBe('127.0.0.1');
    expect(redirect.pathname).toBe('/callback');

    expect(decode(keys.blob)).toMatchObject({
      v: 1,
      clientId: 'oaiapp_fake_client',
      sub: FAKE_SUB,
      accessToken: 'access-token-sentinel-2',
      refreshToken: 'refresh-token-sentinel-2',
    });
    expect(fake.tokenRequests[0]).toMatchObject({
      grant_type: 'authorization_code',
      client_id: 'oaiapp_fake_client',
    });
    // The callback child is gone once the sign-in is over.
    await expect(fetch(redirect.toString())).rejects.toThrow();
    await expect(service.accessToken()).resolves.toBe('access-token-sentinel-2');
  });

  it('never puts a token, code, verifier, subject or client id in the status or the logs', async () => {
    const service = make();
    const status = await service.connect();
    const sentinels = [
      'access-token-sentinel',
      'refresh-token-sentinel',
      'code-sentinel',
      FAKE_SUB,
      'oaiapp_',
      INSTALLATION,
      fake.tokenRequests[0]?.['code_verifier'] ?? 'missing',
      new URL(opened[0] ?? '').searchParams.get('state') ?? 'missing',
      new URL(opened[0] ?? '').searchParams.get('nonce') ?? 'missing',
      '@',
    ];
    await service.accessToken();
    now += 59 * 60 * 1000;
    await service.accessToken();
    await service.disconnect();
    const surface = `${JSON.stringify(status)}${JSON.stringify(await service.status())}${log.text()}`;
    for (const sentinel of sentinels) expect(surface).not.toContain(sentinel);
  });

  it('opens only the authorization page of the configured issuer', async () => {
    const evil = {
      ...createOpenAiAccountClient({ issuer: fake.issuer }),
      authorizeUrl: () => 'https://evil.example/authorize',
    };
    const service = make({ client: evil });
    const error = await rejection(service.connect());
    expect(error).toMatchObject({ code: 'PROVIDER_ERROR' });
    expect(opened).toEqual([]);
    expect(keys.blob).toBeUndefined();
    expect(await service.status()).toMatchObject({ state: 'error', reason: 'failed' });
  });

  it('refuses when the key store is unavailable, with the existing fixed error', async () => {
    keys.available = false;
    const service = make();
    const error = await rejection(service.connect());
    expect(error).toMatchObject({ code: 'AUTH_REQUIRED' });
    expect(opened).toEqual([]);
    expect(keys.saves).toBe(0);
    expect(await service.status()).toMatchObject({
      state: 'error',
      reason: 'key-store-unavailable',
    });
  });

  it('refuses a second sign-in while one is running', async () => {
    let release: () => void = () => undefined;
    browse = () => {
      release = () => void fetch(opened[0] ?? '').catch(() => undefined);
      return Promise.resolve();
    };
    const service = make();
    const first = service.connect();
    await vi.waitFor(() => expect(opened).toHaveLength(1));
    expect(await service.status()).toMatchObject({ state: 'signing-in' });
    await expect(service.connect()).rejects.toMatchObject({ code: 'CONFLICT' });
    release();
    await expect(first).resolves.toMatchObject({ state: 'connected' });
    expect(opened).toHaveLength(1);
  });

  it('cancel ends the sign-in and its child and leaves nothing stored', async () => {
    browse = () => Promise.resolve();
    const service = make();
    const connecting = service.connect();
    await vi.waitFor(() => expect(opened).toHaveLength(1));
    const redirect = new URL(new URL(opened[0] ?? '').searchParams.get('redirect_uri') ?? '');
    const cancelled = await service.cancel();
    expect(cancelled).toMatchObject({ state: 'signed-out', reason: 'cancelled' });
    await expect(connecting).resolves.toMatchObject({ state: 'signed-out', reason: 'cancelled' });
    await expect(fetch(redirect.toString())).rejects.toThrow();
    expect(keys.blob).toBeUndefined();
    expect(fake.tokenRequests).toHaveLength(0);
  });

  it('cancel without a sign-in is harmless', async () => {
    expect(await make().cancel()).toMatchObject({ state: 'signed-out' });
  });

  it('reports a declined authorization as denied and stores nothing', async () => {
    fake.denyNextAuthorize = true;
    const service = make();
    await expect(service.connect()).rejects.toMatchObject({ code: 'PROVIDER_ERROR' });
    expect(await service.status()).toMatchObject({ state: 'error', reason: 'denied' });
    expect(keys.blob).toBeUndefined();
    expect(fake.tokenRequests).toHaveLength(0);
  });

  it('rejects an ID token with the wrong nonce or a bad signature and stores nothing', async () => {
    for (const setup of [
      () => (fake.idClaims = { nonce: 'not-ours' }),
      () => (fake.signWithUnlistedKey = true),
    ]) {
      fake.idClaims = {};
      fake.signWithUnlistedKey = false;
      setup();
      const service = make();
      await expect(service.connect()).rejects.toMatchObject({ code: 'AUTH_REQUIRED' });
      expect(keys.blob).toBeUndefined();
      expect(await service.status()).toMatchObject({ state: 'error' });
    }
  });

  it('stores an identity-only grant but reports planSharing false', async () => {
    fake.scope = 'openid profile email offline_access';
    const status = await make().connect();
    expect(status).toMatchObject({ state: 'connected', planSharing: false });
  });

  it('times out when the owner never finishes and ends the child', async () => {
    browse = () => Promise.resolve();
    const service = make({}, 300);
    await expect(service.connect()).rejects.toMatchObject({ code: 'PROVIDER_ERROR' });
    expect(await service.status()).toMatchObject({ state: 'error', reason: 'timeout' });
    expect(keys.blob).toBeUndefined();
  });

  it('can sign in again after a failure', async () => {
    fake.denyNextAuthorize = true;
    const service = make();
    await expect(service.connect()).rejects.toBeDefined();
    await expect(service.connect()).resolves.toMatchObject({ state: 'connected' });
  });

  it('dispose ends a running sign-in', async () => {
    browse = () => Promise.resolve();
    const service = make();
    const connecting = service.connect();
    await vi.waitFor(() => expect(opened).toHaveLength(1));
    service.dispose();
    await expect(connecting).resolves.toMatchObject({ state: 'signed-out', reason: 'cancelled' });
    await expect(service.connect()).rejects.toMatchObject({ code: 'CONFLICT' });
  });
});

describe('accessToken', () => {
  it('returns the stored token without a network call while it is fresh', async () => {
    const service = make();
    await service.connect();
    now += 56 * 60 * 1000;
    await expect(service.accessToken()).resolves.toBe('access-token-sentinel-2');
    expect(refreshes()).toHaveLength(0);
  });

  it('refreshes once for many concurrent callers and stores the rotated refresh token', async () => {
    const service = make();
    await service.connect();
    const before = decode(keys.blob);
    now += 58 * 60 * 1000;
    const tokens = await Promise.all(Array.from({ length: 6 }, () => service.accessToken()));
    expect(new Set(tokens).size).toBe(1);
    expect(tokens[0]).not.toBe('access-token-sentinel-2');
    expect(refreshes()).toHaveLength(1);
    expect(refreshes()[0]).toMatchObject({
      client_id: 'oaiapp_fake_client',
      refresh_token: before['refreshToken'],
    });
    const after = decode(keys.blob);
    expect(after['refreshToken']).not.toBe(before['refreshToken']);
    expect(after['accessToken']).toBe(tokens[0]);
    expect(after['clientId']).toBe(before['clientId']);
    expect(after['sub']).toBe(FAKE_SUB);
    // The new expiry is counted from the refresh.
    expect(after['expiresAt']).toBe(now + 3600 * 1000);
    // The rotated-out token is not reused: a second refresh uses the new one.
    now += 58 * 60 * 1000;
    await service.accessToken();
    expect(refreshes()[1]?.['refresh_token']).toBe(after['refreshToken']);
  });

  it('clears the connection when the refresh token is rejected', async () => {
    const service = make();
    await service.connect();
    now += 59 * 60 * 1000;
    fake.tokenReply = () => ({ status: 400, body: { error: 'refresh_token_expired' } });
    await expect(service.accessToken()).rejects.toMatchObject({ code: 'AUTH_REQUIRED' });
    expect(keys.blob).toBeUndefined();
    expect(await service.status()).toMatchObject({ state: 'signed-out', reason: 'expired' });
    await expect(service.accessToken()).rejects.toMatchObject({ code: 'AUTH_REQUIRED' });
  });

  it('keeps the connection and throws PROVIDER_ERROR on a network or server failure', async () => {
    const service = make();
    await service.connect();
    const stored = keys.blob;
    now += 59 * 60 * 1000;
    fake.tokenReply = () => ({ status: 503, body: { error: 'temporarily_unavailable' } });
    await expect(service.accessToken()).rejects.toMatchObject({ code: 'PROVIDER_ERROR' });
    expect(keys.blob).toBe(stored);
    expect(await service.status()).toMatchObject({ state: 'connected' });
    fake.tokenReply = undefined as never;
    await expect(service.accessToken()).resolves.toMatch(/^access-token-sentinel-/);
  });

  it('normalizes an upstream timeout to PROVIDER_ERROR', async () => {
    const service = make({
      client: createOpenAiAccountClient({ issuer: fake.issuer, timeoutMs: 50 }),
    });
    await service.connect().catch(() => undefined);
    const connected = make();
    await connected.connect();
    now += 59 * 60 * 1000;
    fake.tokenDelayMs = 300;
    const slow = make({
      client: createOpenAiAccountClient({ issuer: fake.issuer, timeoutMs: 50 }),
    });
    await expect(slow.accessToken()).rejects.toMatchObject({ code: 'PROVIDER_ERROR' });
  });

  it('rejects unverifiable refresh identity without overwriting the established tokens', async () => {
    const service = make();
    await service.connect();
    const before = decode(keys.blob);
    now += 59 * 60 * 1000;
    fake.tokenReply = (form) =>
      form['grant_type'] === 'refresh_token'
        ? {
            status: 200,
            body: {
              access_token: 'access-token-sentinel-9',
              refresh_token: 'refresh-token-sentinel-9',
              expires_in: 3600,
              id_token: 'not-a-jwt',
            },
          }
        : undefined;
    await expect(service.accessToken()).rejects.toMatchObject({ code: 'AUTH_REQUIRED' });
    expect(decode(keys.blob)).toEqual(before);
  });

  it('refuses when nothing is connected', async () => {
    await expect(make().accessToken()).rejects.toMatchObject({ code: 'AUTH_REQUIRED' });
  });
});

describe('disconnect and status', () => {
  it('blocks status, token access and reconnect while stored credential removal is pending', async () => {
    const onChanging = vi.fn();
    const onChange = vi.fn();
    const service = make({ onChanging, onChange });
    await service.connect();
    onChanging.mockClear();
    onChange.mockClear();
    let removalStarted!: () => void;
    const started = new Promise<void>((resolve) => {
      removalStarted = resolve;
    });
    let releaseRemoval!: () => void;
    const removal = new Promise<void>((resolve) => {
      releaseRemoval = resolve;
    });
    vi.spyOn(keys, 'removeBlob').mockImplementation(async () => {
      removalStarted();
      await removal;
      keys.blob = undefined;
    });
    const disconnecting = service.disconnect();
    await started;
    try {
      expect(keys.blob).toBeDefined();
      expect(await service.status()).toMatchObject({ state: 'signed-out' });
      await expect(service.accessToken()).rejects.toMatchObject({ code: 'AUTH_REQUIRED' });
      await expect(service.accessToken({ refresh: true })).rejects.toMatchObject({
        code: 'AUTH_REQUIRED',
      });
      await expect(service.connect()).rejects.toMatchObject({ code: 'CONFLICT' });
      expect(opened).toHaveLength(1);
      expect(refreshes()).toHaveLength(0);
      expect(onChanging).toHaveBeenCalledOnce();
      expect(onChange).not.toHaveBeenCalled();
    } finally {
      releaseRemoval();
      await disconnecting;
    }
    expect(keys.blob).toBeUndefined();
    expect(await service.status()).toMatchObject({ state: 'signed-out', reason: 'disconnected' });
    expect(onChanging).toHaveBeenCalledTimes(2);
    expect(onChange).toHaveBeenCalledOnce();
    expect(onChanging.mock.calls).toEqual([[], []]);
    expect(onChange.mock.calls).toEqual([[]]);
  });

  it('deletes the stored tokens and points at ChatGPT settings for revocation', async () => {
    const service = make();
    await service.connect();
    const status = await service.disconnect();
    expect(keys.blob).toBeUndefined();
    expect(status).toMatchObject({ state: 'signed-out', reason: 'disconnected' });
    expect(status.message).toContain('ChatGPT settings');
    await expect(service.accessToken()).rejects.toMatchObject({ code: 'AUTH_REQUIRED' });
    expect(await service.status()).toMatchObject({ state: 'signed-out', reason: 'disconnected' });
  });

  it('reports a fresh install as signed out with no reason', async () => {
    const status = await make().status();
    expect(status).toEqual({ state: 'signed-out', message: 'Not connected.' });
  });

  it('survives a restart: a new service sees the stored connection', async () => {
    await make().connect();
    expect(await make().status()).toMatchObject({ state: 'connected', planSharing: true });
  });

  it('reports an unreadable stored record as a storage error and lets the owner clear it', async () => {
    keys.blob = undefined;
    await keys.saveBlob(
      CHATGPT_PLAN_CONNECTION,
      Buffer.from('{"v":2}').toString('base64url').padEnd(20, 'A'),
    );
    const service = make();
    expect(await service.status()).toMatchObject({
      state: 'error',
      reason: 'key-store-unavailable',
    });
    expect(await service.disconnect()).toMatchObject({ state: 'signed-out' });
    expect(keys.blob).toBeUndefined();
  });

  it('disconnect during a sign-in cancels it first', async () => {
    browse = () => Promise.resolve();
    const service = make();
    const connecting = service.connect();
    await vi.waitFor(() => expect(opened).toHaveLength(1));
    await service.disconnect();
    await expect(connecting).resolves.toMatchObject({ state: 'signed-out' });
    expect(keys.blob).toBeUndefined();
  });
});

describe('IPC channels', () => {
  let h: Harness;
  beforeEach(async () => {
    h = await createHarness();
  });
  afterEach(async () => {
    await h.cleanup();
  });

  const call = (service: ChatGptPlanService | undefined, channel: string, args: unknown = {}) =>
    createBridge({ ...h.deps, ...(service === undefined ? {} : { chatgptPlan: service }) }).invoke(
      channel,
      args,
      () => undefined,
    );

  const CHANNEL_NAMES = [
    CHANNELS.chatgptPlanStatus,
    CHANNELS.chatgptPlanConnect,
    CHANNELS.chatgptPlanCancel,
    CHANNELS.chatgptPlanDisconnect,
  ];

  it('are named providers:* and take no arguments', async () => {
    for (const channel of CHANNEL_NAMES) {
      expect(channel.startsWith('providers:chatgptPlan')).toBe(true);
      for (const bad of [{ code: 'x' }, { url: 'https://example.com' }, 'text', 7, null, [1]]) {
        const result = await call(make(), channel, bad);
        expect(result.ok).toBe(false);
        if (!result.ok) expect(result.error.code).toBe('VALIDATION_ERROR');
      }
    }
    expect(fake.tokenRequests).toHaveLength(0);
    expect(opened).toEqual([]);
  });

  /** Polls `status` (as the renderer does) until it leaves `signing-in`. */
  async function settled(service: ChatGptPlanService | undefined) {
    for (let i = 0; i < 200; i += 1) {
      const result = await call(service, CHANNELS.chatgptPlanStatus);
      if (!result.ok || (result.value as { state: string }).state !== 'signing-in') return result;
      await new Promise((resolve) => setTimeout(resolve, 25));
    }
    throw new Error('sign-in did not settle');
  }

  it('answer with the status DTO only, through connect, status, cancel and disconnect', async () => {
    const service = make();
    // Connect answers at once; the outcome arrives through status.
    const started = await call(service, CHANNELS.chatgptPlanConnect);
    expect(started).toMatchObject({ ok: true, value: { state: 'signing-in' } });
    const connected = await settled(service);
    expect(connected).toMatchObject({ ok: true, value: { state: 'connected', planSharing: true } });
    const status = await call(service, CHANNELS.chatgptPlanStatus);
    expect(status).toEqual(connected);
    expect(await call(service, CHANNELS.chatgptPlanCancel)).toEqual(connected);
    const gone = await call(service, CHANNELS.chatgptPlanDisconnect);
    expect(gone).toMatchObject({
      ok: true,
      value: { state: 'signed-out', reason: 'disconnected' },
    });
    for (const result of [started, connected, status, gone]) {
      if (!result.ok) throw new Error('expected ok');
      expect(ChatGptPlanStatusSchema.safeParse(result.value).success).toBe(true);
      const text = JSON.stringify(result);
      for (const secret of ['sentinel', 'oaiapp_', 'http', INSTALLATION]) {
        expect(text).not.toContain(secret);
      }
    }
  });

  it('turn failures into a fixed error without a token, code or URL', async () => {
    fake.denyNextAuthorize = true;
    const service = make();
    expect(await call(service, CHANNELS.chatgptPlanConnect)).toMatchObject({
      ok: true,
      value: { state: 'signing-in' },
    });
    const result = await settled(service);
    expect(result).toMatchObject({ ok: true, value: { state: 'error' } });
    expect(JSON.stringify(result)).not.toContain('127.0.0.1');
  });

  it('fail closed when the service is not wired', async () => {
    for (const channel of CHANNEL_NAMES) {
      expect(await call(undefined, channel)).toMatchObject({
        ok: false,
        error: { code: 'AUTH_REQUIRED' },
      });
    }
  });
});

describe('forced refresh and change notifications (NXR-067 b)', () => {
  it('invalidates before storing a narrowed scope and notifies after plan sharing is lost', async () => {
    const notifications: unknown[][] = [];
    const onChanging = vi.fn(() =>
      notifications.push([
        'changing',
        keys.blob === undefined ? undefined : decode(keys.blob)['scope'],
      ]),
    );
    const onChange = vi.fn(() => notifications.push(['changed', decode(keys.blob)['scope']]));
    const service = make({ onChanging, onChange });
    await service.connect();
    const before = decode(keys.blob);
    notifications.length = 0;
    onChanging.mockClear();
    onChange.mockClear();
    fake.scope = 'openid profile email offline_access';
    now += 59 * 60 * 1000;
    const token = await service.accessToken();
    expect(token).not.toBe(before['accessToken']);
    expect(await service.status()).toMatchObject({ state: 'connected', planSharing: false });
    expect(notifications).toEqual([
      ['changing', before['scope']],
      ['changed', fake.scope],
    ]);
    expect(onChanging.mock.calls).toEqual([[]]);
    expect(onChange.mock.calls).toEqual([[]]);
    await service.accessToken({ refresh: true });
    expect(onChanging).toHaveBeenCalledOnce();
    // Each committed credential generation invalidates inventory, including same-scope refresh.
    expect(onChange).toHaveBeenCalledTimes(2);
  });

  it('a forced refresh replaces a token the provider rejected, once for concurrent callers', async () => {
    const service = make();
    await service.connect();
    const rejected = await service.accessToken();
    const [a, b] = await Promise.all([
      service.accessToken({ refresh: true }),
      service.accessToken({ refresh: true }),
    ]);
    expect(a).not.toBe(rejected);
    // The refresh token rotates, so it must not be spent twice.
    expect(b).toBe(a);
    expect(refreshes()).toHaveLength(1);
  });

  it('tells its listener when the connection appears, disappears or expires, with no data', async () => {
    const onChange = vi.fn();
    const service = make({ onChange });
    await service.connect();
    expect(onChange).toHaveBeenCalledTimes(1);
    expect(onChange.mock.calls[0]).toEqual([]);
    await service.disconnect();
    expect(onChange).toHaveBeenCalledTimes(2);

    await service.connect();
    fake.tokenReply = (form) =>
      form['grant_type'] === 'refresh_token'
        ? { status: 400, body: { error: 'invalid_grant' } }
        : undefined;
    await expect(service.accessToken({ refresh: true })).rejects.toMatchObject({
      code: 'AUTH_REQUIRED',
    });
    expect(onChange).toHaveBeenCalledTimes(4);
  });

  it('keeps working when the listener throws', async () => {
    const service = make({
      onChange: () => {
        throw new Error('listener failed');
      },
    });
    await expect(service.connect()).resolves.toMatchObject({ state: 'connected' });
  });
});
