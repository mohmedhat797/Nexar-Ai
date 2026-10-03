const PASSTHROUGH = ['PATH', 'HOME', 'USER', 'LANG', 'LC_ALL'] as const;
const WINDOWS_PASSTHROUGH = [
  'SystemRoot',
  'SystemDrive',
  'windir',
  'ComSpec',
  'PATHEXT',
  'USERPROFILE',
  'APPDATA',
  'LOCALAPPDATA',
  'TEMP',
  'TMP',
] as const;

function inherit(
  parentEnv: NodeJS.ProcessEnv,
  names: readonly string[],
  platform: NodeJS.Platform,
): Record<string, string> {
  const env: Record<string, string> = {};
  for (const name of names) {
    const key =
      platform === 'win32'
        ? Object.keys(parentEnv).find((candidate) => candidate.toUpperCase() === name.toUpperCase())
        : name;
    const value = key === undefined ? undefined : parentEnv[key];
    if (value !== undefined && value !== '') env[name] = value;
  }
  return env;
}

/**
 * The environment for an unsandboxed Codex process: an explicit allowlist, nothing inherited.
 *
 * `OPENAI_API_KEY`, `CODEX_API_KEY`, `CODEX_ACCESS_TOKEN` (and every other variable) are never
 * passed. Nexar uses the owner's ChatGPT-subscription login only, which Codex finds through
 * `CODEX_HOME`; an API key in the parent environment must not silently switch billing.
 */
export function buildCodexEnv(
  parentEnv: NodeJS.ProcessEnv,
  codexHome: string,
  platform: NodeJS.Platform = process.platform,
): Record<string, string> {
  const env = inherit(
    parentEnv,
    [...PASSTHROUGH, ...(platform === 'win32' ? WINDOWS_PASSTHROUGH : [])],
    platform,
  );
  env['TERM'] = 'dumb';
  env['CODEX_HOME'] = codexHome;
  return env;
}

/** Minimal environment for probe commands (`--version`, `login status`). */
export function buildProbeEnv(
  parentEnv: NodeJS.ProcessEnv,
  codexHome: string,
  platform: NodeJS.Platform = process.platform,
): Record<string, string> {
  return {
    ...inherit(
      parentEnv,
      ['PATH', 'HOME', ...(platform === 'win32' ? WINDOWS_PASSTHROUGH : [])],
      platform,
    ),
    CODEX_HOME: codexHome,
  };
}
