import { describe, expect, it } from 'vitest';

import { NEXAR_CONTRACTS_VERSION } from './index.js';

describe('@nexar/contracts', () => {
  it('exports the contracts version', () => {
    expect(NEXAR_CONTRACTS_VERSION).toBe('0.1.0');
  });
});
