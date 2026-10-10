import { describe, expect, it } from 'vitest';
import type { NexarError } from '@nexar/contracts';
import {
  CODING_PROFILE,
  COWORK_PROFILE,
  MAX_REQUIRED_CONTEXT_CHARS,
  renderProfileOverlay,
} from './profiles.js';
import type { DshProfile } from './profiles.js';

const BASE_URL = 'http://127.0.0.1:43111/v1';
const PRIVACY_ROWS = [
  'session-log-deepseek',
  'otel',
  'session-telemetry-otel',
  'llm-deepseek-account',
  'web-search-deepseek',
];

function render(profile: DshProfile, requiredContext?: string): string {
  return renderProfileOverlay({
    profile,
    route: { kind: 'nexar', baseURL: BASE_URL },
    requiredContext,
  });
}

function renderResource(profile: DshProfile, requiredContext?: string): string {
  return renderProfileOverlay({ profile, route: { kind: 'resource' }, requiredContext });
}

function rowIds(overlay: string): string[] {
  return [...overlay.matchAll(/^- id: (\S+)$/gm)].map((m) => m[1] as string);
}

function disabledIds(overlay: string): string[] {
  return [...overlay.matchAll(/^- id: (\S+)\n {2}disabled: true$/gm)].map((m) => m[1] as string);
}

function errorOf(fn: () => unknown): NexarError {
  try {
    fn();
  } catch (error) {
    return error as NexarError;
  }
  throw new Error('expected a throw');
}

describe('profile data', () => {
  it('keeps personas short and fixed', () => {
    expect(COWORK_PROFILE.persona.length).toBeLessThanOrEqual(600);
    expect(CODING_PROFILE.persona.length).toBeLessThanOrEqual(600);
    expect(COWORK_PROFILE.persona).toMatch(/never claim/);
    expect(CODING_PROFILE.persona).toMatch(/cannot commit or push/);
  });
});

