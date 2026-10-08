import { describe, expect, it } from 'vitest';
import {
  KNOWN_CAPABILITIES,
  VERIFIED_CAPABILITY_ALIASES,
  normalizeCapabilities,
  normalizeCapabilitiesInput,
  normalizeCapability,
} from './capabilities.js';

describe('capabilities contracts and normalization', () => {
  it('defines canonical capabilities', () => {
    expect(KNOWN_CAPABILITIES).toContain('text-generation');
    expect(KNOWN_CAPABILITIES).toContain('knowledge-work');
    expect(KNOWN_CAPABILITIES).toContain('reasoning');
    expect(KNOWN_CAPABILITIES).toContain('coding');
    expect(KNOWN_CAPABILITIES).toContain('model-turn');
  });

  it('defines verified legacy aliases', () => {
    expect(VERIFIED_CAPABILITY_ALIASES).toEqual({
      'requirements-analysis': 'knowledge-work',
      'technical-writing': 'text-generation',
      'project-planning': 'knowledge-work',
    });
  });

  describe('normalizeCapability', () => {
    it('preserves canonical capabilities unchanged', () => {
      for (const cap of KNOWN_CAPABILITIES) {
        expect(normalizeCapability(cap)).toBe(cap);
      }
    });

    it('maps verified legacy aliases to canonical capabilities', () => {
      expect(normalizeCapability('requirements-analysis')).toBe('knowledge-work');
      expect(normalizeCapability('technical-writing')).toBe('text-generation');
      expect(normalizeCapability('project-planning')).toBe('knowledge-work');
    });

    it('handles whitespace trimming and case insensitivity for aliases', () => {
      expect(normalizeCapability('  requirements-analysis  ')).toBe('knowledge-work');
      expect(normalizeCapability('Technical-Writing')).toBe('text-generation');
      expect(normalizeCapability('PROJECT-PLANNING')).toBe('knowledge-work');
    });

    it('preserves unknown capability strings as-is for fail-closed hard filtering', () => {
      expect(normalizeCapability('quantum-computing')).toBe('quantum-computing');
      expect(normalizeCapability('bespoke-skill-123')).toBe('bespoke-skill-123');
      expect(normalizeCapability('  custom-cap  ')).toBe('custom-cap');
    });
  });

  describe('normalizeCapabilities', () => {
    it('normalizes legacy aliases and deduplicates while preserving order', () => {
      const input = ['requirements-analysis', 'technical-writing', 'project-planning'];
      expect(normalizeCapabilities(input)).toEqual(['knowledge-work', 'text-generation']);
    });

    it('preserves canonical capabilities in mixed list', () => {
      const input = ['reasoning', 'technical-writing', 'coding'];
      expect(normalizeCapabilities(input)).toEqual(['reasoning', 'text-generation', 'coding']);
    });

    it('preserves unknown capabilities alongside normalized ones (fail-closed)', () => {
      const input = ['requirements-analysis', 'unknown-skill', 'project-planning'];
      expect(normalizeCapabilities(input)).toEqual(['knowledge-work', 'unknown-skill']);
    });

    it('deduplicates identical and aliased entries', () => {
      const input = [
        'knowledge-work',
        'requirements-analysis',
        'project-planning',
        'knowledge-work',
      ];
      expect(normalizeCapabilities(input)).toEqual(['knowledge-work']);
    });

    it('handles empty list', () => {
      expect(normalizeCapabilities([])).toEqual([]);
    });
  });

  describe('normalizeCapabilitiesInput', () => {
    it('returns undefined for undefined and null', () => {
      expect(normalizeCapabilitiesInput(undefined)).toBeUndefined();
      expect(normalizeCapabilitiesInput(null)).toBeUndefined();
    });

    it('normalizes arrays', () => {
      expect(
        normalizeCapabilitiesInput([
          'requirements-analysis',
          'technical-writing',
          'project-planning',
        ]),
      ).toEqual(['knowledge-work', 'text-generation']);
    });

    it('passes non-arrays through unchanged for downstream validation', () => {
      expect(normalizeCapabilitiesInput('not-an-array')).toBe('not-an-array');
      expect(normalizeCapabilitiesInput(123)).toBe(123);
    });
  });
});
