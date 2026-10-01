import { describe, expect, it } from 'vitest';
import { AntigravityExecutionAdapter, antigravityResource } from './index.js';

// Opt-in: runs the real `agy` binary, but ONLY the free probe (`--version`, `models`): no prompt,
// no execute, never `-p`. Needs NEXAR_AGY_BIN pointing at the binary. Never runs in CI.
describe.skipIf(!process.env['NEXAR_AGY_BIN'])('antigravity (live probe only)', () => {
  it('probes the installed binary without sending a prompt', async () => {
    const adapter = new AntigravityExecutionAdapter({ binary: process.env['NEXAR_AGY_BIN'] ?? '' });
    const state = await adapter.probe(antigravityResource(), AbortSignal.timeout(15_000));
    expect(['degraded', 'available']).toContain(state.availability);
    expect(['authenticated', 'unauthenticated', 'unknown']).toContain(state.auth);
  }, 20_000);
});
