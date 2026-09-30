const SECRET_NAME = /(TOKEN|SECRET|PASSWORD|CREDENTIAL|API_KEY|ACCESS_KEY|PRIVATE_KEY)/i;
/** Claude Code's own runtime-managed auth lives under these prefixes and is inherited. */
const RUNTIME_OWNED_PREFIX = /^(CLAUDE_|ANTHROPIC_)/i;
/** Credential namespaces that belong to other services. */
const FOREIGN_SERVICE_NAME = /^(AWS_|CLOUDSDK_|GH_|GITHUB_|GOOGLE_APPLICATION_CREDENTIALS$)/i;

/**
 * Builds the child's environment: inherit the parent's, but strip the nested-session marker and
 * credentials that belong to services other than Claude.
 */
export function buildChildEnv(parentEnv: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {};
  for (const [name, value] of Object.entries(parentEnv)) {
    if (value === undefined || name === 'CLAUDECODE') continue;
    if (FOREIGN_SERVICE_NAME.test(name)) continue;
    if (SECRET_NAME.test(name) && !RUNTIME_OWNED_PREFIX.test(name)) continue;
    env[name] = value;
  }
  return env;
}
