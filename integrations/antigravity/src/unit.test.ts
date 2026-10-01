import { isNexarError } from '@nexar/contracts';
import type { ResourceDescriptor } from '@nexar/contracts';
import { describe, expect, it } from 'vitest';
import {
  AgyStreamParser,
  antigravityResource,
  buildAgyArgs,
  classifyFailure,
  isInteractiveOAuth,
  isPermissionDenial,
  parseAgyErrorLine,
  parseAgyStream,
  readSettings,
  toUsage,
} from './index.js';

function withOptions(options: Record<string, unknown>): ResourceDescriptor {
  const base = antigravityResource();
  return { ...base, runtime: { ...base.runtime, options } };
}

const line = (e: unknown): string => JSON.stringify(e);
const result = (fields: Record<string, unknown>): string =>
  line({ type: 'result', status: 'SUCCESS', response: 'ok', ...fields });

describe('antigravityResource', () => {
  it('describes an experimental, subscription-auth native agent with no secret fields', () => {
    const r = antigravityResource();
    expect(r.id).toBe('antigravity');
    expect(r.kind).toEqual({
      type: 'agent',
      agent: 'antigravity',
      interface: 'cli',
      underlying: { provider: 'google' },
    });
    expect(r.runtime).toEqual({
      adapter: 'antigravity',
      locality: 'local',
      options: { acknowledgeExperimental: false },
    });
    expect(r.auth).toEqual({
      mode: 'subscription',
      credential: { source: 'runtime-managed', description: 'agy sign-in (Google account)' },
    });
    expect(r.cost).toEqual({ model: 'subscription' });
    expect(r.tags).toEqual(['native-agent', 'experimental']);
    expect(r.capabilities).toEqual([
      'coding',
      'repo-editing',
      'code-review',
      'shell-execution',
      'tool-use',
      'reasoning',
    ]);
  });
});

describe('readSettings', () => {
  it('defaults: not opted in, Google hosts, no overrides', () => {
    const s = readSettings(antigravityResource());
    expect(s.acknowledgeExperimental).toBe(false);
    expect(s.allowHosts).toEqual([
      'cloudcode-pa.googleapis.com',
      'oauth2.googleapis.com',
      'www.googleapis.com',
    ]);
    expect(s.model).toBeUndefined();
    expect(s.mounts).toBeUndefined();
  });

  it('accepts every documented option', () => {
    const mounts = [{ hostPath: '/a', sandboxPath: '/b', access: 'read-only' as const }];
    const s = readSettings(
      withOptions({
        acknowledgeExperimental: true,
        binary: '/opt/agy',
        model: 'm',
        effort: 'max',
        timeoutMs: 1000,
        allowHosts: ['x.googleapis.com'],
        sandbox: { mounts },
        agyHome: '/home/me/.gemini',
      }),
    );
    expect(s).toEqual({
      acknowledgeExperimental: true,
      binary: '/opt/agy',
      model: 'm',
      effort: 'max',
      timeoutMs: 1000,
      allowHosts: ['x.googleapis.com'],
      mounts,
    });
  });

  it.each([
    ['unknown key', { nope: 1 }],
    ['non-boolean acknowledgeExperimental', { acknowledgeExperimental: 'yes' }],
    ['empty binary', { binary: '' }],
    ['bad effort', { effort: 'extreme' }],
    ['non-positive timeout', { timeoutMs: 0 }],
    ['empty allowHosts', { allowHosts: [] }],
    ['non-object sandbox', { sandbox: 'x' }],
    ['unknown sandbox key', { sandbox: { allowHosts: ['a'] } }],
    [
      'bad mount access',
      { sandbox: { mounts: [{ hostPath: '/a', sandboxPath: '/b', access: 'rw' }] } },
    ],
    ['empty agyHome', { agyHome: '' }],
  ])('rejects %s with CONFIGURATION_ERROR', (_name, options) => {
    try {
      readSettings(withOptions(options));
    } catch (e) {
      expect(isNexarError(e) && e.code).toBe('CONFIGURATION_ERROR');
      return;
    }
    throw new Error('expected rejection');
  });
});

describe('buildAgyArgs', () => {
  it('uses the --print= form and never --sandbox', () => {
    const args = buildAgyArgs(readSettings(withOptions({ effort: 'low', model: 'm' })), '-x');
    expect(args).toEqual([
      '--output-format',
      'stream-json',
      '--dangerously-skip-permissions',
      '--add-dir',
      '/work',
      '--disable-slash-commands',
      '--model',
      'm',
      '--effort',
      'low',
      '--print=-x',
    ]);
    expect(args).not.toContain('--sandbox');
  });
});

