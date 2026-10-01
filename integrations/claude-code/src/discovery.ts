import type { DiscoverySource } from '@nexar/contracts';
import { cliDiscoverySource, type FindOnPathOptions } from '@nexar/resource-registry';
import { claudeCodeResource } from './resource.js';

/** Discovers the installed `claude` CLI with a `PATH` stat only; auth state is left to the probe. */
export function claudeCodeCliDiscoverySource(options: FindOnPathOptions): DiscoverySource {
  return cliDiscoverySource({
    ...options,
    id: 'cli:claude-code',
    binary: 'claude',
    build: () => claudeCodeResource(),
  });
}
