import { NexarError } from '@nexar/contracts';

/** Races work against cancellation, a deadline, and externally reported failures (e.g. spawn errors). */
export class RunGuard {
  private readonly failure: Promise<never>;
  private rejectFailure!: (error: NexarError) => void;
  private timer: NodeJS.Timeout | undefined;
  private readonly onAbort: () => void;
  private tripped = false;

  constructor(
    private readonly signal: AbortSignal,
    timeoutMs: number,
  ) {
    this.failure = new Promise<never>((_, reject) => {
      this.rejectFailure = reject;
    });
    // The failure promise may never be awaited again after the run ends.
    this.failure.catch(() => undefined);

    this.onAbort = () =>
      this.fail(new NexarError('EXECUTION_CANCELLED', 'execution was cancelled'));
    if (signal.aborted) {
      this.onAbort();
    } else {
      signal.addEventListener('abort', this.onAbort, { once: true });
    }
    this.timer = setTimeout(() => {
      this.fail(
        new NexarError('EXECUTION_TIMEOUT', `dsh run exceeded ${String(timeoutMs)} ms`, {
          details: { timeoutMs },
        }),
      );
    }, timeoutMs);
  }

  /** True once cancellation, timeout or `fail` has fired: the runtime must be killed, not asked nicely. */
  get interrupted(): boolean {
    return this.tripped;
  }

  fail(error: NexarError): void {
    this.tripped = true;
    this.rejectFailure(error);
  }

  race<T>(work: Promise<T>): Promise<T> {
    return Promise.race([work, this.failure]);
  }

  dispose(): void {
    if (this.timer !== undefined) clearTimeout(this.timer);
    this.timer = undefined;
    this.signal.removeEventListener('abort', this.onAbort);
  }
}
