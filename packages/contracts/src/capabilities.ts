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
] as const;

/** A capability Nexar ships with first-class knowledge of. */
export type KnownCapability = (typeof KNOWN_CAPABILITIES)[number];

/** Open capability vocabulary: new capabilities need no code change, known ones keep autocomplete. */
export type Capability = KnownCapability | (string & {});
