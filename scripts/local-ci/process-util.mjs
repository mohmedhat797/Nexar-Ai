// Subprocess runner, timeout manager, process-tree termination, and secret redactor.
import { spawn, spawnSync } from 'node:child_process';

/**
 * Common patterns of credentials and secret material that must never leak into logs.
 */
const REDACTION_PATTERNS = [
  /(?:Bearer|token|key|secret|password|passwd|authorization)\s*[:=]\s*['"]?([a-zA-Z0-9_\-.~+/=]{8,})['"]?/gi,
  /ghp_[a-zA-Z0-9]{36}/g,
  /github_pat_[a-zA-Z0-9_]{82}/g,
  /sk-[a-zA-Z0-9]{20,}/g,
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
    windowsHide = true,
  } = options;

  const startTime = Date.now();
  let timedOut = false;
  let aborted = false;
  let stdoutBuffer = '';
  let stderrBuffer = '';

  return new Promise((resolve) => {
    let resolved = false;
    let timer = null;

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
      env,
      stdio: ['ignore', 'pipe', 'pipe'],
      detached: process.platform !== 'win32',
      windowsHide,
    });

    const cleanup = () => {
      if (timer) {
        clearTimeout(timer);
        timer = null;
      }
    };

    const finish = (result) => {
      if (resolved) return;
      resolved = true;
      cleanup();
      const durationMs = Date.now() - startTime;
      resolve({
        command: `${command} ${args.join(' ')}`.trim(),
        exitCode: result.exitCode ?? (timedOut || aborted ? 1 : 0),
        signal: result.signal ?? null,
        durationMs,
        timedOut,
        aborted,
        stdout: redactSecrets(stdoutBuffer),
        stderr: redactSecrets(stderrBuffer),
        error: result.error ?? null,
      });
    };

    if (timeoutMs > 0) {
      timer = setTimeout(() => {
        timedOut = true;
        killProcessTree(child.pid);
        finish({
          exitCode: 124,
          signal: 'SIGKILL',
          error: new Error(`Subprocess timed out after ${timeoutMs}ms`),
        });
      }, timeoutMs);
    }

    if (signal) {
      if (signal.aborted) {
        aborted = true;
        killProcessTree(child.pid);
        finish({
          exitCode: 130,
          signal: 'SIGINT',
          error: new Error('Subprocess was cancelled by signal'),
        });
        return;
      }
      signal.addEventListener(
        'abort',
        () => {
          aborted = true;
          killProcessTree(child.pid);
          finish({
            exitCode: 130,
            signal: 'SIGINT',
            error: new Error('Subprocess was cancelled by signal'),
          });
        },
        { once: true },
      );
    }

    child.stdout.on('data', (chunk) => {
      const text = chunk.toString('utf8');
      stdoutBuffer += text;
      if (onStdout) onStdout(text);
    });

    child.stderr.on('data', (chunk) => {
      const text = chunk.toString('utf8');
      stderrBuffer += text;
      if (onStderr) onStderr(text);
    });

    child.on('error', (err) => {
      finish({ exitCode: 1, signal: null, error: err });
    });

    child.on('close', (code, sig) => {
      finish({ exitCode: code, signal: sig, error: null });
    });
  });
}
