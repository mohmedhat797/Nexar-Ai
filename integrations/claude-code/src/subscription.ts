import { isAbsolute } from 'node:path';
import type { NativeSubscriptionProbe, NativeSubscriptionRuntime } from '@nexar/contracts';
import { publicRuntimeEnvironment, runRuntimeCommand } from '@nexar/process';

export interface ClaudeSubscriptionOptions {
  readonly env: NodeJS.ProcessEnv;
  readonly cwd: string;
  readonly command?: string;
  readonly runCommand?: typeof runRuntimeCommand;
}

/** Uses only vendor commands; account identifiers and credential output stay inside this port. */
export function createClaudeSubscription(
  options: ClaudeSubscriptionOptions,
): NativeSubscriptionRuntime {
  const run = options.runCommand ?? runRuntimeCommand;
  const environment = () => {
    const env = publicRuntimeEnvironment(options.env);
    const names = Object.keys(options.env).filter((name) =>
      process.platform === 'win32'
        ? name.toUpperCase() === 'CLAUDE_CONFIG_DIR'
        : name === 'CLAUDE_CONFIG_DIR',
    );
    const value = names.length === 1 ? options.env[names[0]!] : undefined;
    if (
      value !== undefined &&
      value.length <= 4096 &&
      !Array.from(value).some(
        (character) => character.charCodeAt(0) < 32 || character.charCodeAt(0) === 127,
      ) &&
      isAbsolute(value) &&
      (process.platform !== 'win32' || /^(?:[A-Za-z]:[\\/]|\\\\[^\\]+\\[^\\]+)/.test(value))
    ) {
      env.CLAUDE_CONFIG_DIR = value;
    }
    return env;
  };
  const command = (args: string[], signal: AbortSignal, interaction: 'probe' | 'browser') =>
    run({
      command: options.command ?? 'claude',
      args,
      cwd: options.cwd,
      env: environment(),
      signal,
      timeoutMs: interaction === 'probe' ? 10_000 : 300_000,
      interaction,
      maxOutputBytes: 16 * 1024,
    });
  const probe = (
    status: NativeSubscriptionProbe['status'],
    authMode: NativeSubscriptionProbe['authMode'],
    version?: string,
  ): NativeSubscriptionProbe => ({
    status,
    authMode,
    loginSupported: true,
    ...(version === undefined ? {} : { version }),
  });
  return {
    async probe(signal) {
      try {
        if (signal.aborted) return probe('unknown', 'unknown');
        const installed = await command(['--version'], signal, 'probe');
        if (signal.aborted) return probe('unknown', 'unknown');
        if (installed.kind !== 'exited')
          return probe(installed.kind === 'unavailable' ? 'unavailable' : 'unknown', 'unknown');
        if (installed.exitCode !== 0) return probe('unavailable', 'unknown');
        const output = installed.stdout.trim().replace(/ \(Claude Code\)$/, '');
        const version =
          output.length <= 100
            ? /^(\d{1,5}\.\d{1,5}\.\d{1,5})(?:-[A-Za-z0-9]+(?:[.-][A-Za-z0-9]+)*)?(?:\+[A-Za-z0-9]+(?:[.-][A-Za-z0-9]+)*)?$/.exec(
                output,
              )?.[1]
            : undefined;
        const auth = await command(['auth', 'status'], signal, 'probe');
        if (signal.aborted) return probe('unknown', 'unknown', version);
        if (auth.kind !== 'exited')
          return probe(auth.kind === 'unavailable' ? 'unavailable' : 'unknown', 'unknown', version);
        const value: unknown = JSON.parse(auth.stdout);
        if (typeof value !== 'object' || value === null || Array.isArray(value))
          return probe('unknown', 'unknown', version);
        const state = value as { loggedIn?: unknown; authMethod?: unknown };
        if (
          state.loggedIn === false &&
          state.authMethod === 'none' &&
          (auth.exitCode === 0 || auth.exitCode === 1)
        )
          return probe('not-connected', 'none', version);
        if (state.loggedIn !== true || auth.exitCode !== 0)
          return probe('unknown', 'unknown', version);
        if (state.authMethod === 'claude.ai') return probe('connected', 'vendor-account', version);
        if (state.authMethod === 'api_key' || state.authMethod === 'api_key_helper')
          return probe('not-connected', 'api-key', version);
        return probe('unknown', 'unknown', version);
      } catch {
        return probe('unknown', 'unknown');
      }
    },
    async login(signal) {
      try {
        if (signal.aborted) return 'cancelled';
        const result = await command(['auth', 'login'], signal, 'browser');
        if (signal.aborted) return 'cancelled';
        if (result.kind === 'exited') return result.exitCode === 0 ? 'succeeded' : 'failed';
        if (
          result.kind === 'cancelled' ||
          result.kind === 'timed-out' ||
          result.kind === 'unavailable'
        )
          return result.kind;
        return 'failed';
      } catch {
        return 'unavailable';
      }
    },
  };
}
