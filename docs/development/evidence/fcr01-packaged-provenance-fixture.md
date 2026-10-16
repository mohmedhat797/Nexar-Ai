# FCR-01 — Reproducible packaged source probe

This read-only Windows probe compares the final ASAR main and packaged session/profile dependencies to compiled bytes and checks the corrective guards. The ASAR reader is the exact locked transitive version 3.4.1. Store this source as .nexar/fcr01-inspect-packaged-source.mjs and run node .nexar/fcr01-inspect-packaged-source.mjs under Node 22 after packaging. Its hashes are preserved in fcr01-final-evidence.json. It does not assert installer signing or public release certification.

```js
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFileSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { normalize } from 'node:path';
const require = createRequire(import.meta.url);
const asar = require('../node_modules/.pnpm/@electron+asar@3.4.1/node_modules/@electron/asar');
const archive = 'release/desktop/win-unpacked/resources/app.asar';
const manifest = JSON.parse(asar.extractFile(archive, 'package.json').toString('utf8'));
assert.equal(manifest.main, './dist/main/main.js');
const main = asar.extractFile(archive, normalize(manifest.main));
const built = readFileSync('apps/desktop/dist/main/main.js');
assert(main.equals(built), 'Packaged main differs from the current built main');
const dependencies = [
  {
    archivePath: 'node_modules/@nexar/sessions/dist/store.js',
    builtPath: 'packages/sessions/dist/store.js',
    markers: ['lease-acquisition-held', 'lease-unverifiable'],
  },
  {
    archivePath: 'node_modules/@nexar/integration-deepseek-harness/dist/profiles.js',
    builtPath: 'integrations/deepseek-harness/dist/profiles.js',
    markers: ['tool-subagent-fork', 'tool-subagent-list-agents'],
  },
];
const verified = dependencies.map(({ archivePath, builtPath, markers }) => {
  const packaged = asar.extractFile(archive, normalize(archivePath));
  assert(packaged.equals(readFileSync(builtPath)), `Packaged dependency differs: ${builtPath}`);
  for (const marker of markers)
    assert(packaged.toString('utf8').includes(marker), `Missing corrective marker: ${marker}`);
  return {
    archivePath,
    builtPath,
    sha256: createHash('sha256').update(packaged).digest('hex'),
    byteMatch: true,
    markers,
  };
});
const proof = {
  result: 'PASS',
  packagedMainMatchesBuiltBytes: true,
  mainSha256: createHash('sha256').update(main).digest('hex'),
  dependencies: verified,
};
writeFileSync('.nexar/fcr01-packaged-source-proof.json', JSON.stringify(proof, null, 2) + '\n');
console.log(JSON.stringify(proof));
```
