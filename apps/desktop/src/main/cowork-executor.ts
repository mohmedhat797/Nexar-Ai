import { createEngineExecutor } from '@nexar/host';
import type { ChildExecutor } from '@nexar/engine-gateway';
import type { EngineHost } from './engine-host.js';

/** Delegation cannot regain a native host agent's filesystem authority through the bridge. */
export function boundedCoworkExecutor(engine: EngineHost): ChildExecutor {
  const execute = createEngineExecutor(engine);
  return (input, signal) => {
    const excluded = engine
      .composition()
      .runtime.registry.list()
      .filter(
        (resource) =>
          resource.kind.type !== 'model' ||
          !['pi', 'echo'].includes(String(resource.runtime.adapter)),
      )
      .map((resource) => resource.id);
    return execute(
      {
        ...input,
        requirements: {
          ...input.requirements,
          excludedResourceIds: [
            ...new Set([...(input.requirements.excludedResourceIds ?? []), ...excluded]),
          ],
        },
      },
      signal,
    );
  };
}
