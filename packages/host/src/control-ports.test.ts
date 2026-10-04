import { piModelResource } from '@nexar/integration-pi';
import { describe, expect, it } from 'vitest';
import { createControlModelTurnPorts, sandboxVisibleNode } from './composition.js';

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

describe('sandboxVisibleNode', () => {
  const win = process.platform === 'win32';
  const root = win ? String.raw`C:\tools\node` : '/opt/node';
  const node = win ? String.raw`C:\tools\node\node.exe` : '/opt/node/bin/node';
  const other = win ? String.raw`C:\other` : '/usr/local/other';

  it('offers this Node only when a toolchain mount contains it', () => {
    expect(sandboxVisibleNode([root], node)).toBe(node);
    expect(sandboxVisibleNode([other], node)).toBeUndefined();
    expect(sandboxVisibleNode([], node)).toBeUndefined();
    // The mount itself is not the executable.
    expect(sandboxVisibleNode([node], node)).toBeUndefined();
  });
});
