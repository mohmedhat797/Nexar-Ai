/** Capabilities Nexar itself understands and can route on. */
export const KNOWN_CAPABILITIES = [
  'text-generation',
  'reasoning',
  'knowledge-work',
  'coding',
  'repo-editing',
  'code-review',
  'tool-use',
  'shell-execution',
  'long-context',
  'web-research',
  'vision',
  /**
   * Accepts caller-supplied messages and tool schemas and returns one assistant turn whose tool
   * calls the caller executes (ADR-027 §6). Distinct from `tool-use`, where the resource runs tools.
   */
  'model-turn',
] as const;

/** A capability Nexar ships with first-class knowledge of. */
export type KnownCapability = (typeof KNOWN_CAPABILITIES)[number];

/** Open capability vocabulary: new capabilities need no code change, known ones keep autocomplete. */
export type Capability = KnownCapability | (string & {});

/**
 * Verified legacy or informal capability aliases (task descriptions / skill hints) mapped to
 * canonical Nexar executable capabilities. Unknown or unsupported capability names are NOT in
 * this map and are preserved as-is so downstream hard-filtering fails closed with structured reasons.
 */
export const VERIFIED_CAPABILITY_ALIASES: Readonly<Record<string, KnownCapability>> = {
  'requirements-analysis': 'knowledge-work',
  'technical-writing': 'text-generation',
  'project-planning': 'knowledge-work',
};

/**
 * Normalizes a capability name at the delegation boundary:
 * - Trims whitespace.
 * - Maps verified legacy aliases to canonical capabilities.
 * - Preserves canonical and unknown capabilities without modification (preserving fail-closed hard filtering).
 */
export function normalizeCapability(raw: string): Capability {
  const trimmed = raw.trim();
  const lower = trimmed.toLowerCase();
  if (lower in VERIFIED_CAPABILITY_ALIASES) {
    return VERIFIED_CAPABILITY_ALIASES[lower]!;
  }
  return trimmed;
}

/**
 * Normalizes a list of capability names at the delegation boundary:
 * - Trims whitespace and normalizes each capability.
 * - Preserves order and deduplicates.
 * - Preserves unknown capabilities so hard filters can fail closed.
 */
export function normalizeCapabilities(raw: readonly string[]): Capability[] {
  const seen = new Set<string>();
  const normalized: Capability[] = [];
  for (const item of raw) {
    if (typeof item !== 'string') continue;
    const norm = normalizeCapability(item);
    if (!seen.has(norm)) {
      seen.add(norm);
      normalized.push(norm);
    }
  }
  return normalized;
}

/**
 * Zod preprocessor helper for capabilities input.
 */
export function normalizeCapabilitiesInput(value: unknown): unknown {
  if (value === undefined || value === null) return undefined;
  if (Array.isArray(value)) {
    return normalizeCapabilities(value as readonly string[]);
  }
  return value;
}
