import { execFile, spawn } from 'node:child_process';
import type { ChildProcess, SpawnOptions } from 'node:child_process';
import { accessSync, constants, readFileSync, statSync } from 'node:fs';
import { delimiter, dirname, extname, isAbsolute, join, resolve } from 'node:path';
import { NexarError } from '@nexar/contracts';
import { fileURLToPath } from 'node:url';

function envValue(env: NodeJS.ProcessEnv, name: string): string | undefined {
  const key = Object.keys(env).find((key) => key.toUpperCase() === name);
  return key === undefined ? undefined : env[key];
}

function isFile(path: string): boolean {
  try {
    return statSync(path).isFile();
  } catch {
    return false;
  }
}

/** Resolves only executable candidates; never launches a probe or reads credentials. */
function windowsBinary(command: string, cwd: string, env: NodeJS.ProcessEnv): string | undefined {
  const explicit = isAbsolute(command) || /[\\/]/.test(command);
  const dirs = explicit
    ? ['']
    : (envValue(env, 'PATH') ?? '').split(delimiter).map((dir) => dir.replace(/^"|"$/g, ''));
  const extensions =
    extname(command) === ''
      ? (envValue(env, 'PATHEXT') ?? '.COM;.EXE;.BAT;.CMD')
          .split(';')
          .filter((extension) => /^\.[A-Za-z0-9]+$/.test(extension))
      : [''];
  for (const dir of dirs) {
    // Do not search the current directory implicitly via empty PATH entries.
    if (!explicit && !isAbsolute(dir)) continue;
    for (const extension of extensions) {
      const candidate = resolve(cwd, dir, `${command}${extension}`);
      if (isFile(candidate)) return candidate;
    }
  }
  return undefined;
}

function posixBinary(command: string, cwd: string, env: NodeJS.ProcessEnv): string | undefined {
  const explicit = command.includes('/');
  const candidates = explicit
    ? [resolve(cwd, command)]
    : (env['PATH'] ?? '')
        .split(delimiter)
        .filter((dir) => isAbsolute(dir))
        .map((dir) => join(dir, command));
  return candidates.find((candidate) => {
    try {
      if (!isFile(candidate)) return false;
      accessSync(candidate, constants.X_OK);
      return true;
    } catch {
      return false;
    }
  });
}

/**
 * Native spawn with Windows npm shim support. Rather than invoking a shell, a supported Node shim
 * is resolved to its script entrypoint and launched with node.exe. Arbitrary batch programs are
 * refused: their argument expansion cannot safely carry untrusted prompts.
 */
export const spawnRuntime = ((
  command: string,
  argsOrOptions?: readonly string[] | SpawnOptions,
  maybeOptions?: SpawnOptions,
) => {
  const args: readonly string[] = Array.isArray(argsOrOptions) ? argsOrOptions : [];
  const options = ((Array.isArray(argsOrOptions) ? maybeOptions : argsOrOptions) ??
    {}) as SpawnOptions;
  const cwd =
    options.cwd === undefined
      ? process.cwd()
      : options.cwd instanceof URL
        ? fileURLToPath(options.cwd)
        : options.cwd;
  const env = options.env ?? process.env;
  const safeOptions = { ...options, windowsHide: options.windowsHide ?? true, shell: false };
  if (process.platform !== 'win32') {
    const binary = posixBinary(command, cwd, env);
    if (binary === undefined) {
      throw new NexarError('INTEGRATION_UNAVAILABLE', 'Runtime executable is unavailable');
    }
    return spawn(binary, args, safeOptions);
  }
  const binary = windowsBinary(command, cwd, env);
  if (binary === undefined) {
    // Windows CreateProcess searches cwd implicitly; a project must not supply the runtime.
    throw new NexarError('INTEGRATION_UNAVAILABLE', 'Windows runtime executable is unavailable');
  }
  if (!/\.(cmd|bat)$/i.test(binary)) {
    return spawn(binary, args, safeOptions);
  }
  const size = statSync(binary).size;
  const shim = size <= 32 * 1024 ? readFileSync(binary, 'utf8') : '';
  // npm cmd-shim's local/global Node entrypoint; no shell interpolation is evaluated.
  const match = /"(?:%dp0%|%~dp0)([^"\r\n%!*?]+\.(?:js|cjs|mjs))"\s+%\*/i.exec(shim);
  const script = match?.[1];
  if (script === undefined) {
    throw new NexarError(
      'INTEGRATION_UNAVAILABLE',
      'Windows runtime needs an executable or a supported Node npm shim',
    );
  }
  const entrypoint = resolve(dirname(binary), script.replace(/^[\\/]/, ''));
  if (!isFile(entrypoint)) {
    throw new NexarError('INTEGRATION_UNAVAILABLE', 'Windows runtime entrypoint is unavailable');
  }
  const localNode = join(dirname(binary), 'node.exe');
  const node = isFile(localNode) ? localNode : windowsBinary('node.exe', cwd, env);
  if (node === undefined) {
    throw new NexarError('INTEGRATION_UNAVAILABLE', 'Windows npm runtime requires Node.js on PATH');
  }
  return spawn(node, [entrypoint, ...args], safeOptions);
}) as typeof spawn;

