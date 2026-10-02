import type { NexarErrorCode } from '@nexar/contracts';

/** Everything the CLI touches in the outside world, injected so commands are testable in-process. */
export interface CliIo {
  readonly stdout: (s: string) => void;
  readonly stderr: (s: string) => void;
  readonly env: NodeJS.ProcessEnv;
  readonly cwd: string;
  readonly stdin?: () => Promise<string>;
  /** Streaming standard input for long-lived protocol commands (`nexar plane serve`). */
  readonly stdinChunks?: () => AsyncIterable<string | Uint8Array>;
  /** Present only when a person can answer at a terminal; asks a yes/no question. */
  readonly confirm?: (question: string) => Promise<boolean>;
}

export const EXIT = {
  ok: 0,
  failure: 1,
  usage: 2,
  noEligibleResource: 3,
  authRequired: 4,
  timeoutOrCancelled: 5,
  /** `nexar engineer run` finished without a commit: review, gates or the owner said no. */
  notAccepted: 6,
  sandboxUnavailable: 7,
  /** Interrupted by SIGINT (128 + 2). */
  interrupted: 130,
} as const;

const EXIT_BY_CODE: Partial<Record<NexarErrorCode, number>> = {
  NO_ELIGIBLE_RESOURCE: EXIT.noEligibleResource,
  AUTH_REQUIRED: EXIT.authRequired,
  EXECUTION_TIMEOUT: EXIT.timeoutOrCancelled,
  EXECUTION_CANCELLED: EXIT.timeoutOrCancelled,
  SANDBOX_UNAVAILABLE: EXIT.sandboxUnavailable,
};

/** The exit code for an error code, `EXIT.failure` when none is specific. */
export function exitCodeFor(code: NexarErrorCode): number {
  return EXIT_BY_CODE[code] ?? EXIT.failure;
}

/** Bad command line; reported with usage and exit code 2. */
export class UsageError extends Error {
  override readonly name = 'UsageError';
}
