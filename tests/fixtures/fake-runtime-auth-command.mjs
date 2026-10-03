import { spawn } from 'node:child_process';
import { writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const [mode, ...args] = process.argv.slice(2);
if (mode === 'args') {
  process.stdout.write(`${JSON.stringify(args)}\n`);
} else if (mode === 'exit') {
  process.stdout.write('safe metadata');
  process.stderr.write('safe diagnostic');
  process.exitCode = Number(args[0] ?? '0');
} else if (mode === 'browser') {
  process.stdout.write('private vendor output');
  process.stderr.write('private vendor diagnostic');
} else if (mode === 'tree') {
  const child = spawn(process.execPath, [fileURLToPath(import.meta.url), 'wait'], {
    stdio: 'ignore',
  });
  writeFileSync(args[0], JSON.stringify({ leader: process.pid, descendant: child.pid }));
  setInterval(() => undefined, 1000);
} else if (mode === 'wait') {
  setInterval(() => undefined, 1000);
} else {
  process.exitCode = 2;
}
