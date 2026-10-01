import { chmodSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { git } from './fixtures.testkit.js';

/** Plays the agent: modify, add (plain, executable, binary), delete, and commit part of it. */
export function simulateAgent(workPath: string): void {
  writeFileSync(join(workPath, 'a.txt'), 'one\nTWO\nthree\n');
  git(workPath, 'commit', '-q', '-am', 'agent commit');
  writeFileSync(join(workPath, 'new.txt'), 'brand new\n');
  mkdirSync(join(workPath, 'sub dir'));
  writeFileSync(join(workPath, 'sub dir', 'run.sh'), '#!/bin/sh\n');
  chmodSync(join(workPath, 'sub dir', 'run.sh'), 0o755);
  writeFileSync(join(workPath, 'bin.dat'), Buffer.from([9, 8, 7, 0, 255]));
  writeFileSync(join(workPath, 'blob.bin'), Buffer.from([0, 0, 1, 2, 3]));
  rmSync(join(workPath, 'del.txt'));
}
