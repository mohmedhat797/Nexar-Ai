import { dirname, join } from 'node:path';
import type { Logger } from '@nexar/contracts';
import { createNexar, loadConfig, type LoadedConfig, type NexarRuntime } from '@nexar/core';
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

/** Resolves the config (explicit path > NEXAR_CONFIG_PATH > cwd file > built-in default). */
export function loadCliConfig(io: CliIo, explicitPath: string | undefined): Promise<LoadedConfig> {
  return loadConfig({
    ...(explicitPath === undefined ? {} : { explicitPath }),
    env: io.env,
    cwd: io.cwd,
  });
}

/** The only place adapters are instantiated: every integration the CLI knows about. */
export function compose(loaded: LoadedConfig, io: CliIo, logger: Logger): Composition {
  const configDir = loaded.path === undefined ? io.cwd : dirname(loaded.path);
  const adapters = [
    new EchoExecutionAdapter(),
    new ClaudeCodeExecutionAdapter({ env: io.env }),
    new DeepSeekHarnessExecutionAdapter({
      env: io.env,
      stateDir: join(configDir, '.nexar', 'runtimes', 'deepseek-harness'),
    }),
    new PiExecutionAdapter({ env: io.env }),
  ];
  const runtime = createNexar(loaded.config, {
    adapters,
    logger,
    configDir,
    // The built-in default config has no telemetry path of its own.
    ...(loaded.source === 'default'
      ? { telemetry: new JsonlFileTelemetrySink(join(io.cwd, '.nexar', 'telemetry.jsonl')) }
      : {}),
  });
  return { loaded, runtime };
}
