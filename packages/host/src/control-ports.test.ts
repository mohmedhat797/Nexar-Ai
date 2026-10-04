import { piModelResource } from '@nexar/integration-pi';
import { describe, expect, it } from 'vitest';
import { createControlModelTurnPorts } from './composition.js';

describe('createControlModelTurnPorts', () => {
  const ports = createControlModelTurnPorts({ env: {}, cwd: process.cwd() });

  it('gives pi resources a model-turn port', () => {
    const pi = piModelResource({ id: 'x', provider: 'anthropic', model: 'm' });
    expect(ports(pi)).toBeDefined();
  });

  it('gives every other resource none, so it can never be pinned', () => {
    const pi = piModelResource({ id: 'x', provider: 'anthropic', model: 'm' });
    const other = { ...pi, runtime: { ...pi.runtime, adapter: 'echo' } };
    expect(ports(other as unknown as typeof pi)).toBeUndefined();
  });
});
