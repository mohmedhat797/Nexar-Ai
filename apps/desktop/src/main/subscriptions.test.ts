import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type {
  NativeSubscriptionLoginOutcome,
  NativeSubscriptionProbe,
  NativeSubscriptionRuntime,
} from '@nexar/contracts';
import { CHANNELS } from '../shared/channels.js';
import { createBridge } from './bridge.js';
import { SubscriptionService } from './subscriptions.js';
import { createHarness, type Harness } from './test-harness.js';

const SECRET = 'subscription-sentinel-secret-7391';
const account = {
  status: 'connected',
  authMode: 'vendor-account',
  loginSupported: true,
  version: '1.2.3',
} as const;
let h: Harness;
let native: NativeSubscriptionRuntime;
let service: SubscriptionService;
beforeEach(async () => {
  h = await createHarness();
  native = {
    probe: vi.fn(() => Promise.resolve(account)),
    login: vi.fn(() => Promise.resolve('succeeded' as const)),
  };
  service = new SubscriptionService({
    'claude-code': native,
    codex: native,
    antigravity: {
      probe: () =>
        Promise.resolve({ status: 'unknown', authMode: 'unknown', loginSupported: false }),
      login: () => Promise.resolve('unavailable'),
    },
  });
});
afterEach(async () => {
  service.dispose();
  await h.cleanup();
});