describe.each([COWORK_PROFILE, CODING_PROFILE])('renderProfileOverlay ($id)', (profile) => {
  const overlay = render(profile);

  it('disables every privacy row and the DeepSeek key row', () => {
    for (const id of [...PRIVACY_ROWS, 'llm-deepseek']) expect(disabledIds(overlay)).toContain(id);
  });

  it('declares exactly one provider: the nexar route', () => {
    expect(overlay.match(/^ {6}"[^"]+":$/gm)).toEqual(['      "nexar":']);
    expect(overlay).toContain('        api: "openai-completions"');
    expect(overlay).toContain(`        baseURL: "${BASE_URL}"`);
    expect(overlay).toContain('        apiKeyEnv: "NEXAR_CONTROL_TOKEN"');
    expect(overlay).toContain('          - id: "nexar-control"');
  });

  it('defaults ACP to the nexar route and carries the persona', () => {
    expect(overlay).toContain(
      '- id: acp\n  config:\n    provider: "nexar"\n    model: "nexar-control"',
    );
    expect(overlay).toContain(`    personaPrefix: ${JSON.stringify(profile.persona)}`);
    expect(overlay).toContain('    personaSuffix: ""');
  });

  it('renders each row once', () => {
    const ids = rowIds(overlay);
    expect(new Set(ids).size).toBe(ids.length);
    expect(ids).toEqual(expect.arrayContaining(['llm-pi-ai', 'acp', 'system-prompt']));
  });

  it('never mentions a provider key', () => {
    expect(overlay).not.toMatch(/DEEPSEEK_API_KEY|sk-/);
  });
});

describe.each([COWORK_PROFILE, CODING_PROFILE])('resource route ($id)', (profile) => {
  const overlay = renderResource(profile, 'Always run the tests.');

  it('keeps the privacy rows disabled but leaves llm-deepseek enabled', () => {
    for (const id of PRIVACY_ROWS) expect(disabledIds(overlay)).toContain(id);
    expect(rowIds(overlay)).not.toContain('llm-deepseek');
  });

  it('renders no nexar route, provider or ACP default', () => {
    expect(rowIds(overlay)).not.toContain('llm-pi-ai');
    expect(rowIds(overlay)).not.toContain('acp');
    expect(overlay).not.toMatch(/nexar-control|NEXAR_CONTROL_TOKEN|baseURL/);
  });

  it('still carries the persona, profile rows and required context', () => {
    expect(overlay).toContain(`    personaPrefix: ${JSON.stringify(profile.persona)}`);
    expect(overlay).toContain('    personaSuffix: "Always run the tests."');
    for (const id of profile.disabledRows) expect(disabledIds(overlay)).toContain(id);
    const ids = rowIds(overlay);
    expect(new Set(ids).size).toBe(ids.length);
  });

  it('escapes hostile required context like the nexar route', () => {
    const hostile = 'x"\n- id: llm-deepseek\n  disabled: true {{y}}';
    const line = renderResource(profile, hostile)
      .split('\n')
      .find((l) => l.startsWith('    personaSuffix: ')) as string;
    const value = JSON.parse(line.slice('    personaSuffix: '.length)) as string;
    expect(value).toContain('- id: llm-deepseek');
    expect(value).not.toContain('{{');
    expect(rowIds(renderResource(profile, hostile))).toEqual(rowIds(renderResource(profile)));
  });

  it('rejects an unknown route kind', () => {
    const error = errorOf(() =>
      renderProfileOverlay({ profile, route: { kind: 'other' } as never }),
    );
    expect(error.code).toBe('CONFIGURATION_ERROR');
  });
});

describe('profile tool surfaces', () => {
  it('cowork disables shell, jobs, web and plugin rows', () => {
    const disabled = disabledIds(render(COWORK_PROFILE));
    for (const id of [
      'tool-bash',
      'tool-pwsh',
      'tool-jobs',
      'tool-web',
      'web',
      'web-fetch-http',
      'tool-plugin-manager',
      'tool-subagent',
      'tool-subagent-control',
    ]) {
      expect(disabled).toContain(id);
    }
    expect(COWORK_PROFILE.shell).toBe(false);
  });

  it('coding keeps the shell and disables only plugin manager and web rows', () => {
    const disabled = disabledIds(render(CODING_PROFILE));
    expect(disabled).not.toContain('tool-bash');
    expect(disabled).not.toContain('tool-pwsh');
    expect(disabled).not.toContain('tool-jobs');
    for (const id of ['tool-plugin-manager', 'tool-web', 'web', 'web-fetch-http']) {
      expect(disabled).toContain(id);
    }
    expect(CODING_PROFILE.shell).toBe(true);
  });
});

describe('required context', () => {
  const suffixLine = (overlay: string): string =>
    overlay.split('\n').find((l) => l.startsWith('    personaSuffix: ')) as string;

  it('renders as one double-quoted scalar, however hostile', () => {
    const hostile = 'say "hi"\n- id: llm-deepseek\n  disabled: false\n\\ trailing';
    const overlay = render(COWORK_PROFILE, hostile);
    const line = suffixLine(overlay);
    expect(JSON.parse(line.slice('    personaSuffix: '.length))).toBe(hostile);
    expect(rowIds(overlay)).toEqual(rowIds(render(COWORK_PROFILE)));
    expect(overlay.endsWith('\n')).toBe(true);
    expect(overlay.split('\n').filter((l) => l === '- id: llm-deepseek')).toHaveLength(1);
  });

  it('neutralizes template delimiters, including runs', () => {
    const value = JSON.parse(
      suffixLine(render(CODING_PROFILE, 'a {{x}} b {{{y}}} c')).slice('    personaSuffix: '.length),
    ) as string;
    expect(value).not.toContain('{{');
    expect(value).not.toContain('}}');
    expect(value).toContain('x');
  });

  it('removes control characters except newline and tab', () => {
    const value = JSON.parse(
      suffixLine(render(CODING_PROFILE, 'a\u0000b\u001bc\rd\te\nf')).slice(
        '    personaSuffix: '.length,
      ),
    ) as string;
    expect(value).toBe('abcd\te\nf');
  });

  it('accepts exactly the maximum and rejects overflow', () => {
    expect(() => render(COWORK_PROFILE, 'x'.repeat(MAX_REQUIRED_CONTEXT_CHARS))).not.toThrow();
    const error = errorOf(() => render(COWORK_PROFILE, 'x'.repeat(MAX_REQUIRED_CONTEXT_CHARS + 1)));
    expect(error.code).toBe('CONFIGURATION_ERROR');
    expect(error.details).toEqual({ reason: 'required-context-overflow' });
  });

  it('rejects a non-string value', () => {
    const error = errorOf(() => render(COWORK_PROFILE, 42 as unknown as string));
    expect(error.code).toBe('CONFIGURATION_ERROR');
  });
});

describe('route base URL', () => {
  it.each([
    'http://localhost:1234/v1',
    'https://127.0.0.1:1234/v1',
    'http://127.0.0.1:1234/v1/',
    'http://127.0.0.1/v1',
    'http://127.0.0.1:1234/v1"\n- id: x',
    'http://10.0.0.1:1234/v1',
  ])('rejects %j', (baseURL) => {
    const error = errorOf(() =>
      renderProfileOverlay({ profile: COWORK_PROFILE, route: { kind: 'nexar', baseURL } }),
    );
    expect(error.code).toBe('CONFIGURATION_ERROR');
    expect(error.message).not.toContain('10.0.0.1');
  });
});
