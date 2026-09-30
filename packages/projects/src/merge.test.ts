import { describe, expect, it } from 'vitest';
import { resourceId } from '@nexar/contracts';
import { mergeRequirements } from './merge.js';

const a = resourceId('a');
const b = resourceId('b');
const c = resourceId('c');

describe('mergeRequirements', () => {
  it('without defaults returns the explicit values (capabilities defaulted)', () => {
    expect(mergeRequirements(undefined, {})).toEqual({ capabilities: [] });
    expect(mergeRequirements(undefined, { capabilities: ['x'], maxCostUsd: 1 })).toEqual({
      capabilities: ['x'],
      maxCostUsd: 1,
    });
  });

  describe('capabilities: union, stable order', () => {
    it('project first, then explicit, deduplicated', () => {
      expect(
        mergeRequirements({ capabilities: ['x', 'y'] }, { capabilities: ['y', 'z'] }).capabilities,
      ).toEqual(['x', 'y', 'z']);
    });
  });

  describe('privacy: most restrictive wins', () => {
    it.each([
      [undefined, undefined, undefined],
      ['standard', undefined, 'standard'],
      [undefined, 'standard', 'standard'],
      ['local-only', undefined, 'local-only'],
      [undefined, 'local-only', 'local-only'],
      ['local-only', 'standard', 'local-only'],
      ['standard', 'local-only', 'local-only'],
      ['standard', 'standard', 'standard'],
    ] as const)('project %s + explicit %s -> %s', (project, explicit, expected) => {
      const merged = mergeRequirements(
        project === undefined ? {} : { privacy: project },
        explicit === undefined ? {} : { privacy: explicit },
      );
      expect(merged.privacy).toBe(expected);
      expect('privacy' in merged).toBe(expected !== undefined);
    });
  });

  describe('preferredResourceIds: explicit wins, even when empty', () => {
    it('uses the project list when explicit is absent', () => {
      expect(mergeRequirements({ preferredResourceIds: [a] }, {}).preferredResourceIds).toEqual([
        a,
      ]);
    });
    it('explicit replaces the project list', () => {
      expect(
        mergeRequirements({ preferredResourceIds: [a] }, { preferredResourceIds: [b] })
          .preferredResourceIds,
      ).toEqual([b]);
    });
    it('an explicit empty array means "no preference"', () => {
      expect(
        mergeRequirements({ preferredResourceIds: [a] }, { preferredResourceIds: [] })
          .preferredResourceIds,
      ).toEqual([]);
    });
  });

  describe('excludedResourceIds: union', () => {
    it('accumulates and deduplicates', () => {
      expect(
        mergeRequirements({ excludedResourceIds: [a, b] }, { excludedResourceIds: [b, c] })
          .excludedResourceIds,
      ).toEqual([a, b, c]);
    });
    it('an explicit empty array cannot remove a project exclusion', () => {
      expect(
        mergeRequirements({ excludedResourceIds: [a] }, { excludedResourceIds: [] })
          .excludedResourceIds,
      ).toEqual([a]);
    });
    it('is omitted when neither side has one', () => {
      expect('excludedResourceIds' in mergeRequirements({}, {})).toBe(false);
    });
  });

  describe('minContextTokens: explicit if set, else project', () => {
    it('falls back to the project value', () => {
      expect(mergeRequirements({ minContextTokens: 100 }, {}).minContextTokens).toBe(100);
    });
    it('explicit wins', () => {
      expect(
        mergeRequirements({ minContextTokens: 100 }, { minContextTokens: 50 }).minContextTokens,
      ).toBe(50);
    });
  });

  describe('maxCostUsd: minimum of the defined values', () => {
    it.each([
      [1, 2, 1],
      [2, 1, 1],
      [undefined, 3, 3],
      [3, undefined, 3],
      [0, 5, 0],
    ] as const)('project %s + explicit %s -> %s', (project, explicit, expected) => {
      const merged = mergeRequirements(
        project === undefined ? {} : { maxCostUsd: project },
        explicit === undefined ? {} : { maxCostUsd: explicit },
      );
      expect(merged.maxCostUsd).toBe(expected);
    });
  });
});