const PUBLIC_ENVIRONMENT = [
  'PATH',
  'HOME',
  'USER',
  'LANG',
  'LC_ALL',
  'LC_CTYPE',
  'TERM',
  'DISPLAY',
  'WAYLAND_DISPLAY',
  'XDG_RUNTIME_DIR',
  'XDG_SESSION_TYPE',
  'XDG_CURRENT_DESKTOP',
  'DESKTOP_SESSION',
  'DBUS_SESSION_BUS_ADDRESS',
  'XDG_CONFIG_HOME',
  'XDG_DATA_HOME',
  'XDG_CACHE_HOME',
] as const;
const WINDOWS_ENVIRONMENT = [
  'SystemRoot',
  'SystemDrive',
  'windir',
  'ComSpec',
  'PATHEXT',
  'USERNAME',
  'USERPROFILE',
  'APPDATA',
  'LOCALAPPDATA',
  'TEMP',
  'TMP',
] as const;

/** Only public OS/GUI context; vendor-specific authentication variables belong to integrations. */
export function publicRuntimeEnvironment(
  parent: NodeJS.ProcessEnv,
  platform: NodeJS.Platform = process.platform,
): Record<string, string> {
  const env: Record<string, string> = {};
  for (const name of [
    ...PUBLIC_ENVIRONMENT,
    ...(platform === 'win32' ? WINDOWS_ENVIRONMENT : []),
  ]) {
    const key =
      platform === 'win32'
        ? Object.keys(parent).find((candidate) => candidate.toUpperCase() === name.toUpperCase())
        : name;
    const value = key === undefined ? undefined : parent[key];
    if (value !== undefined && value !== '') env[name] = value;
  }
  return env;
}

export interface RuntimeCommandOptions {
  readonly command: string;
  readonly args: readonly string[];
  readonly cwd: string;
  readonly env: NodeJS.ProcessEnv;
  readonly signal: AbortSignal;
  readonly timeoutMs: number;
  readonly interaction: 'probe' | 'browser';
  readonly spawnImpl?: typeof spawn;
  readonly maxOutputBytes?: number;
}

export interface RuntimeCommandResult {
  readonly kind: 'exited' | 'unavailable' | 'cancelled' | 'timed-out' | 'overflow';
  readonly exitCode?: number | null;
  readonly stdout: string;
  readonly stderr: string;
}

const MAX_COMMAND_OUTPUT_BYTES = 16 * 1024;
const TERMINATION_GRACE_MS = 250;
const CLOSE_GRACE_MS = 500;
const TREE_KILL_TIMEOUT_MS = 5_000;

function signalPosixGroup(child: ChildProcess, signal: NodeJS.Signals): void {
  try {
    if (child.pid !== undefined) process.kill(-child.pid, signal);
    else child.kill(signal);
  } catch {
    /* The group may already have exited. */
  }
}

function terminateWindowsTree(child: ChildProcess, env: NodeJS.ProcessEnv): Promise<void> {
  const systemRoot = envValue(env, 'SYSTEMROOT') ?? envValue(process.env, 'SYSTEMROOT');
  if (child.pid === undefined || systemRoot === undefined || !isAbsolute(systemRoot)) {
    try {
      child.kill();
    } catch {
      /* Best effort when Windows cannot identify the process tree. */
    }
    return Promise.resolve();
  }
  return new Promise((done) => {
    let finished = false;
    const finish = (): void => {
      if (finished) return;
      finished = true;
      clearTimeout(timer);
      done();
    };
    const timer = setTimeout(finish, TREE_KILL_TIMEOUT_MS + CLOSE_GRACE_MS);
    try {
      execFile(
        join(systemRoot, 'System32', 'taskkill.exe'),
        ['/pid', String(child.pid), '/t', '/f'],
        {
          env: { SystemRoot: systemRoot },
          shell: false,
          windowsHide: true,
          timeout: TREE_KILL_TIMEOUT_MS,
          maxBuffer: 8 * 1024,
        },
        (error) => {
          if (error !== null) {
            try {
              child.kill();
            } catch {
              /* The child may already have exited. */
            }
          }
          finish();
        },
      );
    } catch {
      try {
        child.kill();
      } catch {
        /* No process error or command details leave this API. */
      }
      finish();
    }
  });
}

/**
 * Non-generating vendor commands. Browser mode discards all output and supports only vendor-owned
 * callback/browser flows, not terminal prompts or manual device-code entry. On Windows a detached,
 * visible native console is requested; POSIX desktop apps do not acquire a terminal this way.
 * Abort/deadline kills the live tree. Windows descendants cannot be identified after their leader
 * exits without a Job Object; inherited pipes are closed after a bounded grace period instead.
 */
