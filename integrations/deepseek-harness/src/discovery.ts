import type { DiscoverySource } from '@nexar/contracts';
import { cliDiscoverySource, type FindOnPathOptions } from '@nexar/resource-registry';
import { deepseekHarnessResource } from './resource.js';

/** Discovers the installed `dsh` CLI with a `PATH` stat only; auth state is left to the probe. */
export function deepseekHarnessCliDiscoverySource(options: FindOnPathOptions): DiscoverySource {
  return cliDiscoverySource({
    ...options,
    id: 'cli:deepseek-harness',
    binary: 'dsh',
    build: () => deepseekHarnessResource(),
  });
}
