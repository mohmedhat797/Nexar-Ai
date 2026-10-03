/** The part of Electron's `app` the quit hold uses. */
export interface QuitApp {
  on(event: 'will-quit', listener: (event: { preventDefault(): void }) => void): unknown;
  quit(): void;
}

/**
 * Holds the exit at the first `will-quit` (all windows are closed by then) until `cleanup` settles or
 * `boundMs` passes, then quits again; the second `will-quit` lets the app exit. Supervised children
 * (OpenWorker, a plane) are ended before Desktop exits instead of outliving it, and a failing or slow
 * cleanup never delays the exit by more than the bound.
 */
export function holdQuitUntil(
  app: QuitApp,
  cleanup: () => Promise<unknown>,
  boundMs: number,
): void {
  let state: 'running' | 'holding' | 'released' = 'running';
  app.on('will-quit', (event) => {
    if (state === 'released') return;
    event.preventDefault();
    if (state === 'holding') return;
    state = 'holding';
    void new Promise<void>((resolve) => {
      const timer = setTimeout(resolve, boundMs);
      void Promise.resolve()
        .then(cleanup)
        .catch(() => undefined)
        .finally(() => {
          clearTimeout(timer);
          resolve();
        });
    }).then(() => {
      state = 'released';
      app.quit();
    });
  });
}
