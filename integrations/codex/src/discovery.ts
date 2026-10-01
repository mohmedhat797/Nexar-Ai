import type { DiscoverySource } from '@nexar/contracts';
import { cliDiscoverySource, type FindOnPathOptions } from '@nexar/resource-registry';
import { codexResource } from './resource.js';

/** Discovers the installed `codex` CLI with a `PATH` stat only; auth state is left to the probe. */
export function codexCliDiscoverySource(options: FindOnPathOptions): DiscoverySource {
  return cliDiscoverySource({
    ...options,
    id: 'cli:codex',
    binary: 'codex',
    build: () => codexResource(),
  });
}
