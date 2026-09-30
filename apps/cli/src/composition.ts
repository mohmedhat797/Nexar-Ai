import { dirname, join } from 'node:path';
import type { Logger } from '@nexar/contracts';
import {
  createNexarWithProjects,
  loadConfig,
  type LoadedConfig,
  type NexarRuntime,
} from '@nexar/core';
import { ClaudeCodeExecutionAdapter } from '@nexar/integration-claude-code';
import { DeepSeekHarnessExecutionAdapter } from '@nexar/integration-deepseek-harness';
import { EchoExecutionAdapter } from '@nexar/integration-echo';
import { PiExecutionAdapter } from '@nexar/integration-pi';
import { JsonlFileTelemetrySink } from '@nexar/telemetry';
import type { CliIo } from './io.js';

export interface Composition {
  readonly loaded: LoadedConfig;
  readonly runtime: NexarRuntime;
}

/** Where Nexar keeps local state: the config file's directory, or the cwd for the built-in default. */
export function stateBaseDir(loaded: LoadedConfig, io: CliIo): string {
  return loaded.path === undefined ? io.cwd : dirname(loaded.path);
}

/** Resolves the config (explicit path > NEXAR_CONFIG_PATH > cwd file > built-in default). */
export function loadCliConfig(io: CliIo, explicitPath: string | undefined): Promise<LoadedConfig> {
  return loadConfig({
    ...(explicitPath === undefined ? {} : { explicitPath }),
    env: io.env,
    cwd: io.cwd,
  });
}

/**
 * The only place adapters are instantiated: every integration the CLI knows about.
 * Canonicalizes project roots, so a misconfigured project fails here with `CONFIGURATION_ERROR`.
 */
export async function compose(
  loaded: LoadedConfig,
  io: CliIo,
  logger: Logger,
): Promise<Composition> {
  const configDir = stateBaseDir(loaded, io);
  const adapters = [
    new EchoExecutionAdapter(),
    new ClaudeCodeExecutionAdapter({ env: io.env }),
    new DeepSeekHarnessExecutionAdapter({
      env: io.env,
      stateDir: join(configDir, '.nexar', 'runtimes', 'deepseek-harness'),
    }),
    new PiExecutionAdapter({ env: io.env }),
  ];
  const runtime = await createNexarWithProjects(loaded.config, {
    adapters,
    logger,
    configDir,
    // The owner at their own terminal may run unscoped (`--cwd` without `--project`). External
    // clients (the Work Bridge) must use an engine left at the secure 'project-only' default.
    workingDirectoryPolicy: 'project-or-unscoped',
    // The built-in default config has no telemetry path of its own.
    ...(loaded.source === 'default'
      ? { telemetry: new JsonlFileTelemetrySink(join(io.cwd, '.nexar', 'telemetry.jsonl')) }
      : {}),
  });
  return { loaded, runtime };
}
