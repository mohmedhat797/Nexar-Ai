import type { NativeSubscriptionRuntime, SubscriptionRuntimeId } from '@nexar/contracts';
import { createClaudeSubscription } from '@nexar/integration-claude-code';
import { createCodexSubscription } from '@nexar/integration-codex';
import { createAntigravitySubscription } from '@nexar/integration-antigravity';

/** Compose native profile ports in the host; the desktop never knows vendor argv or binaries. */
export function createNativeSubscriptions(options: {
  readonly env: NodeJS.ProcessEnv;
  readonly cwd: string;
}): Readonly<Record<SubscriptionRuntimeId, NativeSubscriptionRuntime>> {
  return {
    'claude-code': createClaudeSubscription(options),
    codex: createCodexSubscription(options),
    antigravity: createAntigravitySubscription(options),
  };
}
