import { isNexarError } from '@nexar/contracts';
import type { ResourceDescriptor } from '@nexar/contracts';
import { describe, expect, it } from 'vitest';
import {
  buildChildEnv,
  claudeCodeResource,
  parseClaudeResult,
  parseToolCallNames,
} from './index.js';
import { readSettings } from './settings.js';

describe('buildChildEnv', () => {
  it('removes CLAUDECODE and credentials belonging to other services', () => {
    const env = buildChildEnv({
      PATH: '/bin',
      HOME: '/home/u',
      CLAUDECODE: '1',
      GH_TOKEN: 'x',
      GITHUB_ACTIONS: 'true',
      AWS_REGION: 'us-east-1',
      AWS_SECRET_ACCESS_KEY: 'x',
      CLOUDSDK_CORE_PROJECT: 'p',
      GOOGLE_APPLICATION_CREDENTIALS: '/k.json',
      NPM_TOKEN: 'x',
      DB_PASSWORD: 'x',
      OPENAI_API_KEY: 'x',
      SSH_PRIVATE_KEY: 'x',
    });
    expect(env).toEqual({ PATH: '/bin', HOME: '/home/u' });
  });

  it('keeps Claude-runtime and Anthropic variables even when they look secret', () => {
    const env = buildChildEnv({
      CLAUDE_X: '1',
      CLAUDE_CODE_OAUTH_TOKEN: 'keep',
      ANTHROPIC_BASE_URL: 'https://proxy.example',
      ANTHROPIC_API_KEY: 'keep',
    });
    expect(Object.keys(env).sort()).toEqual([
      'ANTHROPIC_API_KEY',
      'ANTHROPIC_BASE_URL',
      'CLAUDE_CODE_OAUTH_TOKEN',
      'CLAUDE_X',
    ]);
  });

  it('does not mutate its input and skips undefined values', () => {
    const parent = { A: '1', B: undefined, CLAUDECODE: '1' };
    expect(buildChildEnv(parent)).toEqual({ A: '1' });
    expect(parent.CLAUDECODE).toBe('1');
  });
});

describe('parseClaudeResult', () => {
  const full = {
    type: 'result',
    subtype: 'success',
    is_error: false,
    num_turns: 2,
    result: 'hi',
    total_cost_usd: 0.5,
    usage: {
      input_tokens: 1,
      output_tokens: 2,
      cache_read_input_tokens: 3,
      cache_creation_input_tokens: 4,
    },
    modelUsage: { 'claude-x': {}, 'claude-y': {} },
  };

  it('maps every field', () => {
    expect(parseClaudeResult(JSON.stringify(full))).toEqual({
      text: 'hi',
      isError: false,
      subtype: 'success',
      numTurns: 2,
      totalCostUsd: 0.5,
      inputTokens: 1,
      outputTokens: 2,
      cacheReadTokens: 3,
      cacheWriteTokens: 4,
      model: 'claude-x',
    });
  });

  it('takes the last result line and ignores noise around it', () => {
    const out = [
      'warning: something',
      JSON.stringify({ type: 'result', result: 'old' }),
      JSON.stringify({ type: 'system' }),
      JSON.stringify({ type: 'result', result: 'new' }),
      '',
      'trailing garbage',
    ].join('\n');
    expect(parseClaudeResult(out)?.text).toBe('new');
  });

  it('handles pretty-printed output and message arrays', () => {
    expect(parseClaudeResult(JSON.stringify(full, null, 2))?.text).toBe('hi');
    expect(parseClaudeResult(JSON.stringify([{ type: 'system' }, full]))?.text).toBe('hi');
  });

  it('returns undefined when there is no result object', () => {
    expect(parseClaudeResult('')).toBeUndefined();
    expect(parseClaudeResult('not json')).toBeUndefined();
    expect(parseClaudeResult(JSON.stringify({ type: 'assistant' }))).toBeUndefined();
    expect(parseClaudeResult('42')).toBeUndefined();
  });

  it('omits missing or wrongly-typed numbers instead of inventing zeros', () => {
    const p = parseClaudeResult(
      JSON.stringify({ type: 'result', usage: { input_tokens: '5' }, total_cost_usd: null }),
    );
    expect(p).toEqual({ text: '', isError: false });
  });

  it('reads error details', () => {
    const p = parseClaudeResult(
      JSON.stringify({
        type: 'result',
        is_error: true,
        subtype: 'error_max_turns',
        api_error_status: 429,
      }),
    );
    expect(p).toMatchObject({ isError: true, subtype: 'error_max_turns', apiErrorStatus: 429 });
  });
});

