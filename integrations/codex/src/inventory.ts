import { lstat, mkdtemp, rm } from 'node:fs/promises';
import { isAbsolute, join } from 'node:path';
import type { InventorySource, NativeSubscriptionRuntime } from '@nexar/contracts';
import { createCodexSubscription } from './subscription.js';

/**
 * Explicit refresh may check native status. Until a browser-safe model/list version is verified,
 * never initialize app-server or pretend the account Responses catalog is a native Codex catalog.
 */
export function codexDefaultInventorySource(options: {
  readonly env: NodeJS.ProcessEnv;
  readonly privateDirectory: string;
  readonly subscription?: (cwd: string) => NativeSubscriptionRuntime;
}): InventorySource {
  return {
    async fetch(signal) {
      let cwd: string | undefined;
      try {
        const parent = await lstat(options.privateDirectory);
        if (
          !isAbsolute(options.privateDirectory) ||
          !parent.isDirectory() ||
          parent.isSymbolicLink()
        ) {
          return {
            status: 'unavailable',
            source: 'provider-default',
            auth: 'unknown',
            reason: 'runtime-unavailable',
          };
        }
        signal.throwIfAborted();
        cwd = await mkdtemp(join(options.privateDirectory, 'codex-inventory-'));
        const runtime =
          options.subscription?.(cwd) ?? createCodexSubscription({ env: options.env, cwd });
        const probe = await runtime.probe(signal);
        signal.throwIfAborted();
        if (probe.status === 'unavailable')
          return {
            status: 'unavailable',
            source: 'provider-default',
            auth: 'unknown',
            reason: 'runtime-unavailable',
          };
        return {
          status: 'success',
          source: 'provider-default',
          auth:
            probe.status === 'connected'
              ? 'authenticated'
              : probe.status === 'not-connected'
                ? 'unauthenticated'
                : 'unknown',
          ...(probe.version === undefined ? {} : { runtimeVersion: probe.version }),
          entries: [
            {
              selection: { kind: 'provider-default' },
              displayName: 'Codex — provider default',
              availability: 'available',
              compatibility: 'native-agent',
              source: 'provider-default',
            },
          ],
        };
      } catch {
        return {
          status: 'unavailable',
          source: 'provider-default',
          auth: 'unknown',
          reason: signal.aborted ? 'cancelled' : 'refresh-failed',
        };
      } finally {
        if (cwd !== undefined)
          await rm(cwd, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }).catch(
            () => undefined,
          );
      }
    },
  };
}
