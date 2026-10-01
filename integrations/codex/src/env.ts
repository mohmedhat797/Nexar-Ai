const PASSTHROUGH = ['PATH', 'HOME', 'USER', 'LANG', 'LC_ALL'] as const;

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
): Record<string, string> {
  const env: Record<string, string> = {};
  for (const name of PASSTHROUGH) {
    const value = parentEnv[name];
    if (value !== undefined && value !== '') env[name] = value;
  }
  env['TERM'] = 'dumb';
  env['CODEX_HOME'] = codexHome;
  return env;
}

/** Minimal environment for probe commands (`--version`, `login status`). */
export function buildProbeEnv(
  parentEnv: NodeJS.ProcessEnv,
  codexHome: string,
): Record<string, string> {
  const env: Record<string, string> = { CODEX_HOME: codexHome };
  for (const name of ['PATH', 'HOME'] as const) {
    const value = parentEnv[name];
    if (value !== undefined && value !== '') env[name] = value;
  }
  return env;
}
