import { describe, expectTypeOf, it } from 'vitest';

import type { Capability, ResourceKind, RouteDecision } from './index.js';
import { unknownResourceState } from './index.js';

describe('type-level contracts', () => {
  it('Capability accepts custom strings and keeps known ones', () => {
    expectTypeOf<'coding'>().toExtend<Capability>();
    expectTypeOf<'my-custom-capability'>().toExtend<Capability>();
  });

  it('ResourceKind narrows on type', () => {
    const f = (k: ResourceKind): void => {
      if (k.type === 'model') {
        expectTypeOf(k.access).toEqualTypeOf<'api' | 'subscription' | 'local'>();
      } else if (k.type === 'agent') {
        expectTypeOf(k.agent).toBeString();
      } else {
        expectTypeOf(k.tool).toBeString();
        expectTypeOf(k.interface).toEqualTypeOf<'cli' | 'sdk' | 'rpc' | 'mcp' | 'http'>();
      }
    };
    expectTypeOf(f).toBeFunction();
  });

  it('RouteDecision narrows on outcome', () => {
    const f = (d: RouteDecision): void => {
      if (d.outcome === 'selected') {
        expectTypeOf(d.selected.eligible).toBeBoolean();
      } else {
        expectTypeOf(d).not.toHaveProperty('selected');
      }
    };
    expectTypeOf(f).toBeFunction();
  });

  it('unknownResourceState returns unknown state', () => {
    expectTypeOf(unknownResourceState('t').availability).toEqualTypeOf<
      'available' | 'degraded' | 'unavailable' | 'unknown'
    >();
  });
});
