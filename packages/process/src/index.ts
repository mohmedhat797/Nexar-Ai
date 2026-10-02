import { spawn } from 'node:child_process';
import type { SpawnOptions } from 'node:child_process';
import { readFileSync, statSync } from 'node:fs';
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
    if (dir === '' && !explicit) continue;
    for (const extension of extensions) {
      const candidate = resolve(cwd, dir, `${command}${extension}`);
      if (isFile(candidate)) return candidate;
    }
  }
  return undefined;
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
  if (process.platform !== 'win32') return spawn(command, args, options);
  const cwd =
    options.cwd === undefined
      ? process.cwd()
      : options.cwd instanceof URL
        ? fileURLToPath(options.cwd)
        : options.cwd;
  const env = options.env ?? process.env;
  const binary = windowsBinary(command, cwd, env);
  if (binary === undefined) {
    // Windows CreateProcess searches cwd implicitly; a project must not supply the runtime.
    throw new NexarError('INTEGRATION_UNAVAILABLE', 'Windows runtime executable is unavailable');
  }
  if (!/\.(cmd|bat)$/i.test(binary)) {
    return spawn(binary, args, { ...options, windowsHide: true, shell: false });
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
  return spawn(node, [entrypoint, ...args], { ...options, windowsHide: true, shell: false });
}) as typeof spawn;
