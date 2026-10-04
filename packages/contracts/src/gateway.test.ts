import { describe, expect, it } from 'vitest';
import {
  CONTROL_TURN_LIMITS,
  INTELLIGENCE_LIMITS,
  validateControlTurnRequest,
  validateIntelligenceRequest,
} from './gateway.js';
import type { ControlTurnRequest, IntelligenceRequest, ModelTurnMessage } from './gateway.js';

const base: ControlTurnRequest = {
  lineage: { rootSessionId: 's', turnId: 't', correlationId: 'c', depth: 0 },
  engine: 'openworker',
  controlDecisionId: 'd1',
  messages: [{ role: 'user', content: 'hi' }],
};

const check = (patch: Partial<ControlTurnRequest>): void =>
  validateControlTurnRequest({ ...base, ...patch });

describe('validateControlTurnRequest', () => {
  it('accepts a well-formed request', () => {
    expect(() =>
      check({ tools: [{ name: 'read_file.v2-x', parameters: { type: 'object' } }] }),
    ).not.toThrow();
  });

  it('rejects an empty or oversized message list', () => {
    expect(() => check({ messages: [] })).toThrow(/at least one/);
    const many: ModelTurnMessage[] = Array.from(
      { length: CONTROL_TURN_LIMITS.maxMessages + 1 },
      () => ({ role: 'user', content: 'x' }),
    );
    expect(() => check({ messages: many })).toThrow(/messages/);
  });

  it('rejects too many tools and bad or duplicate tool names', () => {
    const tool = (name: string) => ({ name, parameters: {} });
    expect(() =>
      check({
        tools: Array.from({ length: CONTROL_TURN_LIMITS.maxTools + 1 }, (_, i) =>
          tool(`t${String(i)}`),
        ),
      }),
    ).toThrow(/tools/);
    for (const bad of ['', 'has space', 'a'.repeat(65), 'sl/ash']) {
      expect(() => check({ tools: [tool(bad)] })).toThrow(/Tool names/);
    }
    expect(() => check({ tools: [tool('a'), tool('a')] })).toThrow(/unique/);
  });

  it('rejects oversize content, extras and total request without echoing content', () => {
    const secret = 'SENTINEL-'.repeat(10);
    const big = secret + 'x'.repeat(CONTROL_TURN_LIMITS.maxContentBytes);
    let message = '';
    try {
      check({ messages: [{ role: 'user', content: big }] });
    } catch (e) {
      message = (e as Error).message;
    }
    expect(message).toMatch(/exceeds/);
    expect(message).not.toContain('SENTINEL');

    expect(() =>
      check({
        messages: [
          { role: 'assistant', extras: { blob: 'x'.repeat(CONTROL_TURN_LIMITS.maxExtrasBytes) } },
        ],
      }),
    ).toThrow(/extras/i);

    const chunk = 'y'.repeat(CONTROL_TURN_LIMITS.maxContentBytes - 10);
    expect(() =>
      check({ messages: Array.from({ length: 9 }, () => ({ role: 'user', content: chunk })) }),
    ).toThrow(/request exceeds/);
  });

  it('rejects unknown roles and non-string content', () => {
    expect(() => check({ messages: [{ role: 'bot' as 'user', content: 'x' }] })).toThrow(/role/);
    expect(() => check({ messages: [{ role: 'user', content: 5 as unknown as string }] })).toThrow(
      /string/,
    );
  });
});

describe('validateIntelligenceRequest', () => {
  const ok: IntelligenceRequest = {
    lineage: { rootSessionId: 's', turnId: 't', correlationId: 'c', depth: 0, chain: ['nexar'] },
    unitId: 'unit_1.a:b-c',
    kind: 'analysis',
    requirements: { capabilities: ['text-generation'] },
    input: 'hello',
    access: 'read-only',
  };
  const check = (patch: Partial<IntelligenceRequest>): void =>
    validateIntelligenceRequest({ ...ok, ...patch });

  it('accepts a well-formed request and the boundary values', () => {
    expect(() => check({})).not.toThrow();
    expect(() =>
      check({
        unitId: 'x'.repeat(64),
        input: 'a'.repeat(INTELLIGENCE_LIMITS.maxInputBytes),
        documentRefs: Array.from({ length: 32 }, () => 'r'.repeat(512)),
        timeoutMs: INTELLIGENCE_LIMITS.maxTimeoutMs,
      }),
    ).not.toThrow();
  });

  it('rejects bad unit ids', () => {
    for (const unitId of ['', 'x'.repeat(65), 'has space', 'a/b', 'a\nb']) {
      expect(() => check({ unitId })).toThrow(/unitId/);
    }
  });

  it('bounds input by bytes, not characters', () => {
    expect(() => check({ input: 'a'.repeat(INTELLIGENCE_LIMITS.maxInputBytes + 1) })).toThrow(
      /input/,
    );
    expect(() => check({ input: 'é'.repeat(INTELLIGENCE_LIMITS.maxInputBytes / 2 + 1) })).toThrow(
      /input/,
    );
  });

  it('bounds document refs and timeout', () => {
    expect(() => check({ documentRefs: Array.from({ length: 33 }, () => 'r') })).toThrow(/refs/);
    expect(() => check({ documentRefs: ['r'.repeat(513)] })).toThrow(/refs/);
    expect(() => check({ documentRefs: [''] })).toThrow(/refs/);
    expect(() => check({ timeoutMs: INTELLIGENCE_LIMITS.maxTimeoutMs + 1 })).toThrow(/timeoutMs/);
    expect(() => check({ timeoutMs: 0 })).toThrow(/timeoutMs/);
    expect(() => check({ budgetUsd: -1 })).toThrow(/budgetUsd/);
  });

  it('never echoes the input in an error', () => {
    try {
      check({ unitId: 'SENTINEL bad id', input: 'SENTINEL' });
    } catch (e) {
      expect(String((e as Error).message)).not.toContain('SENTINEL');
    }
  });
});
