import { describe, expect, it } from 'vitest';

import {
  KNOWN_CAPABILITIES,
  KNOWN_TASK_KINDS,
  NEXAR_CONTRACTS_VERSION,
  unknownResourceState,
} from './index.js';

describe('@nexar/contracts', () => {
  it('exports the contracts version', () => {
    expect(NEXAR_CONTRACTS_VERSION).toBe('0.1.0');
  });

  it('exports vocabularies and state factory', () => {
    expect(KNOWN_CAPABILITIES).toContain('coding');
    expect(KNOWN_TASK_KINDS).toContain('general');
    expect(unknownResourceState('2026-01-01T00:00:00Z')).toEqual({
      availability: 'unknown',
      auth: 'unknown',
      observedAt: '2026-01-01T00:00:00Z',
    });
  });
});
