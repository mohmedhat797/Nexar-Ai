// Subprocess runner, timeout manager, process-tree termination, and secret redactor.
import { spawn, spawnSync } from 'node:child_process';

/**
 * Common patterns of credentials and secret material that must never leak into logs.
 */
const REDACTION_PATTERNS = [
  /(?:Bearer\s+)([a-zA-Z0-9_.~+/=-]{8,})/gi,
  /(?:token|key|secret|password|passwd|api_key|apikey|api-key|authorization)\s*[:=]\s*['"]?([a-zA-Z0-9_.~+/=-]{8,})['"]?/gi,
  /gh[pous]_[a-zA-Z0-9]{36}/g,
  /github_pat_[a-zA-Z0-9_]{82}/g,
  /sk-[a-zA-Z0-9]{20,}/g,
  /sk-proj-[a-zA-Z0-9_-]{20,}/g,
];

export function redactSecrets(text) {
  if (!text || typeof text !== 'string') return text;
  let clean = text;
  for (const pattern of REDACTION_PATTERNS) {
    clean = clean.replace(pattern, (match, captured) => {
      if (captured) {
        return match.replace(captured, '[REDACTED_SECRET]');
      }
      return '[REDACTED_SECRET]';
    });
  }
  return clean;
}

/**
 * Maximum characters retained per stdout/stderr stream to prevent memory exhaustion.
 */
const MAX_LOG_BUFFER_CHARS = 1_000_000;

function appendBoundedBuffer(currentBuffer, chunkText) {
  const combined = currentBuffer + chunkText;
  if (combined.length <= MAX_LOG_BUFFER_CHARS) {
    return combined;
  }
  const head = combined.substring(0, 200_000);
  const tail = combined.substring(combined.length - 750_000);
  return `${head}\n\n[...log buffer truncated for memory safety (${combined.length - 950_000} chars omitted)...]\n\n${tail}`;
}

/**
 * Kills a process and all its child descendants cleanly.
 */
export function killProcessTree(pid) {
  if (!pid) return;
  try {
    if (process.platform === 'win32') {
      spawnSync('taskkill', ['/pid', String(pid), '/T', '/F'], {
        stdio: 'ignore',
        windowsHide: true,
      });
    } else {
      process.kill(-pid, 'SIGKILL');
    }
  } catch {
    // Process might have already exited
    try {
      process.kill(pid, 'SIGKILL');
    } catch {
      // ignore
    }
  }
}

/**
 * Spawns a process with timeout, cancellation, tree-kill, and secret redaction.
 */
export async function spawnSubprocess(command, args = [], options = {}) {
  const {
    cwd = process.cwd(),
    env = process.env,
    timeoutMs = 300_000,
    signal = null,
    onStdout = null,
    onStderr = null,
    onSpawn = null,
    windowsHide = true,
  } = options;

  const startTime = Date.now();
  if (signal?.aborted) {
    return {
      command: redactSecrets(`${command} ${args.join(' ')}`.trim()),
      exitCode: 130,
      signal: 'SIGINT',
      durationMs: 0,
      timedOut: false,
      aborted: true,
      settled: true,
      stdout: '',
      stderr: '',
      error: new Error('Subprocess was cancelled before spawn'),
    };
  }
  let timedOut = false;
  let aborted = false;
  let stdoutBuffer = '';
  let stderrBuffer = '';

  return new Promise((resolve) => {
    let resolved = false;
    let timer = null;
    let onAbortListener = null;

    let execCmd = command;
    let execArgs = args;

    // Handle Windows .cmd/.bat execution safely without triggering Node DEP0190
    if (
      process.platform === 'win32' &&
      (command.endsWith('.cmd') ||
        command.endsWith('.bat') ||
        command === 'pnpm' ||
        command === 'npm')
    ) {
      execCmd = 'cmd.exe';
      execArgs = ['/d', '/s', '/c', command, ...args];
    }

    const child = spawn(execCmd, execArgs, {
      cwd,
      // Windows treats environment names case-insensitively, but Node chooses only
      // one duplicate key. Preserve the explicitly supplied PATH over inherited Path.
      env: process.platform === 'win32' ? normalizeWindowsEnv(env) : env,
      stdio: ['ignore', 'pipe', 'pipe'],
      detached: process.platform !== 'win32',
      windowsHide,
    });

    child.once('spawn', () => {
      if (onSpawn) onSpawn(child.pid);
    });

    const cleanup = () => {
      if (timer) {
        clearTimeout(timer);
        timer = null;
      }
      if (signal && onAbortListener) {
        signal.removeEventListener('abort', onAbortListener);
        onAbortListener = null;
      }
    };

    const finish = (result) => {
      if (resolved) return;
      resolved = true;
      cleanup();
      const durationMs = Date.now() - startTime;
      resolve({
        command: redactSecrets(`${command} ${args.join(' ')}`.trim()),
        exitCode: result.exitCode ?? 1,
        signal: result.signal ?? null,
        durationMs,
        timedOut,
        aborted,
        settled: result.settled ?? true,
        stdout: redactSecrets(stdoutBuffer),
        stderr: redactSecrets(stderrBuffer),
        error: result.error ?? null,
      });
    };

    let terminating = false;
    let terminationExitCode = 0;
    let terminationSig = null;
    let terminationError = null;

    const terminateWithSettlement = (defaultExitCode, defaultSig, errorMsg) => {
      terminating = true;
      terminationExitCode = defaultExitCode;
      terminationSig = defaultSig;
      terminationError = new Error(errorMsg);

      killProcessTree(child.pid);

      const settlementTimer = setTimeout(() => {
        if (!resolved) {
          killProcessTree(child.pid);
          finish({
            exitCode: defaultExitCode,
            signal: defaultSig,
            error: terminationError,
            settled: false,
          });
        }
      }, 3000);
      if (settlementTimer.unref) settlementTimer.unref();
    };

    if (timeoutMs > 0) {
      timer = setTimeout(() => {
        timedOut = true;
        terminateWithSettlement(124, 'SIGKILL', `Subprocess timed out after ${timeoutMs}ms`);
      }, timeoutMs);
    }

    if (signal) {
      if (signal.aborted) {
        aborted = true;
        terminateWithSettlement(130, 'SIGINT', 'Subprocess was cancelled by signal');
      }
      onAbortListener = () => {
        aborted = true;
        terminateWithSettlement(130, 'SIGINT', 'Subprocess was cancelled by signal');
      };
      signal.addEventListener('abort', onAbortListener, { once: true });
    }

    child.stdout.on('data', (chunk) => {
      const text = chunk.toString('utf8');
      stdoutBuffer = appendBoundedBuffer(stdoutBuffer, text);
      if (onStdout) onStdout(text);
    });

    child.stderr.on('data', (chunk) => {
      const text = chunk.toString('utf8');
      stderrBuffer = appendBoundedBuffer(stderrBuffer, text);
      if (onStderr) onStderr(text);
    });

    child.on('error', (err) => {
      finish({ exitCode: 1, signal: null, error: err, settled: true });
    });

    child.on('close', (code, sig) => {
      if (terminating) {
        finish({
          exitCode: terminationExitCode,
          signal: sig ?? terminationSig,
          error: terminationError,
          settled: true,
        });
      } else {
        finish({ exitCode: code, signal: sig, error: null, settled: true });
      }
    });
  });
}

export function normalizeWindowsEnv(env) {
  const result = { ...env };
  const pathKey = Object.keys(env).find((key) => key.toLowerCase() === 'path');
  const pathValue = env.PATH ?? (pathKey ? env[pathKey] : undefined);
  for (const key of Object.keys(result)) {
    if (key.toLowerCase() === 'path') delete result[key];
  }
  if (pathValue !== undefined) result.PATH = pathValue;
  return result;
}
