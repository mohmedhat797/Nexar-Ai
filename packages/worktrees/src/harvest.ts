import { spawn } from 'node:child_process';
import { createWriteStream } from 'node:fs';
import { readFile, realpath, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { NexarError, type ProcessLauncher } from '@nexar/contracts';
import { parsePatch } from './patch-parse.js';
import { validatePatch } from './patch-policy.js';
import type { HarvestResult, PatchPolicy, TaskWorktree } from './types.js';
import { DEFAULT_MAX_PATCH_BYTES, nextIndex, OBJECT_ID_PATTERN } from './util.js';

const SANDBOX_BASE_GIT = '/opt/nexar/base.git';

/**
 * Constant script: values arrive only through the environment. It reads the agent's working tree
 * but uses Nexar's pristine bare repository (and its config) as `GIT_DIR`, so nothing in the
 * agent's own `.git` (config, hooks, fsmonitor, filters) is ever consulted. Git ignores `.git`
 * entries in the work tree, so `git add -A` never stages the agent's repository metadata.
 * Scratch files live under `$HOME` (`/tmp` inside the sandbox) because the mounts are read-only.
 */
const HARVEST_SCRIPT = [
  'set -eu',
  'export GIT_DIR="$NEXAR_GIT_DIR" GIT_WORK_TREE="$PWD" GIT_INDEX_FILE="$HOME/nexar-idx"',
  'export GIT_OBJECT_DIRECTORY="$HOME/nexar-objs" GIT_ALTERNATE_OBJECT_DIRECTORIES="$NEXAR_GIT_DIR/objects"',
  'mkdir -p "$GIT_OBJECT_DIRECTORY"',
  'git read-tree "$NEXAR_BASE"',
  'git add -A -- .',
  'git -c core.quotePath=true -c diff.noprefix=false -c diff.mnemonicPrefix=false diff --cached --binary --full-index --no-renames --no-ext-diff --no-textconv --no-color "$NEXAR_BASE"',
].join('\n');

export interface HarvestOptions {
  readonly launcher: ProcessLauncher;
  /** Abort the patch if it grows beyond this many bytes (default 5 MiB). */
  readonly maxBytes?: number;
  readonly policy?: PatchPolicy;
  readonly signal?: AbortSignal;
}

function streamToFile(
  command: string,
  args: readonly string[],
  env: Readonly<Record<string, string>>,
  cwd: string,
  file: string,
  maxBytes: number,
): Promise<{ bytes: number }> {
  return new Promise((resolve, reject) => {
    const sink = createWriteStream(file, { flags: 'wx', mode: 0o600 });
    const child = spawn(command, [...args], {
      cwd,
      env: { ...env },
      stdio: ['ignore', 'pipe', 'pipe'],
      shell: false,
    });
    let bytes = 0;
    let failure: NexarError | undefined;
    const abort = (error: NexarError): void => {
      if (failure !== undefined) return;
      failure = error;
      child.kill('SIGKILL');
    };
    child.stdout.on('data', (chunk: Buffer) => {
      bytes += chunk.length;
      if (bytes > maxBytes) {
        abort(new NexarError('VALIDATION_ERROR', 'Harvested patch exceeds the size limit'));
        return;
      }
      if (!sink.write(chunk)) {
        child.stdout.pause();
        sink.once('drain', () => child.stdout.resume());
      }
    });
    child.stderr.resume(); // discarded: git output may contain agent-controlled paths
    sink.on('error', () => abort(new NexarError('INTERNAL_ERROR', 'Patch file write failed')));
    child.on('error', () => abort(new NexarError('INTERNAL_ERROR', 'Harvest could not start')));
    child.on('close', (exit) => {
      sink.end(() => {
        if (failure !== undefined) reject(failure);
        else if (exit !== 0) reject(new NexarError('INTERNAL_ERROR', 'Harvest command failed'));
        else resolve({ bytes });
      });
    });
  });
}

/**
 * Extracts the agent's result as a patch, producing it inside a sandbox: the host never runs git
 * against the agent-controlled clone. The diff is taken from the working tree against the pristine
 * base commit, so the agent's own commits are included and its `.git` is irrelevant.
 */
export async function harvestPatch(
  task: TaskWorktree,
  options: HarvestOptions,
): Promise<HarvestResult> {
  const { launcher } = options;
  if (launcher.isolation !== 'sandbox') {
    throw new NexarError('POLICY_REJECTED', 'Harvesting requires a sandboxing launcher');
  }
  if (!OBJECT_ID_PATTERN.test(task.baseCommit)) {
    throw new NexarError('VALIDATION_ERROR', 'Base commit is not a valid object id');
  }
  const maxBytes = options.maxBytes ?? DEFAULT_MAX_PATCH_BYTES;
  const outDir = await realpath(join(task.taskDir, 'out'));
  const patchPath = join(outDir, `patch-${await nextIndex(outDir, 'patch-')}.diff`);
  const controller = new AbortController();
  const onAbort = (): void => controller.abort();
  options.signal?.addEventListener('abort', onAbort, { once: true });

  const prepared = await launcher.prepare(
    {
      command: '/bin/sh',
      args: ['-c', HARVEST_SCRIPT],
      env: {
        NEXAR_GIT_DIR: SANDBOX_BASE_GIT,
        NEXAR_BASE: task.baseCommit,
        PATH: '/usr/bin:/bin',
        HOME: '/tmp',
        GIT_CONFIG_NOSYSTEM: '1',
        GIT_CONFIG_GLOBAL: '/dev/null',
        LC_ALL: 'C',
      },
      workspace: task.workPath,
      workspaceAccess: 'read-only',
      network: { mode: 'none' },
      mounts: [{ hostPath: task.baseGitPath, sandboxPath: SANDBOX_BASE_GIT, access: 'read-only' }],
    },
    controller.signal,
  );
  try {
    if (prepared.isolation !== 'sandbox') {
      throw new NexarError('POLICY_REJECTED', 'Launcher did not apply sandbox isolation');
    }
    try {
      await streamToFile(
        prepared.command,
        prepared.args,
        prepared.env,
        prepared.cwd,
        patchPath,
        maxBytes,
      );
    } catch (error) {
      await rm(patchPath, { force: true });
      throw error;
    }
    const data = await readFile(patchPath);
    const parsed = parsePatch(data);
    const validation = validatePatch(parsed, { maxBytes, ...options.policy });
    return {
      patchPath,
      sha256: parsed.sha256,
      bytes: parsed.bytes,
      entries: parsed.entries,
      validation,
    };
  } finally {
    options.signal?.removeEventListener('abort', onAbort);
    await prepared.dispose();
  }
}
