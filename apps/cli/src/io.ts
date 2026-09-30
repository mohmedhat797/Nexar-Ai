/** Everything the CLI touches in the outside world, injected so commands are testable in-process. */
export interface CliIo {
  readonly stdout: (s: string) => void;
  readonly stderr: (s: string) => void;
  readonly env: NodeJS.ProcessEnv;
  readonly cwd: string;
  readonly stdin?: () => Promise<string>;
}

export const EXIT = {
  ok: 0,
  failure: 1,
  usage: 2,
  noEligibleResource: 3,
  authRequired: 4,
  timeoutOrCancelled: 5,
} as const;

/** Bad command line; reported with usage and exit code 2. */
export class UsageError extends Error {
  override readonly name = 'UsageError';
}
