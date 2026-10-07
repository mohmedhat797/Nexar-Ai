import type { spawn } from 'node:child_process';
import { lstat, mkdtemp, rm } from 'node:fs/promises';
import { isAbsolute, join } from 'node:path';
import type {
  InventorySource,
  InventorySourceResult,
  ProviderModelEntry,
  ProviderModelInventoryReason,
} from '@nexar/contracts';
import { PROVIDER_MODEL_INVENTORY_MAX_ENTRIES } from '@nexar/contracts';
import { publicRuntimeEnvironment, runRuntimeCommand } from '@nexar/process';
import type { AgyBinary } from './adapter.js';

const MAX_OUTPUT_BYTES = 16 * 1024;
const TIMEOUT_MS = 10_000;

export interface AntigravityModelInventoryOptions {
  /** Existing host-owned private state directory, secured before this source is composed. */
  readonly privateDirectory: string;
  readonly env?: NodeJS.ProcessEnv;
  readonly binary?: AgyBinary;
  readonly spawnImpl?: typeof spawn;
  readonly runCommand?: typeof runRuntimeCommand;
}

function failure(reason: ProviderModelInventoryReason): InventorySourceResult {
  return { status: 'unavailable', source: 'live-runtime', auth: 'unknown', reason };
}

/**
 * The documented listing has slug/name columns, not a JSON protocol. Only bounded plain rows
 * separated by tabs or two spaces are recognized. Headers, ANSI output and free-form text are
 * ignored. A changed format yields no verified model choice, never a static catalog fallback.
 */
export function parseAntigravityModelList(
  output: string,
): readonly ProviderModelEntry[] | undefined {
  if (Buffer.byteLength(output) > MAX_OUTPUT_BYTES) return undefined;
  const entries: ProviderModelEntry[] = [];
  const ids = new Set<string>();
  for (const line of output.split(/\r?\n/)) {
    const match = /^([a-z][a-z0-9._-]{0,199})(?:\t+| {2,})([^\p{Cc}]+)$/u.exec(line);
    if (match === null) continue;
    const id = match[1];
    const displayName = match[2]?.trim();
    if (
      id === undefined ||
      displayName === undefined ||
      displayName.length === 0 ||
      displayName.length > 160 ||
      ids.has(id)
    ) {
      return undefined;
    }
    ids.add(id);
    entries.push(
      Object.freeze({
        selection: Object.freeze({ kind: 'model' as const, id }),
        displayName,
        availability: 'available',
        compatibility: 'native-agent',
        source: 'live-runtime',
      }),
    );
    if (entries.length > PROVIDER_MODEL_INVENTORY_MAX_ENTRIES) return undefined;
  }
  return entries.length === 0 ? undefined : Object.freeze(entries);
}

/** Owner-triggered metadata command only. Construction and adapter probes never list models. */
export function antigravityModelInventorySource(
  options: AntigravityModelInventoryOptions,
): InventorySource {
  const env = publicRuntimeEnvironment(options.env ?? process.env);
  const binary = options.binary ?? 'agy';
  const command = typeof binary === 'string' ? binary : binary.command;
  const args = [...(typeof binary === 'string' ? [] : binary.args), 'models'];
  const run = options.runCommand ?? runRuntimeCommand;
  return {
    async fetch(signal) {
      if (signal.aborted) return failure('cancelled');
      let cwd: string | undefined;
      try {
        if (!isAbsolute(options.privateDirectory)) return failure('runtime-unavailable');
        const parent = await lstat(options.privateDirectory);
        if (!parent.isDirectory() || parent.isSymbolicLink()) return failure('runtime-unavailable');
        // mkdtemp creates a 0700 directory on POSIX; Windows inherits the guarded parent's DACL.
        // Same-user replacement races are outside this port's boundary, as for the state guard.
        cwd = await mkdtemp(join(options.privateDirectory, 'antigravity-inventory-'));
        if (signal.aborted) return failure('cancelled');
        const result = await run({
          command,
          args,
          cwd,
          env: { ...env },
          signal,
          timeoutMs: TIMEOUT_MS,
          interaction: 'probe',
          maxOutputBytes: MAX_OUTPUT_BYTES,
          ...(options.spawnImpl === undefined ? {} : { spawnImpl: options.spawnImpl }),
        });
        if (signal.aborted || result.kind === 'cancelled') return failure('cancelled');
        if (result.kind === 'timed-out') return failure('timeout');
        if (result.kind === 'unavailable') return failure('runtime-unavailable');
        if (result.kind === 'overflow') return failure('invalid-response');
        if (result.exitCode !== 0) return failure('refresh-failed');
        if (Buffer.byteLength(result.stdout) + Buffer.byteLength(result.stderr) > MAX_OUTPUT_BYTES)
          return failure('invalid-response');
        const entries = parseAntigravityModelList(result.stdout);
        if (entries === undefined) return failure('invalid-response');
        // Listing is not an account-status protocol and reports no current selection or limits.
        return { status: 'success', source: 'live-runtime', auth: 'unknown', entries };
      } catch {
        return failure(signal.aborted ? 'cancelled' : 'refresh-failed');
      } finally {
        if (cwd !== undefined)
          await rm(cwd, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }).catch(
            () => undefined,
          );
      }
    },
  };
}
