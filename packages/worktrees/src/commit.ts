import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { NexarError } from '@nexar/contracts';
import { assertBranchName } from './create.js';
import { runGit, type GitOptions } from './git.js';
import { assertHarvestIntact } from './verify.js';
import type { HarvestResult } from './types.js';
import { OBJECT_ID_PATTERN } from './util.js';

export interface CommitAuthor {
  readonly name: string;
  readonly email: string;
}

export interface CommitPatchOptions extends GitOptions {
  /** Canonical path of the owner's repository. Its working tree and index are never touched. */
  readonly repository: string;
  readonly baseCommit: string;
  readonly harvest: HarvestResult;
  /** New branch; must start with `nexar/`. */
  readonly branch: string;
  readonly message: string;
  readonly author: CommitAuthor;
  /** Appended to the message as `Key: value` lines. */
  readonly trailers?: Readonly<Record<string, string>>;
  readonly now?: () => Date;
}

export interface CommitResult {
  readonly commit: string;
  readonly branch: string;
  readonly tree: string;
}

const TRAILER_KEY = /^[A-Za-z][A-Za-z0-9-]*$/;

function validateIdentity(author: CommitAuthor): void {
  const bad = (value: string): boolean => value.trim() === '' || /[\x00-\x1f\x7f<>]/.test(value); // eslint-disable-line no-control-regex
  if (bad(author.name) || bad(author.email)) {
    throw new NexarError('VALIDATION_ERROR', 'Commit author is not valid');
  }
}

function buildMessage(message: string, trailers: Readonly<Record<string, string>>): string {
  if (message.trim() === '' || message.includes('\0')) {
    throw new NexarError('VALIDATION_ERROR', 'Commit message is not valid');
  }
  const lines = Object.entries(trailers).map(([key, value]) => {
    // eslint-disable-next-line no-control-regex
    if (!TRAILER_KEY.test(key) || /[\x00-\x1f\x7f]/.test(value) || value.trim() === '') {
      throw new NexarError('VALIDATION_ERROR', 'Commit trailer is not valid');
    }
    return `${key}: ${value}`;
  });
  const body = message.replace(/\s+$/, '');
  return lines.length === 0 ? `${body}\n` : `${body}\n\n${lines.join('\n')}\n`;
}

/**
 * Creates a commit on a new `nexar/*` branch in the owner's repository from a validated patch,
 * using plumbing only: a throwaway index, `commit-tree`, and an atomic `update-ref`. No hooks run,
 * the owner's working tree, index and HEAD are untouched, and nothing is pushed.
 */
export async function commitPatch(options: CommitPatchOptions): Promise<CommitResult> {
  const { harvest, branch } = options;
  if (!harvest.validation.ok) {
    throw new NexarError('POLICY_REJECTED', 'Patch did not pass validation');
  }
  if (!OBJECT_ID_PATTERN.test(options.baseCommit)) {
    throw new NexarError('VALIDATION_ERROR', 'Base commit is not a valid object id');
  }
  if (!branch.startsWith('nexar/')) {
    throw new NexarError('POLICY_REJECTED', 'Branch must be under nexar/');
  }
  validateIdentity(options.author);
  const message = buildMessage(options.message, options.trailers ?? {});
  const expectedPaths = new Set(harvest.validation.entries.map((e) => e.path));
  const patchPath = await assertHarvestIntact(harvest);

  const git: GitOptions = options.gitPath === undefined ? {} : { gitPath: options.gitPath };
  const gitDir = (
    await runGit(['rev-parse', '--absolute-git-dir'], {
      ...git,
      cwd: options.repository,
      label: 'rev-parse',
    })
  ).trim();
  await assertBranchName(branch, options.repository, git);
  const ref = `refs/heads/${branch}`;

  const scratch = await mkdtemp(join(tmpdir(), 'nexar-commit-'));
  try {
    const run = (label: string, args: string[], extra: Record<string, string> = {}) =>
      runGit(args, {
        ...git,
        cwd: scratch,
        label,
        env: { GIT_DIR: gitDir, GIT_INDEX_FILE: join(scratch, 'index'), ...extra },
      });

    let exists = true;
    try {
      await run('show-ref', ['show-ref', '--verify', '--quiet', ref]);
    } catch {
      exists = false;
    }
    if (exists) throw new NexarError('POLICY_REJECTED', 'Branch already exists');

    await run('read-tree', ['read-tree', options.baseCommit]);
    await run('apply', ['apply', '--cached', '--whitespace=nowarn', patchPath]);
    const tree = (await run('write-tree', ['write-tree'])).trim();

    const messageFile = join(scratch, 'message');
    await writeFile(messageFile, message, { mode: 0o600 });
    const seconds = Math.floor((options.now?.() ?? new Date()).getTime() / 1000);
    const stamp = `${seconds} +0000`;
    const commit = (
      await run('commit-tree', ['commit-tree', tree, '-p', options.baseCommit, '-F', messageFile], {
        GIT_AUTHOR_NAME: options.author.name,
        GIT_AUTHOR_EMAIL: options.author.email,
        GIT_AUTHOR_DATE: stamp,
        GIT_COMMITTER_NAME: options.author.name,
        GIT_COMMITTER_EMAIL: options.author.email,
        GIT_COMMITTER_DATE: stamp,
      })
    ).trim();

    try {
      await run('update-ref', ['update-ref', ref, commit, '0'.repeat(commit.length)]);
    } catch {
      throw new NexarError('POLICY_REJECTED', 'Branch could not be created');
    }

    const changed = (
      await run('diff-tree', [
        'diff-tree',
        '-r',
        '--no-renames',
        '--name-only',
        '-z',
        options.baseCommit,
        commit,
      ])
    )
      .split('\0')
      .filter((name) => name !== '');
    const same =
      changed.length === expectedPaths.size && changed.every((name) => expectedPaths.has(name));
    if (!same) {
      await run('update-ref', ['update-ref', '-d', ref, commit]);
      throw new NexarError('POLICY_REJECTED', 'Commit does not match the validated patch');
    }
    return { commit, branch, tree };
  } finally {
    await rm(scratch, { recursive: true, force: true });
  }
}
