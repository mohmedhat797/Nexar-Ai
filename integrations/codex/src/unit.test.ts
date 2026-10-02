import { isNexarError, valueOf } from '@nexar/contracts';
import type { ResourceDescriptor } from '@nexar/contracts';
import { describe, expect, it } from 'vitest';
import { join, resolve } from 'node:path';
import {
  buildCodexArgs,
  buildCodexEnv,
  classifyFailure,
  codexResource,
  readSettings,
} from './index.js';
import { buildProbeEnv } from './env.js';
import { CodexStreamParser, parseCodexStream, toUsage } from './parse.js';
import { resolveCodexHome } from './settings.js';

function withOptions(options: Record<string, unknown>): ResourceDescriptor {
  const base = codexResource();
  return { ...base, runtime: { ...base.runtime, options } };
}

const line = (e: unknown): string => JSON.stringify(e);
const completed = (usage: Record<string, number>): string =>
  line({ type: 'turn.completed', usage });

describe('codexResource', () => {
  it('describes a subscription-auth native agent with no secret fields', () => {
    const r = codexResource();
    expect(r.id).toBe('codex');
    expect(r.runtime).toEqual({ adapter: 'codex', locality: 'local' });
    expect(r.auth).toEqual({
      mode: 'subscription',
      credential: {
        source: 'runtime-managed',
        description: 'Codex login (codex login, ChatGPT sign-in)',
      },
    });
    expect(r.cost).toEqual({ model: 'subscription' });
    expect(r.capabilities).toContain('shell-execution');
  });
});

describe('readSettings', () => {
  it('defaults to the OpenAI hosts and no overrides', () => {
    const s = readSettings(codexResource());
    expect(s.allowHosts).toEqual(['chatgpt.com', 'auth.openai.com', 'api.openai.com']);
    expect(s.model).toBeUndefined();
    expect(s.codexHome).toBeUndefined();
  });

  it('accepts every documented option', () => {
    const s = readSettings(
      withOptions({
        binary: '/opt/codex',
        model: 'gpt-x',
        reasoningEffort: 'high',
        timeoutMs: 1000,
        codexHome: '/srv/codex-home',
        allowHosts: ['chatgpt.com'],
      }),
    );
    expect(s).toEqual({
      binary: '/opt/codex',
      model: 'gpt-x',
      reasoningEffort: 'high',
      timeoutMs: 1000,
      codexHome: resolve('/srv/codex-home'),
      allowHosts: ['chatgpt.com'],
    });
  });

  it.each([
    ['unknown key', { colour: 'red' }],
    ['empty binary', { binary: '' }],
    ['non-string model', { model: 3 }],
    ['bad effort', { reasoningEffort: 'extreme' }],
    ['zero timeout', { timeoutMs: 0 }],
    ['string timeout', { timeoutMs: '5' }],
    ['relative codexHome', { codexHome: 'rel/dir' }],
    ['empty allowHosts', { allowHosts: [] }],
    ['non-string host', { allowHosts: ['a', 1] }],
  ])('rejects %s with CONFIGURATION_ERROR', (_name, options) => {
    try {
      readSettings(withOptions(options));
    } catch (e) {
      expect(isNexarError(e) && e.code).toBe('CONFIGURATION_ERROR');
      return;
    }
    throw new Error('expected rejection');
  });

  it('resolves CODEX_HOME: setting, then env, then ~/.codex', () => {
    expect(resolveCodexHome({ allowHosts: [], codexHome: '/a' }, { CODEX_HOME: '/b' }, '/h')).toBe(
      '/a',
    );
    expect(resolveCodexHome({ allowHosts: [] }, { CODEX_HOME: '/b' }, '/h')).toBe(resolve('/b'));
    expect(resolveCodexHome({ allowHosts: [] }, { HOME: '/u' }, '/h')).toBe(join('/u', '.codex'));
    expect(resolveCodexHome({ allowHosts: [] }, {}, '/h')).toBe(join('/h', '.codex'));
  });
});

