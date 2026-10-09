import { NexarError } from '@nexar/contracts';
import { NEXAR_CONTROL_MODEL, NEXAR_CONTROL_TOKEN_ENV, NEXAR_ROUTE } from './overlay.js';

export type DshProfileId = 'cowork' | 'coding';

/** Nexar-owned data describing how one kind of DSH session is shaped. */
export interface DshProfile {
  readonly id: DshProfileId;
  /** Fixed text, rendered as the system prompt's `personaPrefix`. */
  readonly persona: string;
  /** Overlay row ids rendered `disabled: true` on top of the rows every profile disables. */
  readonly disabledRows: readonly string[];
  /** Whether the profile's tool surface includes a shell. */
  readonly shell: boolean;
}

export const COWORK_PROFILE: DshProfile = {
  id: 'cowork',
  persona:
    'You are a professional assistant working for the owner. You draft documents, proposals, ' +
    'research and analysis as files in your working directory, and you explain what you wrote. ' +
    'You never claim to have sent, published, uploaded or shared anything: you only produce drafts ' +
    'that the owner reviews and sends themselves.',
  disabledRows: [
    'tool-bash',
    'tool-pwsh',
    'tool-jobs',
    'tool-web',
    'web',
    'web-fetch-http',
    'tool-plugin-manager',
  ],
  shell: false,
};

export const CODING_PROFILE: DshProfile = {
  id: 'coding',
  persona:
    'You are a careful software engineer working in a private clone of the owner repository. ' +
    'You cannot commit or push: make focused changes, run the project checks, and report what you ' +
    'changed and what you verified. Do not touch files outside the repository.',
  disabledRows: ['tool-plugin-manager', 'tool-web', 'web', 'web-fetch-http'],
  shell: true,
};

/** Rows every profile disables: no upstream account, telemetry, session log or hosted search. */
const COMMON_DISABLED_ROWS = [
  'session-log-deepseek',
  'otel',
  'session-telemetry-otel',
  'llm-deepseek',
  'llm-deepseek-account',
  'web-search-deepseek',
] as const;

export const MAX_REQUIRED_CONTEXT_CHARS = 32_768;

const ROUTE_BASE_URL = /^http:\/\/127\.0\.0\.1:\d{1,5}\/v1$/;
const LONE_SURROGATE = /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/g;

/** Drops control characters other than `\t`/`\n`, and lone surrogates (not representable in YAML). */
function stripUnsafe(value: string): string {
  let kept = '';
  for (const char of value.replace(LONE_SURROGATE, '')) {
    const code = char.codePointAt(0) ?? 0;
    if ((code < 0x20 && code !== 0x09 && code !== 0x0a) || code === 0x7f) continue;
    kept += char;
  }
  return kept;
}

export interface ProfileOverlayOptions {
  readonly profile: DshProfile;
  /** The Control Model Gateway; must be a loopback `/v1` URL. */
  readonly nexarRoute: { readonly baseURL: string };
  /** Owner-confirmed required context, rendered as the system prompt's `personaSuffix`. */
  readonly requiredContext?: string | undefined;
}

/**
 * Renders the Nexar-owned DSH patch overlay for a profile (YAML). Row ids and keys are fixed
 * constants; every interpolated string goes through `JSON.stringify`, a valid YAML double-quoted
 * scalar, so no input can change the document's structure.
 */
export function renderProfileOverlay(options: ProfileOverlayOptions): string {
  const { profile, nexarRoute } = options;
  if (typeof nexarRoute.baseURL !== 'string' || !ROUTE_BASE_URL.test(nexarRoute.baseURL)) {
    throw new NexarError(
      'CONFIGURATION_ERROR',
      `nexarRoute.baseURL must match ${String(ROUTE_BASE_URL)}`,
    );
  }
  const suffix = sanitizeRequiredContext(options.requiredContext);

  const lines: string[] = [];
  const disabled = [...COMMON_DISABLED_ROWS, ...profile.disabledRows];
  for (const id of new Set(disabled)) lines.push(`- id: ${id}`, '  disabled: true');
  lines.push(
    '- id: llm-pi-ai',
    '  config:',
    '    providers:',
    `      ${JSON.stringify(NEXAR_ROUTE)}:`,
    '        api: "openai-completions"',
    `        baseURL: ${JSON.stringify(nexarRoute.baseURL)}`,
    `        apiKeyEnv: ${JSON.stringify(NEXAR_CONTROL_TOKEN_ENV)}`,
    '        models:',
    `          - id: ${JSON.stringify(NEXAR_CONTROL_MODEL)}`,
    '- id: acp',
    '  config:',
    `    provider: ${JSON.stringify(NEXAR_ROUTE)}`,
    `    model: ${JSON.stringify(NEXAR_CONTROL_MODEL)}`,
    '- id: system-prompt',
    '  config:',
    `    personaPrefix: ${JSON.stringify(profile.persona)}`,
    `    personaSuffix: ${JSON.stringify(suffix)}`,
  );
  return `${lines.join('\n')}\n`;
}

function sanitizeRequiredContext(value: string | undefined): string {
  if (value === undefined) return '';
  if (typeof value !== 'string') {
    throw new NexarError('CONFIGURATION_ERROR', 'requiredContext must be a string');
  }
  if (value.length > MAX_REQUIRED_CONTEXT_CHARS) {
    throw new NexarError('CONFIGURATION_ERROR', 'required context exceeds the size limit', {
      details: { reason: 'required-context-overflow' },
    });
  }
  // DSH interpolates `{{name}}`: break the delimiters so the text is always literal.
  return stripUnsafe(value)
    .replace(/\{(?=\{)/g, '{ ')
    .replace(/\}(?=\})/g, '} ');
}
