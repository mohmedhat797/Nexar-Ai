// Owner-controlled acceptance inputs, never renderer or model inputs. This permits an isolated
// candidate runtime without replacing the WSL machine's previously approved /opt/dsh install.
import { posix } from 'node:path';
import { readPinnedNodeVersion } from '../local-ci/platform.mjs';

const safePath = (value) =>
  /^\/[A-Za-z0-9@._/-]+$/.test(value) &&
  !value
    .slice(1)
    .split('/')
    .some((part) => part === '' || part === '.' || part === '..');

export function linuxAcceptanceNode(env = process.env) {
  const node =
    env.NEXAR_SEC02_LINUX_NODE_BIN ??
    `/opt/node-v${readPinnedNodeVersion()}-linux-${process.arch}/bin/node`;
  if (!safePath(node)) throw new Error('Invalid isolated Linux Node executable');
  return node;
}

export function linuxAcceptanceRuntime(env = process.env) {
  const entry =
    env.NEXAR_SEC02_LINUX_DSH_ENTRY ?? '/opt/dsh/lib/node_modules/@deepseek-ai/dsh/lib/bin.js';
  const toolchain =
    env.NEXAR_SEC02_LINUX_DSH_TOOLCHAIN ??
    `${posix.dirname(posix.dirname(linuxAcceptanceNode(env)))}:/opt/dsh/lib/node_modules`;
  if (!safePath(entry) || !toolchain.split(':').every(safePath)) {
    throw new Error('Invalid isolated Linux acceptance runtime');
  }
  return { NEXAR_DSH_BIN: entry, NEXAR_DSH_TOOLCHAIN: toolchain };
}