describe('AgyStreamParser', () => {
  it('reads the final result: response, usage, turns', () => {
    const run = parseAgyStream([
      line({ type: 'init', conversation_id: 'c' }),
      result({
        response: 'done',
        num_turns: 3,
        usage: { input_tokens: 5, output_tokens: 2, thinking_tokens: 1, cache_read_tokens: 4 },
      }),
    ]);
    expect(run).toMatchObject({
      sawResult: true,
      status: 'SUCCESS',
      response: 'done',
      turns: 3,
      usage: { inputTokens: 5, outputTokens: 2, thinkingTokens: 1, cacheReadTokens: 4 },
    });
  });

  it('emits a tool-call per tool step (name only) and ignores everything else', () => {
    const p = new AgyStreamParser();
    const step = (i: number, name: string): string =>
      line({
        type: 'step_update',
        step_index: i,
        tool_info: { name, parameters: { p: 'SECRET' }, output: 'SECRET' },
      });
    expect(p.push(step(1, 'run_command'))).toEqual([{ type: 'tool-call', name: 'run_command' }]);
    expect(p.push(step(1, 'run_command'))).toEqual([]);
    expect(p.push(step(2, 'write_file'))).toEqual([{ type: 'tool-call', name: 'write_file' }]);
    expect(p.push(line({ type: 'step_update', step_index: 3, text_delta: 'hi' }))).toEqual([]);
    expect(p.push('not json')).toEqual([]);
    expect(p.push('{broken')).toEqual([]);
    expect(p.push('[1]')).toEqual([]);
  });

  it('flattens object errors and keeps non-SUCCESS statuses', () => {
    const run = parseAgyStream([
      result({ status: 'CANCELED', error: { message: 'stopped' }, response: undefined }),
    ]);
    expect(run).toMatchObject({ status: 'CANCELED', error: 'stopped' });
    expect(run.response).toBeUndefined();
  });

  it('reports no result when none was streamed', () => {
    expect(parseAgyStream([line({ type: 'init' })]).sawResult).toBe(false);
  });
});

describe('toUsage', () => {
  it('adds thinking tokens to output and never invents cost', () => {
    const u = toUsage({
      sawResult: true,
      usage: { inputTokens: 10, outputTokens: 4, thinkingTokens: 6, cacheReadTokens: 2 },
      turns: 1,
    });
    expect(u.inputTokens).toEqual({ status: 'measured', value: 10 });
    expect(u.outputTokens).toEqual({ status: 'measured', value: 10 });
    expect(u.cacheReadTokens).toEqual({ status: 'measured', value: 2 });
    expect(u.costUsd.status).toBe('unavailable');
  });

  it.each([
    ['missing usage', { sawResult: true }],
    ['all-zero usage', { sawResult: true, usage: { inputTokens: 0, outputTokens: 0 } }],
    ['empty usage', { sawResult: true, usage: {} }],
  ])('%s is unavailable, never a measured 0', (_name, run) => {
    const u = toUsage(run);
    expect(u.inputTokens.status).toBe('unavailable');
    expect(u.outputTokens.status).toBe('unavailable');
    expect(u.turns?.status).toBe('unavailable');
  });

  it('leaves a counter unavailable when only others were reported', () => {
    const u = toUsage({ sawResult: true, usage: { inputTokens: 3 } });
    expect(u.inputTokens).toEqual({ status: 'measured', value: 3 });
    expect(u.outputTokens.status).toBe('unavailable');
  });
});

describe('classification', () => {
  it.each([
    ['Please sign in to continue', 'AUTH_REQUIRED'],
    ['OAuth token expired', 'AUTH_REQUIRED'],
    ['UNAUTHENTICATED', 'AUTH_REQUIRED'],
    ['HTTP 401', 'AUTH_REQUIRED'],
    ['quota exceeded', 'QUOTA_EXHAUSTED'],
    ['HTTP 429', 'QUOTA_EXHAUSTED'],
    ['rate limit hit', 'QUOTA_EXHAUSTED'],
    ['RESOURCE_EXHAUSTED', 'QUOTA_EXHAUSTED'],
    ['internal error', 'PROVIDER_ERROR'],
    ['HTTP 4291 weird', 'PROVIDER_ERROR'],
  ])('%s -> %s', (message, code) => {
    expect(classifyFailure(message)).toBe(code);
  });

  it('checks auth before quota', () => {
    expect(classifyFailure('401 and quota')).toBe('AUTH_REQUIRED');
  });

  it('parses the last AGY_ERROR line, tolerating bad payloads', () => {
    expect(
      parseAgyErrorLine(
        'noise\nAGY_ERROR: {"status":"ERROR","code":"INTERNAL","retryable":true}\n',
      ),
    ).toEqual({ status: 'ERROR', code: 'INTERNAL', retryable: true });
    expect(parseAgyErrorLine('AGY_ERROR: not json')).toEqual({});
    expect(parseAgyErrorLine('nothing here')).toBeUndefined();
  });

  it('detects interactive OAuth and soft permission denials', () => {
    expect(isInteractiveOAuth('Print mode: triggering interactive OAuth')).toBe(true);
    expect(isInteractiveOAuth('all good')).toBe(false);
    expect(isPermissionDenial('notice: permission denied for tool x')).toBe(true);
    expect(isPermissionDenial('all good')).toBe(false);
  });
});
