import { describe, expect, it } from 'vitest';
import { coworkDelegationLimit } from './delegation.js';

describe('trusted Cowork delegation limit', () => {
  it('preserves the default and accepts only narrowing integer limits', () => {
    expect(coworkDelegationLimit({})).toBe(16);
    expect(coworkDelegationLimit({ maxDelegatedUnits: undefined })).toBe(16);
    for (let value = 1; value <= 16; value++) {
      expect(coworkDelegationLimit({ maxDelegatedUnits: value })).toBe(value);
    }
  });

  it.each([-1, 0, 1.5, NaN, Infinity, -Infinity, 17, '1', null, false, {}, [], { value: 1 }])(
    'rejects an invalid explicit limit rather than defaulting: %j',
    (value) => {
      expect(() => coworkDelegationLimit({ maxDelegatedUnits: value })).toThrowError(
        expect.objectContaining({
          code: 'VALIDATION_ERROR',
          details: { reason: 'delegation-limit.invalid' },
        }),
      );
    },
  );

  it('rejects inherited limits and accessors without evaluating them', () => {
    expect(() =>
      coworkDelegationLimit(Object.create({ maxDelegatedUnits: 16 }) as object),
    ).toThrow();
    let reads = 0;
    const accessor = Object.defineProperty({}, 'maxDelegatedUnits', {
      get: () => {
        reads++;
        return 16;
      },
    });
    expect(() => coworkDelegationLimit(accessor)).toThrow();
    expect(reads).toBe(0);
    expect(
      coworkDelegationLimit(Object.assign(Object.create(null) as object, { maxDelegatedUnits: 1 })),
    ).toBe(1);
  });
});
