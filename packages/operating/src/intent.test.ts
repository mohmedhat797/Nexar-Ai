import { describe, expect, it } from 'vitest';
import { INTENT_POLICY, INTENT_RULES, classifyIntent } from './intent.js';

const rules = (text: string) => classifyIntent({ text });

describe('intent-rules@1', () => {
  describe('rule table', () => {
    it('keeps the documented priority order and stateless patterns', () => {
      expect(INTENT_RULES.map((r) => r.id)).toEqual([
        'coding.implement',
        'review.code',
        'review.repository',
        'meeting.prepare',
        'documentation.write',
        'research.investigate',
        'analysis.explain',
      ]);
      for (const rule of INTENT_RULES) {
        expect(rule.pattern.flags).toBe('i');
      }
    });
  });

  describe.each([
    {
      id: 'coding.implement',
      kind: 'coding',
      positive: [
        'Implement the missing part.',
        'please implementing this',
        'add an endpoint for users',
        'Add the missing function',
        'add tests',
        'add a feature flag',
        'fix the bug in login',
        'fix this failing test',
        'Fix a build',
        'refactor the loader',
        'write unit tests',
        'write the integration tests',
        'write a test',
        'make the code change',
        'apply this code change',
        'create a pull request',
        'create a PR',
        'commit these changes',
        'commit changes',
        'IMPLEMENT IT',
      ],
      negative: [
        'the fixture is fine',
        'see the implementation notes',
        'prefixed names',
        'we added things',
        'address the committee',
        'tell me about the weather',
      ],
    },
    {
      id: 'review.code',
      kind: 'review',
      positive: [
        'review this code',
        'review the PR',
        'review my pull request',
        'review the diff',
        'review changes',
        'review the patch',
        'please do a code review',
      ],
      negative: ['review this project', 'preview the code', 'the reviewer said hi'],
    },
    {
      id: 'meeting.prepare',
      kind: 'meeting-preparation',
      positive: [
        'prep me for the meeting',
        'what is on the agenda',
        'write the call brief',
        'call notes please',
        'meeting prep',
      ],
      negative: ['meetings', 'the agendas', 'recall prep'],
    },
    {
      id: 'documentation.write',
      kind: 'documentation',
      positive: [
        'write a proposal',
        'a write-up of the findings',
        'make a writeup',
        'quarterly report',
        'update the README',
        'documentation for the API',
        'a statement of work',
        'draft the SOW',
        'the spec',
        'a specification',
        'draft a memo',
        'draft an email',
        'draft the letter',
        'draft document',
      ],
      negative: ['the reporter called', 'inspect the logs', 'speculate wildly', 'transport'],
    },
    {
      id: 'research.investigate',
      kind: 'research',
      positive: [
        'research vector stores',
        'investigate the outage',
        'look up the pricing',
        'compare options',
        'compare vendors',
        'compare these',
      ],
      negative: ['researcher notes', 'lookups only', 'comparison table'],
    },
    {
      id: 'analysis.explain',
      kind: 'analysis',
      positive: [
        'analyze the data',
        'analyse the data',
        'analysis of results',
        'explain this',
        'summarize it',
        'summarise it',
        'verify whether it works',
        'verify that it works',
        'verify if it works',
        'assess the risk',
        'evaluate the model',
        'review this document',
        'review the plan',
      ],
      negative: ['analyzer output', 'explained', 'verify the value', 'unassessed'],
    },
  ])('$id', ({ id, kind, positive, negative }) => {
    it.each(positive)('matches %j', (text) => {
      const intent = rules(text);
      expect(intent.ruleIds).toContain(id);
      expect(intent.kind).toBe(INTENT_RULES.find((r) => r.id === intent.ruleIds[0])?.kind);
      // The rule itself maps to its kind.
      expect(INTENT_RULES.find((r) => r.id === id)?.kind).toBe(kind);
    });

    it.each(negative)('does not match %j', (text) => {
      expect(rules(text).ruleIds).not.toContain(id);
    });
  });

  describe('decisions', () => {
    it.each([
      ['Implement the missing part.', 'coding'],
      ['Implement the missing backend endpoint.', 'coding'],
      ['Review this project and prepare a technical proposal.', 'documentation'],
      ['Review this code', 'review'],
      ['Prepare the meeting agenda', 'meeting-preparation'],
      ['Research the options', 'research'],
      ['Explain how this works', 'analysis'],
    ])('%j -> %s', (text, kind) => {
      const intent = rules(text);
      expect(intent.kind).toBe(kind);
      expect(intent.source).toBe('rules');
      expect(intent.policy).toBe(INTENT_POLICY);
    });

    it('does not let review.code match "review this project"', () => {
      const intent = rules('Review this project and prepare a technical proposal.');
      expect(intent.ruleIds).toEqual(['documentation.write']);
    });

    it('records every matched rule in priority order and takes the kind from the first', () => {
      const intent = rules('implement it, write the report and summarize');
      expect(intent.ruleIds).toEqual([
        'coding.implement',
        'documentation.write',
        'analysis.explain',
      ]);
      expect(intent.kind).toBe('coding');
    });

    it('falls back to general with the default rule', () => {
      expect(rules('hello there')).toEqual({
        kind: 'general',
        source: 'rules',
        ruleIds: ['default'],
        policy: 'intent-rules@1',
      });
      expect(rules('')).toMatchObject({ kind: 'general', ruleIds: ['default'] });
    });

    // Checking the repository against a proposal needs the code: `review.repository` precedes the
    // documentation and analysis rules, so the Operating Layer E2E's second turn has code affinity.
    it('classifies the "verify whether the repository ... proposal" example as review', () => {
      const intent = rules(
        'Now verify whether the repository implementation supports this proposal.',
      );
      expect(intent.ruleIds).toEqual([
        'review.repository',
        'documentation.write',
        'analysis.explain',
      ]);
      expect(intent.kind).toBe('review');
    });

    it('matches repository checks only within one sentence', () => {
      for (const text of [
        'check the codebase for dead code',
        'audit the repo',
        'inspect the source code of the parser',
        'assess whether the implementation is complete',
      ]) {
        expect(rules(text).kind, text).toBe('review');
      }
      for (const text of ['check the weather. The repository is fine', 'verify the invoice']) {
        expect(rules(text).ruleIds, text).not.toContain('review.repository');
      }
    });
  });

  describe('explicit kind', () => {
    it('wins over the rules', () => {
      expect(classifyIntent({ text: 'implement everything', explicitKind: 'research' })).toEqual({
        kind: 'research',
        source: 'explicit',
        ruleIds: ['explicit'],
        policy: 'intent-rules@1',
      });
    });

    it('treats explicit general as no preference and falls through to the rules', () => {
      expect(classifyIntent({ text: 'implement it', explicitKind: 'general' })).toMatchObject({
        kind: 'coding',
        source: 'rules',
      });
      expect(classifyIntent({ text: 'hello', explicitKind: 'general' })).toMatchObject({
        kind: 'general',
        source: 'rules',
        ruleIds: ['default'],
      });
    });

    it('accepts an open task kind', () => {
      expect(classifyIntent({ text: 'x', explicitKind: 'custom-kind' }).kind).toBe('custom-kind');
    });
  });

  it('never returns the text and is deterministic', () => {
    const text = 'implement SECRET-TOKEN-123';
    const first = rules(text);
    expect(JSON.stringify(first)).not.toContain('SECRET');
    expect(rules(text)).toEqual(first);
  });
});
