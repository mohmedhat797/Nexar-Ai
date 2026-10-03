import type { TaskKind } from '@nexar/contracts';
import type { TurnIntent } from '@nexar/sessions';

/*
 * `intent-rules@1`: deterministic, versioned, pure. An explicit kind chosen in the UI wins;
 * otherwise fixed keyword rules over the owner's text decide. Only the kind and matched rule ids
 * are returned: the text is never stored, echoed or logged. A new behavior is a new policy version.
 */

export const INTENT_POLICY = 'intent-rules@1';

export interface IntentRule {
  readonly id: string;
  readonly kind: TaskKind;
  readonly pattern: RegExp;
}

/** Priority order: the first matching rule decides the kind. Patterns carry no `g`/`y` flag. */
export const INTENT_RULES: readonly IntentRule[] = [
  {
    id: 'coding.implement',
    kind: 'coding',
    pattern: new RegExp(
      [
        String.raw`\b(?:implement|implementing|refactor)\b`,
        String.raw`\badd\s+(?:(?:a|an|the)\s+)?(?:missing\s+)?(?:endpoint|function|method|feature|tests?|class|module)\b`,
        String.raw`\bfix\s+(?:(?:the|this|a)\s+)?(?:bug|error|failing\s+test|build)\b`,
        String.raw`\bwrite\s+(?:(?:a|the)\s+)?(?:(?:unit|integration)\s+)?tests?\b`,
        String.raw`\b(?:make|apply)\s+(?:(?:the|a|this)\s+)?code\s+change\b`,
        String.raw`\bcreate\s+(?:a\s+)?(?:pull\s+request|pr)\b`,
        String.raw`\bcommit\s+(?:(?:the|these|this)\s+)?changes\b`,
      ].join('|'),
      'i',
    ),
  },
  {
    id: 'review.code',
    kind: 'review',
    pattern: new RegExp(
      [
        String.raw`\breview\s+(?:(?:this|the|my)\s+)?(?:code|pr|pull\s+request|diff|changes?|patch)\b`,
        String.raw`\bcode\s+review\b`,
      ].join('|'),
      'i',
    ),
  },
  {
    // Reviewing or checking a repository (alone or against a proposal, a spec) is engineering
    // analysis: it needs the code, so it has `code` affinity, but it is read-only (not a write).
    id: 'review.repository',
    kind: 'review',
    pattern:
      /\b(?:review|verify|check|assess|audit|inspect)\b[^.?!\n]{0,80}?\b(?:repository|repo|codebase|implementation|source\s+code)\b/i,
  },
  {
    id: 'meeting.prepare',
    kind: 'meeting-preparation',
    pattern: /\b(?:meeting|agenda)\b|\b(?:meeting|call)\s+(?:brief|notes|prep)\b/i,
  },
  {
    id: 'documentation.write',
    kind: 'documentation',
    pattern: new RegExp(
      [
        String.raw`\b(?:proposal|write-?up|report|readme|documentation|statement\s+of\s+work|sow|spec|specification)\b`,
        String.raw`\bdraft\s+(?:(?:a|an|the)\s+)?(?:document|doc|memo|email|letter)\b`,
      ].join('|'),
      'i',
    ),
  },
  {
    id: 'research.investigate',
    kind: 'research',
    pattern: /\b(?:research|investigate|look\s+up|compare)\b/i,
  },
  {
    id: 'analysis.explain',
    kind: 'analysis',
    pattern: new RegExp(
      [
        String.raw`\b(?:analy[sz]e|analysis|explain|summari[sz]e|assess|evaluate)\b`,
        String.raw`\bverify\s+(?:whether|that|if)\b`,
        String.raw`\breview\s+(?:(?:this|the)\s+)?(?:proposal|document|plan)\b`,
      ].join('|'),
      'i',
    ),
  },
];

export interface ClassifyIntentInput {
  readonly text: string;
  /** A kind the owner chose explicitly; `general` means "no preference" and falls through. */
  readonly explicitKind?: TaskKind | undefined;
}

export function classifyIntent(input: ClassifyIntentInput): TurnIntent {
  const { explicitKind } = input;
  if (explicitKind !== undefined && explicitKind !== 'general') {
    return { kind: explicitKind, source: 'explicit', ruleIds: ['explicit'], policy: INTENT_POLICY };
  }
  const matched = INTENT_RULES.filter((rule) => rule.pattern.test(input.text));
  const first = matched[0];
  if (first === undefined) {
    return { kind: 'general', source: 'rules', ruleIds: ['default'], policy: INTENT_POLICY };
  }
  return {
    kind: first.kind,
    source: 'rules',
    ruleIds: matched.map((rule) => rule.id),
    policy: INTENT_POLICY,
  };
}
