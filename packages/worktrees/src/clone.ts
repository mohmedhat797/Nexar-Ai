import { lstat } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { NexarError } from '@nexar/contracts';
import { runGit, type GitOptions } from './git.js';

/**
 * Clones Nexar's pristine bare repository into `dest` and hardens the result. Host git runs here
 * only because both repositories are Nexar-made and no agent has touched them yet.
 */
export async function cloneHardened(
  baseGitPath: string,
  dest: string,
  expectedCommit: string,
  options: GitOptions,
): Promise<void> {
  const cwd = dirname(dest);
  await runGit(['clone', '--no-local', '--single-branch', '--no-tags', '--', baseGitPath, dest], {
    ...options,
    cwd,
    label: 'clone',
  });
  const git = (label: string, ...args: string[]) =>
    runGit(['-C', dest, ...args], { ...options, cwd, label });
  await git('remote remove', 'remote', 'remove', 'origin');
  await git('config', 'config', 'core.hooksPath', '/dev/null');
  await git('config', 'config', 'user.name', 'Nexar Agent');
  await git('config', 'config', 'user.email', 'agent@nexar.invalid');
  await git('config', 'config', 'commit.gpgsign', 'false');
  const head = (await git('rev-parse', 'rev-parse', '--verify', 'HEAD^{commit}')).trim();
  const dotGit = await lstat(join(dest, '.git'));
  if (!dotGit.isDirectory() || head !== expectedCommit) {
    throw new NexarError('INTERNAL_ERROR', 'Cloned workspace does not match the expected base');
  }
}