describe('native subscription service and bridge', () => {
  it('holds native login and probe admissions until the actual provider operation settles', async () => {
    service.dispose();
    let finishProbe!: () => void, finishLogin!: () => void;
    const probeRelease = vi.fn(),
      loginRelease = vi.fn();
    native.probe = vi.fn(
      () =>
        new Promise<NativeSubscriptionProbe>((resolve) => {
          finishProbe = () => resolve(account);
        }),
    );
    native.login = vi.fn(
      () =>
        new Promise<NativeSubscriptionLoginOutcome>((resolve) => {
          finishLogin = () => resolve('succeeded');
        }),
    );
    service = new SubscriptionService(
      { 'claude-code': native, codex: native, antigravity: native },
      undefined,
      {
        probe: () => Promise.resolve({ release: probeRelease }),
        login: () => Promise.resolve({ release: loginRelease }),
      },
    );
    const probe = service.refresh('codex');
    await vi.waitFor(() => expect(native.probe).toHaveBeenCalledOnce());
    expect(probeRelease).not.toHaveBeenCalled();
    finishProbe();
    await probe;
    expect(probeRelease).toHaveBeenCalledOnce();
    native.probe = vi.fn(() => Promise.resolve(account));
    await service.start('codex');
    await vi.waitFor(() => expect(native.login).toHaveBeenCalledOnce());
    expect(loginRelease).not.toHaveBeenCalled();
    await service.cancel('codex');
    expect(loginRelease).not.toHaveBeenCalled();
    finishLogin();
    await vi.waitFor(() => expect(loginRelease).toHaveBeenCalledOnce());
  });
  it('returns only runtime-scoped metadata and keeps unsupported Google explicit', async () => {
    const bridge = createBridge({ ...h.deps, subscriptions: service });
    expect(
      await bridge.invoke(CHANNELS.subscriptionsRefresh, { runtime: 'codex' }, () => undefined),
    ).toMatchObject({
      ok: true,
      value: { runtime: 'codex', status: 'connected', method: 'subscription', usableBy: 'codex' },
    });
    expect((await service.list()).find((row) => row.runtime === 'antigravity')).toMatchObject({
      status: 'unknown',
      loginSupported: false,
    });
    await service.start('antigravity');
    await vi.waitFor(async () => {
      expect(await service.refresh('antigravity')).toMatchObject({ loginState: 'unavailable' });
    });
  });

  it('rejects arbitrary commands, env, paths, tokens and wrong runtimes before calling the port', async () => {
    const bridge = createBridge({ ...h.deps, subscriptions: service });
    for (const channel of [
      CHANNELS.subscriptionsRefresh,
      CHANNELS.subscriptionsLogin,
      CHANNELS.subscriptionsCancel,
    ]) {
      for (const args of [
        { runtime: SECRET },
        { runtime: 'codex', command: SECRET },
        { runtime: 'codex', env: { TOKEN: SECRET } },
        { runtime: 'codex', args: [SECRET] },
        { runtime: 'codex', binary: SECRET },
        { runtime: ['codex'] },
        null,
      ]) {
        const result = await bridge.invoke(channel, args, () => undefined);
        expect(result).toMatchObject({ ok: false, error: { code: 'VALIDATION_ERROR' } });
        expect(JSON.stringify(result)).not.toContain(SECRET);
      }
    }
    expect(native.probe).not.toHaveBeenCalled();
    expect(native.login).not.toHaveBeenCalled();
  });

  it('reserves sign-in before awaiting a probe and cancels without spawning', async () => {
    let finish: () => void = () => undefined;
    native.probe = vi.fn(
      () =>
        new Promise<NativeSubscriptionProbe>((resolve) => {
          finish = () => resolve(account);
        }),
    );
    expect(await service.start('codex')).toMatchObject({ loginState: 'running' });
    await expect(service.start('codex')).rejects.toMatchObject({ code: 'CONFLICT' });
    await service.cancel('codex');
    finish();
    await vi.waitFor(async () => {
      expect(await service.refresh('codex')).toMatchObject({ loginState: 'cancelled' });
    });
    expect(native.login).not.toHaveBeenCalled();
  });

  it('keeps cancellation reserved until native cleanup completes and allows restart afterward', async () => {
    let finish: (outcome: NativeSubscriptionLoginOutcome) => void = () => undefined;
    let signal: AbortSignal | undefined;
    native.login = vi.fn((abort: AbortSignal) => {
      signal = abort;
      return new Promise<NativeSubscriptionLoginOutcome>((resolve) => {
        finish = resolve;
      });
    });
    expect(await service.start('codex')).toMatchObject({ loginState: 'running' });
    await vi.waitFor(() => {
      expect(native.login).toHaveBeenCalledOnce();
    });
    expect(await service.cancel('codex')).toMatchObject({ loginState: 'cancelled' });
    expect(signal?.aborted).toBe(true);
    await expect(service.start('codex')).rejects.toMatchObject({ code: 'CONFLICT' });
    finish('cancelled');
    await vi.waitFor(async () => {
      expect(await service.start('codex')).toMatchObject({ loginState: 'running' });
    });
    finish('cancelled');
  });

  it.each(['succeeded', 'failed', 'timed-out', 'unavailable'] as const)(
    'normalizes %s and rechecks account status',
    async (outcome) => {
      native.login = vi.fn(() => Promise.resolve(outcome));
      native.probe = vi.fn<NativeSubscriptionRuntime['probe']>(() =>
        Promise.resolve({ status: 'not-connected', authMode: 'none', loginSupported: true }),
      );
      await service.start('codex');
      await vi.waitFor(async () => {
        expect(await service.refresh('codex')).toMatchObject({
          loginState: outcome,
          status: 'not-connected',
        });
      });
    },
  );

  it('contains malformed probes, extra vendor fields and thrown errors', async () => {
    native.probe = vi.fn(() => Promise.resolve({ ...account, token: SECRET }));
    expect(JSON.stringify(await service.refresh('codex'))).not.toContain(SECRET);
    native.probe = vi.fn(() => Promise.resolve({ ...account, version: SECRET }));
    expect(await service.refresh('codex')).toMatchObject({
      status: 'unknown',
      authMode: 'unknown',
    });
    native.login = vi.fn(() => Promise.reject(new Error(SECRET)));
    native.probe = vi.fn(() => Promise.resolve(account));
    await service.start('codex');
    await vi.waitFor(async () => {
      expect(await service.refresh('codex')).toMatchObject({ loginState: 'failed' });
    });
    expect(JSON.stringify(await service.list())).not.toContain(SECRET);
  });

  it('does not relabel a completed attempt when cancellation arrives late', async () => {
    await service.start('codex');
    await vi.waitFor(async () => {
      expect(await service.refresh('codex')).toMatchObject({ loginState: 'succeeded' });
    });
    expect(await service.cancel('codex')).toMatchObject({ loginState: 'succeeded' });
  });

  it.each(['cancel', 'dispose'] as const)(
    'reuses a pending probe and prevents login after %s',
    async (action) => {
      let finish: () => void = () => undefined;
      native.probe = vi.fn(
        () =>
          new Promise<NativeSubscriptionProbe>((resolve) => {
            finish = () => resolve(account);
          }),
      );
      const pending = service.refresh('codex');
      expect(await service.start('codex')).toMatchObject({ loginState: 'running' });
      if (action === 'cancel') await service.cancel('codex');
      else service.dispose();
      finish();
      await pending;
      expect(native.probe).toHaveBeenCalledOnce();
      expect(native.login).not.toHaveBeenCalled();
    },
  );

  it('aborts in-flight probes and login on shutdown and prevents further launches', async () => {
    let probeSignal: AbortSignal | undefined;
    native.probe = vi.fn((signal: AbortSignal) => {
      probeSignal = signal;
      return new Promise<NativeSubscriptionProbe>((resolve) => {
        signal.addEventListener('abort', () => resolve(account));
      });
    });
    const pending = service.refresh('codex');
    service.dispose();
    expect(probeSignal?.aborted).toBe(true);
    await pending;
    await expect(service.start('codex')).rejects.toMatchObject({ code: 'CONFIGURATION_ERROR' });
    expect(native.login).not.toHaveBeenCalled();
  });
});
