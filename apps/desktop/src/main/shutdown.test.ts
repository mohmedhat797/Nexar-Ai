import { afterEach, describe, expect, it, vi } from 'vitest';
import { holdQuitUntil, type QuitApp } from './shutdown.js';

/** A fake `app`: `quit()` emits `will-quit` like Electron does once the windows are closed. */
function fakeApp(): QuitApp & { readonly quits: () => number; readonly exited: () => boolean } {
  const listeners: ((event: { preventDefault(): void }) => void)[] = [];
  let quits = 0;
  let exited = false;
  const app = {
    on: (_event: 'will-quit', listener: (event: { preventDefault(): void }) => void) => {
      listeners.push(listener);
      return app;
    },
    quit: () => {
      quits += 1;
      let prevented = false;
      for (const listener of listeners) listener({ preventDefault: () => (prevented = true) });
      if (!prevented) exited = true;
    },
    quits: () => quits,
    exited: () => exited,
  };
  return app;
}

afterEach(() => {
  vi.useRealTimers();
});

describe('holdQuitUntil', () => {
  it('holds the exit until the cleanup settles, then quits once more', async () => {
    const app = fakeApp();
    let finish: () => void = () => undefined;
    const cleanup = vi.fn(() => new Promise<void>((resolve) => (finish = resolve)));
    holdQuitUntil(app, cleanup, 5_000);

    app.quit();
    expect(app.exited()).toBe(false);
    await vi.waitFor(() => expect(cleanup).toHaveBeenCalledTimes(1));
    // A repeated quit while holding neither exits nor starts the cleanup again.
    app.quit();
    expect(app.exited()).toBe(false);

    finish();
    await vi.waitFor(() => expect(app.exited()).toBe(true));
    expect(cleanup).toHaveBeenCalledTimes(1);
    expect(app.quits()).toBe(3);
  });

  it('exits after the bound when the cleanup never settles', async () => {
    vi.useFakeTimers();
    const app = fakeApp();
    holdQuitUntil(app, () => new Promise<never>(() => undefined), 5_000);
    app.quit();
    await vi.advanceTimersByTimeAsync(4_999);
    expect(app.exited()).toBe(false);
    await vi.advanceTimersByTimeAsync(1);
    expect(app.exited()).toBe(true);
  });

  it('exits when the cleanup fails', async () => {
    const app = fakeApp();
    holdQuitUntil(app, () => Promise.reject(new Error('cleanup failed')), 5_000);
    app.quit();
    await vi.waitFor(() => expect(app.exited()).toBe(true));
  });
});
