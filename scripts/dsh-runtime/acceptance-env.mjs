// Owner-controlled acceptance inputs, never renderer or model inputs. This permits an isolated
// candidate runtime without replacing the WSL machine's previously approved /opt/dsh install.
export function linuxAcceptanceRuntime(env = process.env) {
  const entry =
    env.NEXAR_SEC02_LINUX_DSH_ENTRY ?? '/opt/dsh/lib/node_modules/@deepseek-ai/dsh/lib/bin.js';
  const toolchain = env.NEXAR_SEC02_LINUX_DSH_TOOLCHAIN ?? '/opt/node:/opt/dsh/lib/node_modules';
  const safePath = (value) =>
    /^\/[A-Za-z0-9@._/-]+$/.test(value) &&
    !value
      .slice(1)
      .split('/')
      .some((part) => part === '' || part === '.' || part === '..');
  if (!safePath(entry) || !toolchain.split(':').every(safePath)) {
    throw new Error('Invalid isolated Linux acceptance runtime');
  }
  return { NEXAR_DSH_BIN: entry, NEXAR_DSH_TOOLCHAIN: toolchain };
}
