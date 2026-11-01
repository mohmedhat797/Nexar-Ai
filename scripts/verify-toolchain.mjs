// Shared hosted/local diagnostic: verify actual executables against repository authorities.
import { getNodeInfo, getPnpmInfo } from './local-ci/platform.mjs';

const node = getNodeInfo(process.execPath);
const pnpm = getPnpmInfo(process.execPath);
console.log(
  JSON.stringify({
    node: { actual: process.version, expected: node.pinnedVersion, executable: process.execPath },
    pnpm: { actual: pnpm.installedVersion, expected: pnpm.expectedVersion },
  }),
);
if (!node.isMatched || !pnpm.isMatched) process.exitCode = 1;
