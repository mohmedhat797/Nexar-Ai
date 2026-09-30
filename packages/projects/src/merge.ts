import type { Capability, ResourceId, TaskRequirements } from '@nexar/contracts';
import type { ProjectDefaults } from './project.js';

function union<T>(a: readonly T[] | undefined, b: readonly T[] | undefined): T[] {
  return [...new Set([...(a ?? []), ...(b ?? [])])];
}

/**
 * Merges project defaults into explicit task requirements.
 *
 * | field                | rule                                                               |
 * | -------------------- | ------------------------------------------------------------------ |
 * | capabilities         | union (project, then explicit), stable order                       |
 * | privacy              | most restrictive wins: `local-only` if either says so              |
 * | preferredResourceIds | explicit if provided (even `[]` = "no preference"), else project   |
 * | excludedResourceIds  | union (exclusions accumulate)                                      |
 * | minContextTokens     | explicit if set, else project                                      |
 * | maxCostUsd           | minimum of the defined values                                      |
 */
export function mergeRequirements(
  projectDefaults: ProjectDefaults | undefined,
  explicit: Partial<TaskRequirements>,
): TaskRequirements {
  const capabilities: Capability[] = union(projectDefaults?.capabilities, explicit.capabilities);

  const privacy =
    projectDefaults?.privacy === 'local-only' || explicit.privacy === 'local-only'
      ? 'local-only'
      : (explicit.privacy ?? projectDefaults?.privacy);

  const preferred: readonly ResourceId[] | undefined =
    explicit.preferredResourceIds ?? projectDefaults?.preferredResourceIds;

  const excluded =
    projectDefaults?.excludedResourceIds === undefined && explicit.excludedResourceIds === undefined
      ? undefined
      : union(projectDefaults?.excludedResourceIds, explicit.excludedResourceIds);

  const minContextTokens = explicit.minContextTokens ?? projectDefaults?.minContextTokens;

  const costs = [projectDefaults?.maxCostUsd, explicit.maxCostUsd].filter(
    (v): v is number => v !== undefined,
  );
  const maxCostUsd = costs.length === 0 ? undefined : Math.min(...costs);

  return {
    capabilities,
    ...(privacy === undefined ? {} : { privacy }),
    ...(minContextTokens === undefined ? {} : { minContextTokens }),
    ...(maxCostUsd === undefined ? {} : { maxCostUsd }),
    ...(preferred === undefined ? {} : { preferredResourceIds: preferred }),
    ...(excluded === undefined ? {} : { excludedResourceIds: excluded }),
  };
}
