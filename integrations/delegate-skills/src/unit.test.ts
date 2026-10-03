import { isNexarError } from '@nexar/contracts';
import type { NexarError } from '@nexar/contracts';
import { describe, expect, it } from 'vitest';
import { resolve } from 'node:path';
import {
  DEFAULT_ALLOW_HOSTS,
  checkRelayPin,
  delegateSkillsCodexResource,
  readSettings,
} from './index.js';
import { classifyFailure, parseRelayResult, usageFromEvents } from './result.js';
import { parseRelayDuration } from './settings.js';
import { FAKE_RELAY, FAKE_RELAY_SHA256 } from './test/harness.js';

const SHA = 'a'.repeat(64);

function withOptions(
  options: Record<string, unknown>,
): ReturnType<typeof delegateSkillsCodexResource> {
  const base = delegateSkillsCodexResource();
  return { ...base, runtime: { ...base.runtime, options } };
}

const valid = { relay: 'codex', relayPath: '/opt/ds/relay.mjs', relaySha256: SHA };

function settingsError(options: Record<string, unknown>): NexarError {
  try {
    readSettings(withOptions(options));
  } catch (e) {
    if (isNexarError(e)) return e;
    throw e;
  }
  throw new Error('expected CONFIGURATION_ERROR');
}

describe('delegateSkillsCodexResource', () => {
  it('describes a relay-tagged codex agent', () => {
    const r = delegateSkillsCodexResource();
    expect(r.id).toBe('codex-relay');
    expect(r.kind).toMatchObject({ type: 'agent', agent: 'codex', interface: 'cli' });
    expect(r.runtime.adapter).toBe('delegate-skills');
    expect(r.tags).toEqual(['delegate-skills', 'relay']);
    expect(r.capabilities).toContain('repo-editing');
  });
});

describe('readSettings', () => {
  it('applies defaults', () => {
    expect(readSettings(withOptions(valid))).toEqual({
      relay: 'codex',
      relayPath: resolve('/opt/ds/relay.mjs'),
      relaySha256: SHA,
      nodePath: 'node',
      timeout: '30m',
      timeoutMs: 30 * 60 * 1000,
      allowHosts: DEFAULT_ALLOW_HOSTS,
      model: undefined,
    });
  });

  it('reads every option and lowercases the pin', () => {
    const s = readSettings(
      withOptions({
        ...valid,
        relaySha256: 'AB'.repeat(32),
        nodePath: '/usr/bin/node',
        model: 'gpt-x',
        effort: 'high',
        timeout: '1h30m',
        codexHome: '/home/o/.codex',
        allowHosts: ['api.openai.com'],
      }),
    );
    expect(s).toMatchObject({
      relaySha256: 'ab'.repeat(32),
      nodePath: '/usr/bin/node',
      model: 'gpt-x',
      effort: 'high',
      timeout: '1h30m',
      timeoutMs: 90 * 60 * 1000,
      codexHome: resolve('/home/o/.codex'),
      allowHosts: ['api.openai.com'],
    });
  });

  it('requires relay, and points claude at the native adapter', () => {
    expect(settingsError({ relayPath: '/x/relay.mjs', relaySha256: SHA }).code).toBe(
      'CONFIGURATION_ERROR',
    );
    const claude = settingsError({ ...valid, relay: 'claude' });
    expect(claude.code).toBe('CONFIGURATION_ERROR');
    expect(claude.message).toContain('native claude-code adapter');
    expect(claude.message).toContain('nested');
  });

  it('points agy at the experimental antigravity adapter and rejects other relays', () => {
    expect(settingsError({ ...valid, relay: 'agy' }).message).toContain('antigravity');
    for (const relay of ['pi', 'aider', 7]) {
      const e = settingsError({ ...valid, relay });
      expect(e.code).toBe('CONFIGURATION_ERROR');
      expect(e.message).toContain('unsupported in v0.3');
    }
  });

  it('requires an absolute relayPath', () => {
    expect(settingsError({ relay: 'codex', relaySha256: SHA }).code).toBe('CONFIGURATION_ERROR');
    expect(settingsError({ ...valid, relayPath: 'relay.mjs' }).message).toContain('absolute');
  });

  it('requires a 64-hex relaySha256', () => {
    for (const relaySha256 of [
      undefined,
      'abc',
      'g'.repeat(64),
      'a'.repeat(63),
      'a'.repeat(65),
      5,
    ]) {
      const e = settingsError({ relay: 'codex', relayPath: valid.relayPath, relaySha256 });
      expect(e.code).toBe('CONFIGURATION_ERROR');
      expect(e.message).toContain('relaySha256');
    }
  });

  it('rejects unknown keys and bad values', () => {
    expect(settingsError({ ...valid, binary: 'codex' }).message).toContain(
      "unknown runtime.options key 'binary'",
    );
    expect(settingsError({ ...valid, effort: 'max' }).code).toBe('CONFIGURATION_ERROR');
    expect(settingsError({ ...valid, timeout: '10 minutes' }).code).toBe('CONFIGURATION_ERROR');
    expect(settingsError({ ...valid, timeout: '0s' }).code).toBe('CONFIGURATION_ERROR');
    expect(settingsError({ ...valid, codexHome: 'rel' }).message).toContain('absolute');
    expect(settingsError({ ...valid, allowHosts: [] }).code).toBe('CONFIGURATION_ERROR');
    expect(settingsError({ ...valid, nodePath: '' }).code).toBe('CONFIGURATION_ERROR');
  });
});

