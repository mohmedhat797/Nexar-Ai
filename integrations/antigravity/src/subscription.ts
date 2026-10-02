import type { NativeSubscriptionProbe, NativeSubscriptionRuntime } from '@nexar/contracts';
import { publicRuntimeEnvironment, runRuntimeCommand } from '@nexar/process';

export interface AntigravitySubscriptionOptions {
  readonly env: NodeJS.ProcessEnv;
  readonly cwd: string;
  readonly command?: string;
  readonly runCommand?: typeof runRuntimeCommand;
}

/** No supported noninteractive account-only login/status command has been verified for agy. */
export function createAntigravitySubscription(
  options: AntigravitySubscriptionOptions,
): NativeSubscriptionRuntime {
  const run = options.runCommand ?? runRuntimeCommand;
  const probe = (
    status: NativeSubscriptionProbe['status'],
    version?: string,
  ): NativeSubscriptionProbe => ({
    status,
    authMode: 'unknown',
    loginSupported: false,
    ...(version === undefined ? {} : { version }),
  });
  return {
    async probe(signal) {
      try {
        if (signal.aborted) return probe('unknown');
        const result = await run({
          command: options.command ?? 'agy',
          args: ['--version'],
          cwd: options.cwd,
          env: publicRuntimeEnvironment(options.env),
          signal,
          timeoutMs: 10_000,
          interaction: 'probe',
          maxOutputBytes: 16 * 1024,
        });
        if (signal.aborted) return probe('unknown');
        if (result.kind !== 'exited')
          return probe(result.kind === 'unavailable' ? 'unavailable' : 'unknown');
        if (result.exitCode !== 0) return probe('unavailable');
        const output = result.stdout.trim();
        const version =
          output.length <= 100
            ? /^(\d{1,5}\.\d{1,5}\.\d{1,5})(?:-[A-Za-z0-9]+(?:[.-][A-Za-z0-9]+)*)?(?:\+[A-Za-z0-9]+(?:[.-][A-Za-z0-9]+)*)?$/.exec(
                output,
              )?.[1]
            : undefined;
        return probe('unknown', version);
      } catch {
        return probe('unknown');
      }
    },
    login() {
      return Promise.resolve('unavailable' as const);
    },
  };
}
