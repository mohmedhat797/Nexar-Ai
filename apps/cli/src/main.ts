#!/usr/bin/env node
import { runCli } from './cli.js';

async function readStdin(): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const chunk of process.stdin) chunks.push(chunk as Buffer);
  return Buffer.concat(chunks).toString('utf8');
}

process.exitCode = await runCli(process.argv.slice(2), {
  stdout: (s) => void process.stdout.write(s),
  stderr: (s) => void process.stderr.write(s),
  env: process.env,
  cwd: process.cwd(),
  stdin: readStdin,
});
