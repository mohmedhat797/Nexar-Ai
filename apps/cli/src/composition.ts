import type { LoadedConfig } from '@nexar/core';
import { loadHostConfig } from '@nexar/host';
import type { CliIo } from './io.js';

export {
  auditFilePath,
  builtinEngineeringPlansDir,
  builtinWorkflowsDir,
  clientsFilePath,
  compose,
  composeEngineering,
  composeWorkflows,
  discoverySources,
  nexarStateDir,
  requireEngineeringConfig,
  stateBaseDir,
  type Composition,
  type EgressCounts,
  type EngineeringComposition,
} from '@nexar/host';

/** Resolves the config (explicit path > NEXAR_CONFIG_PATH > cwd file > built-in default). */
export function loadCliConfig(io: CliIo, explicitPath: string | undefined): Promise<LoadedConfig> {
  return loadHostConfig(io, explicitPath);
}