export function runRuntimeCommand(spec: RuntimeCommandOptions): Promise<RuntimeCommandResult> {
  const empty = (kind: RuntimeCommandResult['kind']): RuntimeCommandResult => ({
    kind,
    stdout: '',
    stderr: '',
  });
  if (spec.signal.aborted) return Promise.resolve(empty('cancelled'));
  const maxBytes = spec.maxOutputBytes ?? MAX_COMMAND_OUTPUT_BYTES;
  if (
    !Number.isFinite(spec.timeoutMs) ||
    spec.timeoutMs <= 0 ||
    spec.timeoutMs > 2_147_483_647 ||
    !Number.isSafeInteger(maxBytes) ||
    maxBytes <= 0
  ) {
    return Promise.resolve(empty('unavailable'));
  }
  const captureLimit = Math.min(maxBytes, MAX_COMMAND_OUTPUT_BYTES);
  const browser = spec.interaction === 'browser';
  return new Promise((resolveResult) => {
    let child: ChildProcess;
    try {
      child = (spec.spawnImpl ?? spawnRuntime)(spec.command, [...spec.args], {
        cwd: spec.cwd,
        env: spec.env,
        shell: false,
        windowsHide: !browser,
        detached: browser || process.platform !== 'win32',
        stdio: browser ? 'ignore' : ['ignore', 'pipe', 'pipe'],
      });
    } catch {
      resolveResult(empty('unavailable'));
      return;
    }

    const stdout: Buffer[] = [];
    const stderr: Buffer[] = [];
    let totalBytes = 0;
    let settled = false;
    let leaderExited = false;
    let exitCode: number | null = null;
    let stopping: Exclude<RuntimeCommandResult['kind'], 'exited'> | undefined;
    let killTimer: NodeJS.Timeout | undefined;
    let settleTimer: NodeJS.Timeout | undefined;
    let cleanup: Promise<void> = Promise.resolve();

    function finish(kind: RuntimeCommandResult['kind'], code?: number | null): void {
      if (settled) return;
      settled = true;
      clearTimeout(deadline);
      clearTimeout(killTimer);
      clearTimeout(settleTimer);
      spec.signal.removeEventListener('abort', onAbort);
      child.stdout?.removeListener('data', onStdout);
      child.stderr?.removeListener('data', onStderr);
      child.stdout?.destroy();
      child.stderr?.destroy();
      child.unref();
      const out = browser ? '' : Buffer.concat(stdout).toString('utf8');
      const err = browser ? '' : Buffer.concat(stderr).toString('utf8');
      // Invalid UTF-8 can expand into replacement characters; the returned strings stay bounded too.
      const decodedOverflow = Buffer.byteLength(out) + Buffer.byteLength(err) > captureLimit;
      const resultKind = decodedOverflow && kind === 'exited' ? 'overflow' : kind;
      const result: RuntimeCommandResult = {
        kind: resultKind,
        ...(resultKind === 'exited' ? { exitCode: code ?? null } : {}),
        stdout: decodedOverflow ? '' : out,
        stderr: decodedOverflow ? '' : err,
      };
      void cleanup.then(() => resolveResult(result));
    }

    function stop(kind: Exclude<RuntimeCommandResult['kind'], 'exited'>): void {
      if (settled || stopping !== undefined) return;
      stopping = kind;
      if (!leaderExited) {
        if (process.platform === 'win32') cleanup = terminateWindowsTree(child, spec.env);
        else {
          signalPosixGroup(child, 'SIGTERM');
          killTimer = setTimeout(() => signalPosixGroup(child, 'SIGKILL'), TERMINATION_GRACE_MS);
        }
      }
      settleTimer = setTimeout(
        () => finish(kind),
        process.platform === 'win32'
          ? TREE_KILL_TIMEOUT_MS + CLOSE_GRACE_MS
          : TERMINATION_GRACE_MS + CLOSE_GRACE_MS,
      );
    }

    function capture(chunks: Buffer[], chunk: Buffer | string): void {
      if (settled || stopping !== undefined) return;
      const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
      if (buffer.byteLength > captureLimit - totalBytes) {
        stop('overflow');
        return;
      }
      totalBytes += buffer.byteLength;
      chunks.push(buffer);
    }
    const onStdout = (chunk: Buffer | string): void => capture(stdout, chunk);
    const onStderr = (chunk: Buffer | string): void => capture(stderr, chunk);
    const onAbort = (): void => stop('cancelled');

    if (!browser) {
      child.stdout?.on('data', onStdout);
      child.stderr?.on('data', onStderr);
    }
    child.on('error', () => {
      if (child.pid === undefined) finish(stopping ?? 'unavailable');
      else stop('unavailable');
    });
    child.once('exit', (code: number | null) => {
      leaderExited = true;
      exitCode = code;
      if (process.platform !== 'win32' && (!browser || stopping !== undefined)) {
        signalPosixGroup(child, 'SIGKILL');
      }
      clearTimeout(settleTimer);
      settleTimer = setTimeout(() => finish(stopping ?? 'exited', exitCode), CLOSE_GRACE_MS);
    });
    child.once('close', (code: number | null) => finish(stopping ?? 'exited', code));
    const deadline = setTimeout(() => stop('timed-out'), spec.timeoutMs);
    spec.signal.addEventListener('abort', onAbort, { once: true });
    if (spec.signal.aborted) onAbort();
  });
}
