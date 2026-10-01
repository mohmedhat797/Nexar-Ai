import type { DiscoverySource } from '@nexar/contracts';
import { cliDiscoverySource, type FindOnPathOptions } from '@nexar/resource-registry';
import { antigravityResource } from './resource.js';

/** Discovers the installed `agy` CLI with a `PATH` stat only; auth state is left to the probe. */
export function antigravityCliDiscoverySource(options: FindOnPathOptions): DiscoverySource {
  return cliDiscoverySource({
    ...options,
    id: 'cli:antigravity',
    binary: 'agy',
    build: () => antigravityResource(),
  });
}