describe('readSettings', () => {
  const withOptions = (options: Record<string, unknown>): ResourceDescriptor => {
    const base = claudeCodeResource();
    return { ...base, runtime: { ...base.runtime, options } };
  };

  it('applies read-only defaults', () => {
    expect(readSettings(withOptions({}))).toEqual({
      permissionMode: 'plan',
      tools: ['Read', 'Glob', 'Grep'],
    });
  });

  it('prefers options.model, then kind.underlying.model', () => {
    const base = claudeCodeResource();
    const underlying = {
      ...base,
      kind: { ...base.kind, underlying: { provider: 'anthropic', model: 'from-kind' } },
    } as ResourceDescriptor;
    expect(readSettings(underlying).model).toBe('from-kind');
    expect(
      readSettings({ ...underlying, runtime: { ...underlying.runtime, options: { model: 'opt' } } })
        .model,
    ).toBe('opt');
    expect(readSettings(withOptions({})).model).toBeUndefined();
  });

  it('accepts valid values and ignores unknown keys', () => {
    expect(
      readSettings(
        withOptions({
          permissionMode: 'acceptEdits',
          tools: ['Read', 'Edit'],
          maxTurns: 3,
          timeoutMs: 1000,
          somethingElse: { any: 'thing' },
        }),
      ),
    ).toEqual({
      permissionMode: 'acceptEdits',
      tools: ['Read', 'Edit'],
      maxTurns: 3,
      timeoutMs: 1000,
    });
  });

  it.each([
    ['model', 5],
    ['model', ''],
    ['permissionMode', 'bypassPermissions'],
    ['tools', 'Read'],
    ['tools', ['Read', 3]],
    ['maxTurns', '3'],
    ['maxTurns', 0],
    ['maxTurns', 1.5],
    ['timeoutMs', -1],
    ['timeoutMs', '100'],
    ['engineeringTimeoutMs', 0],
    ['sandbox', 'yes'],
    ['sandbox', ['x']],
    ['sandbox', { allowHosts: 'api.anthropic.com' }],
    ['sandbox', { allowHosts: [''] }],
    ['sandbox', { mounts: {} }],
    ['sandbox', { mounts: [{ hostPath: '/a', sandboxPath: '/b', access: 'rw' }] }],
    ['sandbox', { mounts: [{ hostPath: '/a', sandboxPath: '', access: 'read-only' }] }],
    ['sandbox', { mounts: ['/a'] }],
  ])('rejects %s = %j with CONFIGURATION_ERROR', (key, value) => {
    try {
      readSettings(withOptions({ [key]: value }));
      expect.unreachable('should have thrown');
    } catch (e) {
      expect(isNexarError(e) && e.code).toBe('CONFIGURATION_ERROR');
    }
  });
});

describe('readSettings: engineering options', () => {
  const withOptions = (options: Record<string, unknown>): ResourceDescriptor => {
    const base = claudeCodeResource();
    return { ...base, runtime: { ...base.runtime, options } };
  };

  it('reads sandbox options and the engineering timeout', () => {
    const mount = { hostPath: '/a', sandboxPath: '/b', access: 'read-only' };
    expect(
      readSettings(
        withOptions({
          engineeringTimeoutMs: 5000,
          sandbox: { allowHosts: ['api.anthropic.com'], mounts: [{ ...mount, extra: 1 }] },
        }),
      ),
    ).toMatchObject({
      engineeringTimeoutMs: 5000,
      sandbox: { allowHosts: ['api.anthropic.com'], mounts: [mount] },
    });
    expect(readSettings(withOptions({ sandbox: {} })).sandbox).toEqual({});
  });
});

describe('parseToolCallNames', () => {
  it('returns tool_use names only, never inputs', () => {
    const line = JSON.stringify({
      type: 'assistant',
      message: {
        content: [
          { type: 'text', text: 'hi' },
          { type: 'tool_use', name: 'Bash', input: { command: 'secret' } },
        ],
      },
    });
    expect(parseToolCallNames(line)).toEqual(['Bash']);
  });

  it('ignores other lines and garbage', () => {
    expect(parseToolCallNames('nope')).toEqual([]);
    expect(parseToolCallNames(JSON.stringify({ type: 'result' }))).toEqual([]);
    expect(parseToolCallNames(JSON.stringify({ type: 'assistant', message: {} }))).toEqual([]);
  });

  it('counts permission denials without keeping them', () => {
    const p = parseClaudeResult(
      JSON.stringify({ type: 'result', permission_denials: [{ tool_name: 'Bash' }, {}] }),
    );
    expect(p?.permissionDenials).toBe(2);
    expect(JSON.stringify(p)).not.toContain('tool_name');
  });
});

describe('claudeCodeResource', () => {
  it('describes a native, subscription-backed agent and accepts overrides', () => {
    const r = claudeCodeResource({ displayName: 'Custom' });
    expect(r.capabilities).toContain('shell-execution');
    expect(r).toMatchObject({
      id: 'claude-code',
      displayName: 'Custom',
      runtime: { adapter: 'claude-code', locality: 'local' },
      auth: { mode: 'subscription', credential: { source: 'runtime-managed' } },
      cost: { model: 'subscription' },
      tags: ['native-agent'],
    });
  });
});
