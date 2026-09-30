import { describe, expect, it } from 'vitest';

import { emptyUsage, estimated, measured, unavailable, valueOf } from './index.js';

describe('Measured helpers', () => {
  it('builds each status', () => {
    expect(measured(1)).toEqual({ status: 'measured', value: 1 });
    expect(estimated(2, 'chars/4')).toEqual({ status: 'estimated', value: 2, basis: 'chars/4' });
    expect(unavailable()).toEqual({ status: 'unavailable' });
    expect(unavailable('none')).toEqual({ status: 'unavailable', reason: 'none' });
  });

  it('valueOf extracts values', () => {
    expect(valueOf(measured(0))).toBe(0);
    expect(valueOf(estimated(3, 'b'))).toBe(3);
    expect(valueOf(unavailable<number>())).toBeUndefined();
  });

  it('emptyUsage is all unavailable', () => {
    const u = emptyUsage('cli');
    expect(u.inputTokens).toEqual({ status: 'unavailable', reason: 'cli' });
    expect(u.outputTokens.status).toBe('unavailable');
    expect(u.costUsd.status).toBe('unavailable');
    expect(emptyUsage().costUsd).toEqual({ status: 'unavailable' });
  });
});
