// Exact ADR-030 pin, npm-ci integrity checks, exclusive admission and staged publication.
// Usage: node scripts/install-dsh-runtime.mjs <dir>
// stdout's final line is the verified entry; stderr is bounded, allowlisted phase metadata.
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { installDshRuntime } from './dsh-runtime/install.mjs';

if (process.argv.length !== 3) {
  console.error('install-dsh-runtime: usage: install-dsh-runtime.mjs <dir>');
  process.exitCode = 1;
} else {
  try {
    const pinDir = join(
      dirname(fileURLToPath(import.meta.url)),
      '../integrations/deepseek-harness',
    );
    console.log(await installDshRuntime({ target: process.argv[2], pinDir }));
  } catch (error) {
    console.error(error.message);
    process.exitCode = 1;
  }
}
