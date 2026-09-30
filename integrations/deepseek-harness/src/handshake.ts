import { join } from 'node:path';
import { buildBaseEnv } from './env.js';
import { DEFAULT_PROVIDER } from './options.js';
import { initializeRuntime, launchRuntime, normalizeBinary } from './runtime-process.js';
import type { BinarySpec, ServerInfo } from './runtime-process.js';

export interface HandshakeOptions {
  readonly binary?: string | BinarySpec;
  readonly cwd?: string;
  readonly stateDir?: string;
  readonly env?: NodeJS.ProcessEnv;
  readonly provider?: string;
  readonly model?: string;
  readonly timeoutMs?: number;
}

/**
 * Launches the runtime, performs `initialize` then `shutdown`, and reports the server identity.
 * Sends no prompt, so it never makes a model call; no credentials are passed to the child.
 */
export async function handshake(options: HandshakeOptions = {}): Promise<ServerInfo> {
  const cwd = options.cwd ?? process.cwd();
  const stateDir = options.stateDir ?? join(cwd, '.nexar', 'runtimes', 'deepseek-harness');
  const timeoutMs = options.timeoutMs ?? 15_000;
  const proc = await launchRuntime({
    binary: normalizeBinary(options.binary),
    cwd,
    stateDir,
    env: buildBaseEnv(options.env ?? process.env, stateDir),
    patches: [],
  });
  try {
    const info = await initializeRuntime(
      proc.client,
      {
        cwd,
        provider: options.provider ?? DEFAULT_PROVIDER,
        model: options.model ?? 'deepseek-v4-flash',
      },
      timeoutMs,
    );
    await proc.client.request('shutdown', undefined, { timeoutMs: 2000 }).catch(() => undefined);
    await proc.waitForExit(2000);
    return info;
  } finally {
    await proc.stop();
  }
}