describe('buildCodexEnv', () => {
  const parent = {
    PATH: '/bin',
    HOME: '/home/o',
    USER: 'o',
    LANG: 'en_US.UTF-8',
    LC_ALL: 'C',
    TERM: 'xterm',
    OPENAI_API_KEY: 'sk-secret',
    CODEX_API_KEY: 'k',
    CODEX_ACCESS_TOKEN: 't',
    GITHUB_TOKEN: 'g',
    CODEX_HOME: '/ignored-parent-value',
  };

  it('is an explicit allowlist with the resolved CODEX_HOME', () => {
    expect(buildCodexEnv(parent, '/home/o/.codex')).toEqual({
      PATH: '/bin',
      HOME: '/home/o',
      USER: 'o',
      LANG: 'en_US.UTF-8',
      LC_ALL: 'C',
      TERM: 'dumb',
      CODEX_HOME: '/home/o/.codex',
    });
  });

  it('never carries API keys or tokens, in any mode', () => {
    for (const env of [buildCodexEnv(parent, '/c'), buildProbeEnv(parent, '/c')]) {
      expect(Object.keys(env).filter((k) => /KEY|TOKEN/.test(k))).toEqual([]);
    }
    expect(buildProbeEnv(parent, '/c')).toEqual({
      PATH: '/bin',
      HOME: '/home/o',
      CODEX_HOME: '/c',
    });
  });

  it('preserves Windows runtime variables case-insensitively without credentials', () => {
    const windows = {
      Path: 'C:\\Tools',
      systemroot: 'C:\\Windows',
      COMSPEC: 'C:\\Windows\\System32\\cmd.exe',
      pathext: '.EXE;.CMD',
      userprofile: 'C:\\Users\\owner',
      APPDATA: 'C:\\Users\\owner\\AppData\\Roaming',
      TEMP: 'C:\\Temp',
      openai_api_key: 'secret',
      CODEX_ACCESS_TOKEN: 'secret',
      Unrelated: 'not inherited',
    };
    for (const env of [
      buildCodexEnv(windows, 'C:\\Codex', 'win32'),
      buildProbeEnv(windows, 'C:\\Codex', 'win32'),
    ]) {
      expect(env).toMatchObject({
        PATH: windows.Path,
        SystemRoot: windows.systemroot,
        ComSpec: windows.COMSPEC,
        PATHEXT: windows.pathext,
        USERPROFILE: windows.userprofile,
        APPDATA: windows.APPDATA,
        TEMP: windows.TEMP,
        CODEX_HOME: 'C:\\Codex',
      });
      expect(Object.keys(env).filter((name) => /KEY|TOKEN|Unrelated/i.test(name))).toEqual([]);
      expect(env['Path']).toBeUndefined();
    }
    expect(buildProbeEnv(windows, '/c', 'linux')).toEqual({ CODEX_HOME: '/c' });
  });
});

describe('buildCodexArgs', () => {
  const base = { allowHosts: [] as string[] };

  it('unscoped: read-only, git check skipped, prompt via stdin marker, no bypass', () => {
    expect(buildCodexArgs(base, 'unscoped', '/w')).toEqual([
      'exec',
      '--json',
      '--ephemeral',
      '--ignore-user-config',
      '--color',
      'never',
      '-s',
      'read-only',
      '--skip-git-repo-check',
      '-C',
      '/w',
      '-',
    ]);
  });

  it('adds model and reasoning effort', () => {
    const args = buildCodexArgs(
      { ...base, model: 'gpt-x', reasoningEffort: 'low' },
      'unscoped',
      '/w',
    );
    expect(args).toContain('-m');
    expect(args[args.indexOf('-m') + 1]).toBe('gpt-x');
    expect(args[args.indexOf('-c') + 1]).toBe('model_reasoning_effort="low"');
  });

  it('emits the bypass flag only for the sandboxed mode', () => {
    const flag = '--dangerously-bypass-approvals-and-sandbox';
    expect(buildCodexArgs(base, 'sandboxed')).toContain(flag);
    expect(buildCodexArgs(base, 'sandboxed')).not.toContain('-s');
    expect(buildCodexArgs(base, 'unscoped', '/w')).not.toContain(flag);
    expect(buildCodexArgs(base, 'workspace-read-only', '/w')).not.toContain(flag);
    expect(buildCodexArgs(base, 'workspace-read-only', '/w')).toContain('read-only');
  });
});

