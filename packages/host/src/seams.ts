import type { ProcessLauncher } from '@nexar/contracts';
import type { EngineeringRunner } from '@nexar/engineering';

/** The slice of the process environment the composition reads (the CLI's `CliIo` satisfies it). */
export interface HostEnvironment {
  readonly env: Readonly<Record<string, string | undefined>>;
  readonly cwd: string;
}

/** What the engineering commands need from the runner; tests substitute a fake. */
export type EngineeringRunnerPort = Pick<EngineeringRunner, 'run' | 'cleanup'>;

/** Test seams for the engineering composition. */
export interface EngineeringSeams {
  readonly runner?: EngineeringRunnerPort;
  readonly launcher?: ProcessLauncher;
}
