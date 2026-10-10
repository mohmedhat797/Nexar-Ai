export interface SubprocessResult {
  command: string;
  exitCode: number;
  signal: string | null;
  durationMs: number;
  timedOut: boolean;
  aborted: boolean;
  stdout: string;
  stderr: string;
  error: Error | null;
  statusOverride?: string;
  failureCategory?: string;
}

export function redactSecrets(text: string): string;
export function killProcessTree(pid: number | null): void;
export function spawnSubprocess(
  command: string,
  args?: string[],
  options?: {
    cwd?: string;
    env?: NodeJS.ProcessEnv;
    timeoutMs?: number;
    signal?: AbortSignal | null;
    onStdout?: ((data: string) => void) | null;
    onStderr?: ((data: string) => void) | null;
    windowsHide?: boolean;
  },
): Promise<SubprocessResult>;
