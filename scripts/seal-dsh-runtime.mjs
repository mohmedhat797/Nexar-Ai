// Seals a runtime the accepted installer completed, so packaging can consume it without another
// dependency materialization. Runs apart from installation: hashing is not part of its deadline.
// Usage: node scripts/seal-dsh-runtime.mjs <dir>
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { sealRuntimeArtifact } from './dsh-runtime/artifact.mjs';

if (process.argv.length !== 3) {
  console.error('seal-dsh-runtime: usage: seal-dsh-runtime.mjs <dir>');
  process.exitCode = 1;
} else {
  try {
    const pinDir = join(
      dirname(fileURLToPath(import.meta.url)),
      '../integrations/deepseek-harness',
    );
    const seal = sealRuntimeArtifact({ dir: process.argv[2], pinDir });
    console.log(JSON.stringify(seal));
  } catch (error) {
    console.error(error.message);
    process.exitCode = 1;
  }
}
