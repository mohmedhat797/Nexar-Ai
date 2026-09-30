import { describe, expect, it } from 'vitest';

import { adapterId, isNexarError, resourceId, taskId } from './index.js';

describe('id constructors', () => {
  it('accepts valid ids', () => {
    expect(resourceId('claude-code')).toBe('claude-code');
    expect(adapterId('a.b:c-d')).toBe('a.b:c-d');
    expect(taskId('Any Thing 123')).toBe('Any Thing 123');
    expect(taskId('x'.repeat(128))).toHaveLength(128);
    expect(resourceId('a'.repeat(128))).toHaveLength(128);
  });

  it.each(['', 'Upper', '-lead', 'has space', 'a'.repeat(129)])(
    'rejects invalid resource/adapter id %j',
    (s) => {
      expect(() => resourceId(s)).toThrow(/Invalid ResourceId/);
      expect(() => adapterId(s)).toThrow(/Invalid AdapterId/);
    },
  );

  it('rejects invalid task ids with VALIDATION_ERROR', () => {
    for (const s of ['', 'x'.repeat(129)]) {
      try {
        taskId(s);
        expect.unreachable();
      } catch (e) {
        expect(isNexarError(e) && e.code).toBe('VALIDATION_ERROR');
      }
    }
  });
});