describe('CodexStreamParser', () => {
  it('takes the last agent_message and the last turn.completed usage', () => {
    const run = parseCodexStream([
      line({ type: 'thread.started', thread_id: 'th-1' }),
      line({ type: 'item.completed', item: { type: 'agent_message', text: 'one' } }),
      completed({ input_tokens: 1, output_tokens: 1 }),
      line({ type: 'item.completed', item: { type: 'agent_message', text: 'two' } }),
      completed({
        input_tokens: 100,
        cached_input_tokens: 40,
        cache_write_input_tokens: 7,
        output_tokens: 10,
        reasoning_output_tokens: 5,
      }),
    ]);
    expect(run.threadId).toBe('th-1');
    expect(run.text).toBe('two');
    expect(run.turns).toBe(2);
    const usage = toUsage(run);
    expect(usage.inputTokens).toEqual({ status: 'measured', value: 100 });
    expect(usage.outputTokens).toEqual({ status: 'measured', value: 15 });
    expect(usage.cacheReadTokens).toEqual({ status: 'measured', value: 40 });
    expect(usage.cacheWriteTokens).toEqual({ status: 'measured', value: 7 });
    expect(usage.turns).toEqual({ status: 'measured', value: 2 });
    expect(usage.costUsd).toEqual({
      status: 'unavailable',
      reason: 'subscription; not reported by codex',
    });
  });

  it('never reports zero usage as measured', () => {
    const zeros = toUsage(parseCodexStream([completed({ input_tokens: 0, output_tokens: 0 })]));
    expect(zeros.inputTokens.status).toBe('unavailable');
    expect(zeros.outputTokens.status).toBe('unavailable');
    expect(valueOf(zeros.inputTokens)).toBeUndefined();

    const empty = toUsage(parseCodexStream([completed({})]));
    expect(empty.inputTokens.status).toBe('unavailable');

    const none = toUsage(parseCodexStream([]));
    expect(none.inputTokens.status).toBe('unavailable');
    expect(none.turns?.status).toBe('unavailable');
  });

  it('clears an error once a later turn completes (reconnecting)', () => {
    const run = parseCodexStream([
      line({ type: 'error', message: 'Reconnecting... 1/5' }),
      completed({ input_tokens: 1 }),
    ]);
    expect(run.failure).toBeUndefined();
  });

  it('keeps turn.failed and trailing errors as the failure', () => {
    expect(
      parseCodexStream([line({ type: 'turn.failed', error: { message: 'nope' } })]).failure,
    ).toBe('nope');
    expect(
      parseCodexStream([completed({ input_tokens: 1 }), line({ type: 'error', message: 'late' })])
        .failure,
    ).toBe('late');
  });

  it('ignores non-JSON, non-object and unknown lines', () => {
    const run = parseCodexStream(['hello', '{oops', '', '[1]', line({ type: 'mystery' })]);
    expect(run.sawEvents).toBe(false);
    expect(run.text).toBeUndefined();
  });

  it('maps items to progress events without leaking command text', () => {
    const p = new CodexStreamParser();
    expect(
      p.push(
        line({
          type: 'item.completed',
          item: { type: 'command_execution', command: 'rm -rf secret' },
        }),
      ),
    ).toEqual([{ type: 'tool-call', name: 'shell' }]);
    expect(
      p.push(
        line({
          type: 'item.completed',
          item: { type: 'file_change', changes: [{ path: 'a' }, { path: 'b' }] },
        }),
      ),
    ).toEqual([{ type: 'tool-call', name: 'edit', detail: '2 files' }]);
    expect(
      p.push(line({ type: 'item.completed', item: { type: 'agent_message', text: 'x' } })),
    ).toEqual([{ type: 'status', message: 'agent message' }]);
    expect(p.push(line({ type: 'item.started', item: { type: 'command_execution' } }))).toEqual([]);
  });
});

describe('classifyFailure', () => {
  it.each([
    ['401 Unauthorized', 'AUTH_REQUIRED'],
    ['Not logged in', 'AUTH_REQUIRED'],
    ['please login again', 'AUTH_REQUIRED'],
    ['429 Too Many Requests', 'QUOTA_EXHAUSTED'],
    ['rate limit reached', 'QUOTA_EXHAUSTED'],
    ["You've hit your usage limit", 'QUOTA_EXHAUSTED'],
    ['quota exceeded', 'QUOTA_EXHAUSTED'],
    ['socket hang up', 'PROVIDER_ERROR'],
  ])('%s -> %s', (message, code) => {
    expect(classifyFailure(message)).toBe(code);
  });
});
