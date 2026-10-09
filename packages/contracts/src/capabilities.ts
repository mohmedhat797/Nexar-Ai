import { NexarError } from './errors.js';

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
  if (Object.hasOwn(VERIFIED_CAPABILITY_ALIASES, lower)) {
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
  if (!isCapabilityArray(raw)) {
    throw new NexarError('VALIDATION_ERROR', 'Invalid capability requirements', {
      details: { reason: 'capabilities.invalid' },
    });
  }
  const seen = new Set<string>();
  const normalized: Capability[] = [];
  for (const item of raw) {
    const norm = normalizeCapability(item);
    if (!seen.has(norm)) {
      seen.add(norm);
      normalized.push(norm);
    }
  }
  return normalized;
}

/**
 * Reject malformed arrays before normalization. Non-arrays remain subject to the boundary schema;
 * optional top-level null remains the existing absence sentinel.
 */
export function normalizeCapabilitiesInput(value: unknown): unknown {
  if (value === undefined || value === null) return undefined;
  if (Array.isArray(value)) {
    return normalizeCapabilities(value as readonly string[]);
  }
  return value;
}

/** The existing delegation bounds apply to raw members, before trimming or deduplication. */
function isCapabilityArray(value: unknown): value is readonly string[] {
  if (!Array.isArray(value) || value.length > 16) return false;
  for (let index = 0; index < value.length; index++) {
    if (!Object.hasOwn(value, index)) return false;
    const item: unknown = value[index];
    if (
      typeof item !== 'string' ||
      item.length === 0 ||
      item.length > 64 ||
      item.trim().length === 0
    ) {
      return false;
    }
  }
  return true;
}
