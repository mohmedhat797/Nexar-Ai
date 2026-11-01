import type { NativeSubscriptionRuntime, SubscriptionRuntimeId } from '@nexar/contracts';
import { createClaudeSubscription } from '@nexar/integration-claude-code';
import { createCodexSubscription } from '@nexar/integration-codex';
import { createAntigravitySubscription } from '@nexar/integration-antigravity';

/** The Codex port for one private home; any parent CODEX_HOME, in any case, is dropped. */
export function ownerCodexSubscription(
  options: Parameters<typeof createCodexSubscription>[0] & { readonly home: string },
): NativeSubscriptionRuntime {
  const { home, ...rest } = options;
  const env = Object.fromEntries(
    Object.entries(options.env).filter(([name]) => name.toUpperCase() !== 'CODEX_HOME'),
  );
  return createCodexSubscription({
    ...rest,
    env: { ...env, CODEX_HOME: home },
    requireHome: true,
  });
}

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
