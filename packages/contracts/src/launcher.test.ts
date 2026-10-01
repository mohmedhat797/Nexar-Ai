import { describe, expect, expectTypeOf, it } from 'vitest';

import { NEXAR_ERROR_CODES } from './index.js';
import type { ExecutionContext, LaunchSpec, NetworkPolicy, ProcessLauncher } from './index.js';

describe('launcher contract', () => {
  it('has a sandbox-unavailable error code for fail-closed launchers', () => {
    expect(NEXAR_ERROR_CODES).toContain('SANDBOX_UNAVAILABLE');
  });

  it('network policy is either none or an explicit proxy allowlist', () => {
    expectTypeOf<{ mode: 'none' }>().toExtend<NetworkPolicy>();
    expectTypeOf<{ mode: 'proxy'; allowHosts: string[] }>().toExtend<NetworkPolicy>();
    expectTypeOf<{ mode: 'open' }>().not.toExtend<NetworkPolicy>();
  });

  it('a launch spec carries a complete env and the workspace access mode', () => {
    expectTypeOf<LaunchSpec['env']>().toEqualTypeOf<Readonly<Record<string, string>>>();
    expectTypeOf<LaunchSpec['workspaceAccess']>().toEqualTypeOf<'read-only' | 'read-write'>();
  });

  it('the execution context exposes the workspace and its launcher optionally', () => {
    expectTypeOf<
      NonNullable<ExecutionContext['workspace']>['launcher']
    >().toEqualTypeOf<ProcessLauncher>();
  });
});