describe('parseRelayDuration', () => {
  it('parses h/m/s strings and rejects the rest', () => {
    expect(parseRelayDuration('30m')).toBe(1_800_000);
    expect(parseRelayDuration('1h2m3s')).toBe(3_723_000);
    expect(parseRelayDuration('')).toBeUndefined();
    expect(parseRelayDuration('0m')).toBeUndefined();
    expect(parseRelayDuration('30')).toBeUndefined();
    expect(parseRelayDuration('99999h')).toBeUndefined();
  });
});

describe('checkRelayPin', () => {
  it('reports ok, mismatch and missing', async () => {
    expect(await checkRelayPin(FAKE_RELAY, FAKE_RELAY_SHA256)).toBe('ok');
    expect(await checkRelayPin(FAKE_RELAY, SHA)).toBe('mismatch');
    expect(await checkRelayPin(`${FAKE_RELAY}.nope`, SHA)).toBe('missing');
  });
});

describe('parseRelayResult', () => {
  const ok = { schema: 'delegate-relay.result.v1', status: 'completed', finalMessage: 'hi' };

  it('accepts a minimal valid result', () => {
    expect(parseRelayResult(JSON.stringify(ok))).toEqual({
      status: 'completed',
      finalMessage: 'hi',
    });
    expect(parseRelayResult(JSON.stringify({ ...ok, finalMessage: null }))?.finalMessage).toBe('');
  });

  it('keeps only the touched-file count', () => {
    const r = parseRelayResult(JSON.stringify({ ...ok, touchedFiles: [' M secret-name.txt'] }));
    expect(r?.touchedCount).toBe(1);
    expect(JSON.stringify(r)).not.toContain('secret-name');
  });

  it('rejects wrong schema, unknown status, bad types and non-JSON', () => {
    expect(parseRelayResult('nope')).toBeUndefined();
    expect(parseRelayResult('[]')).toBeUndefined();
    expect(parseRelayResult(JSON.stringify({ ...ok, schema: 'x' }))).toBeUndefined();
    expect(parseRelayResult(JSON.stringify({ ...ok, status: 'weird' }))).toBeUndefined();
    expect(parseRelayResult(JSON.stringify({ ...ok, status: 1 }))).toBeUndefined();
    expect(parseRelayResult(JSON.stringify({ ...ok, finalMessage: {} }))).toBeUndefined();
  });
});

describe('usageFromEvents', () => {
  const turn = (usage: Record<string, number>): string =>
    JSON.stringify({ type: 'turn.completed', usage });

  it('uses the last turn.completed and adds reasoning to output', () => {
    const u = usageFromEvents(
      `${turn({ input_tokens: 1, output_tokens: 1 })}\nnot json\n${turn({
        input_tokens: 100,
        cached_input_tokens: 40,
        output_tokens: 7,
        reasoning_output_tokens: 3,
      })}\n`,
    );
    expect(u.inputTokens).toMatchObject({ status: 'measured', value: 100 });
    expect(u.outputTokens).toMatchObject({ status: 'measured', value: 10 });
    expect(u.cacheReadTokens).toMatchObject({ status: 'measured', value: 40 });
    expect(u.turns).toMatchObject({ status: 'measured', value: 2 });
    expect(u.costUsd.status).toBe('unavailable');
  });

  it('is unavailable (never a measured 0) for missing or all-zero usage', () => {
    for (const text of [
      undefined,
      '',
      turn({ input_tokens: 0, output_tokens: 0 }),
      '{"type":"turn.completed"}',
    ]) {
      const u = usageFromEvents(text);
      expect(u.inputTokens.status).toBe('unavailable');
      expect(u.outputTokens.status).toBe('unavailable');
      expect(u.costUsd.status).toBe('unavailable');
    }
  });
});

describe('classifyFailure', () => {
  it('checks auth before limits, else PROVIDER_ERROR', () => {
    expect(classifyFailure('401 Unauthorized')).toBe('AUTH_REQUIRED');
    expect(classifyFailure('Not logged in')).toBe('AUTH_REQUIRED');
    expect(classifyFailure("You've hit your usage limit")).toBe('QUOTA_EXHAUSTED');
    expect(classifyFailure('429 rate limit')).toBe('QUOTA_EXHAUSTED');
    expect(classifyFailure('segfault')).toBe('PROVIDER_ERROR');
  });
});
