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
