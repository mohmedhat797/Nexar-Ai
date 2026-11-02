import { isAbsolute } from 'node:path';
import {
  NexarError,
  type NativeSubscriptionProbe,
  type NativeSubscriptionRuntime,
} from '@nexar/contracts';
import { publicRuntimeEnvironment, runRuntimeCommand } from '@nexar/process';

export interface CodexSubscriptionOptions {
  readonly env: NodeJS.ProcessEnv;
  readonly cwd: string;
  readonly command?: string;
  readonly runCommand?: typeof runRuntimeCommand;
  /** Nothing runs unless CODEX_HOME is usable: an owner connection never reaches the vendor default. */
  readonly requireHome?: boolean;
}

/** ChatGPT account status is distinct from API-key or enterprise authentication. */
export function createCodexSubscription(
  options: CodexSubscriptionOptions,
): NativeSubscriptionRuntime {
  const run = options.runCommand ?? runRuntimeCommand;
  const environment = () => {
    const env = publicRuntimeEnvironment(options.env);
    const names = Object.keys(options.env).filter((name) =>
      process.platform === 'win32' ? name.toUpperCase() === 'CODEX_HOME' : name === 'CODEX_HOME',
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
      env.CODEX_HOME = value;
    }
    if (options.requireHome === true && env.CODEX_HOME === undefined) {
      throw new NexarError('CONFIGURATION_ERROR', 'Codex home is not usable');
    }
    return env;
  };
  const command = (args: string[], signal: AbortSignal, interaction: 'probe' | 'browser') =>
    run({
      command: options.command ?? 'codex',
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
        const versionOutput = installed.stdout.trim().replace(/^codex-cli /, '');
        const version =
          versionOutput.length <= 100
            ? /^(\d{1,5}\.\d{1,5}\.\d{1,5})(?:-[A-Za-z0-9]+(?:[.-][A-Za-z0-9]+)*)?(?:\+[A-Za-z0-9]+(?:[.-][A-Za-z0-9]+)*)?$/.exec(
                versionOutput,
              )?.[1]
            : undefined;
        const auth = await command(['login', 'status'], signal, 'probe');
        if (signal.aborted) return probe('unknown', 'unknown', version);
        if (auth.kind !== 'exited')
          return probe(auth.kind === 'unavailable' ? 'unavailable' : 'unknown', 'unknown', version);
        const output = `${auth.stdout}\n${auth.stderr}`.trim();
        if (auth.exitCode === 0 && output === 'Logged in using ChatGPT')
          return probe('connected', 'vendor-account', version);
        if ((auth.exitCode === 0 || auth.exitCode === 1) && output === 'Not logged in')
          return probe('not-connected', 'none', version);
        if (auth.exitCode === 0 && /^Logged in using an API key(?: - [^\r\n]*)?$/.test(output))
          return probe('not-connected', 'api-key', version);
        return probe('unknown', 'unknown', version);
      } catch {
        return probe('unknown', 'unknown');
      }
    },
    async login(signal) {
      try {
        if (signal.aborted) return 'cancelled';
        const result = await command(['login'], signal, 'browser');
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
