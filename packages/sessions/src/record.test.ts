import { NexarError } from '@nexar/contracts';
import { describe, expect, it } from 'vitest';
import { MAX_TEXT_CHARS } from './limits.js';
import { parseSession, serializeSession } from './record.js';
import { beginTurn, createSession } from './transitions.js';

const SID = `ses_${'a'.repeat(32)}`;
const T1 = `turn_${'1'.repeat(32)}`;
const NOW = '2026-10-02T10:00:00.000Z';

function valid() {
  const base = createSession({ id: SID, projectId: 'demo', mode: 'code', title: 'T', now: NOW });
  return beginTurn(base, { turnId: T1, submissionKey: 'key-0000000000001', text: 'hi', now: NOW })
    .session;
}

function edit(change: (record: Record<string, unknown>) => void): string {
  const record = JSON.parse(serializeSession(valid())) as Record<string, unknown>;
  change(record);
  return JSON.stringify(record);
}

function turnOf(record: Record<string, unknown>): Record<string, unknown> {
  return (record['turns'] as Record<string, unknown>[])[0] as Record<string, unknown>;
}

function expectCorrupt(text: string, expectedId?: string): void {
  try {
    parseSession(text, expectedId);
  } catch (e) {
    expect(e).toBeInstanceOf(NexarError);
    const error = e as NexarError;
    expect(error.code).toBe('VALIDATION_ERROR');
    expect(error.message).toBe('Session record is unreadable');
    expect(error.details).toEqual({ reason: 'corrupt-record' });
    return;
  }
  throw new Error('expected the record to be rejected');
}

describe('session records', () => {
  it('round-trips a valid session', () => {
    const session = valid();
    expect(parseSession(serializeSession(session), SID)).toEqual(session);
  });

  it('rejects malformed json and non-objects', () => {
    expectCorrupt('{ nope');
    expectCorrupt('[]');
    expectCorrupt('null');
    expectCorrupt('"x"');
  });

  it('rejects unknown schema versions and extra keys', () => {
    expectCorrupt(edit((r) => (r['schemaVersion'] = 2)));
    expectCorrupt(edit((r) => (r['extra'] = true)));
    expectCorrupt(edit((r) => (turnOf(r)['extra'] = true)));
  });

  it('rejects prototype keys anywhere', () => {
    const text = serializeSession(valid());
    expectCorrupt(text.replace('{', '{"__proto__":{"polluted":true},'));
    expectCorrupt(text.replace('{', '{"constructor":{"prototype":{}},'));
    expectCorrupt(
      edit((r) => {
        turnOf(r)['intent'] = { kind: 'general', source: 'rules', ruleIds: [], policy: 'p' };
      }).replace('"ruleIds":[]', '"ruleIds":[],"__proto__":1'),
    );
    expect(({} as Record<string, unknown>)['polluted']).toBeUndefined();
  });

  it('rejects wrong id patterns', () => {
    expectCorrupt(edit((r) => (r['id'] = 'ses_short')));
    expectCorrupt(edit((r) => (turnOf(r)['id'] = 'turn_x')));
    expectCorrupt(edit((r) => (turnOf(r)['submissionKey'] = 'short')));
    expectCorrupt(edit((r) => (turnOf(r)['approvalIds'] = ['apr_x'])));
    expectCorrupt(edit((r) => (r['projectId'] = '../etc')));
  });

  it('round-trips and bounds the engineering outcome', () => {
    const engineering = {
      planeTaskId: 'task_1',
      status: 'not-accepted',
      files: 1,
      approvalId: `apr_${'d'.repeat(32)}`,
    };
    const stored = edit((r) => {
      turnOf(r)['state'] = 'failed';
      turnOf(r)['outcome'] = { text: 'x', engineering };
      r['activeTurnId'] = null;
    });
    expect(parseSession(stored).turns[0]?.outcome?.engineering).toEqual(engineering);
    const reported = {
      planeTaskId: 'task_1',
      status: 'reported',
      lanes: [{ role: 'report', resourceId: 'dsh:deepseek' }],
    };
    const storedReport = edit((r) => {
      turnOf(r)['outcome'] = { text: 'x', engineering: reported };
    });
    expect(parseSession(storedReport).turns[0]?.outcome?.engineering).toEqual(reported);
    for (const bad of [
      { ...engineering, status: 'bogus' },
      { ...engineering, extra: 1 },
      { ...engineering, planeTaskId: '../x' },
      { ...engineering, commit: 'zz' },
      { ...engineering, files: -2 },
      { ...engineering, approvalId: 'apr_x' },
      { ...engineering, lanes: [{ role: 'r', resourceId: 'x', extra: 1 }] },
      { ...engineering, lanes: Array.from({ length: 17 }, () => ({ role: 'r', resourceId: 'x' })) },
    ]) {
      expectCorrupt(
        edit((r) => {
          turnOf(r)['state'] = 'failed';
          turnOf(r)['outcome'] = { engineering: bad };
          r['activeTurnId'] = null;
        }),
      );
    }
  });

  it('round-trips lane executor facts and a task control path, and rejects anything else', () => {
    const lane = {
      role: 'implementation',
      resourceId: 'dsh:deepseek',
      executor: 'engine',
      engine: 'dsh',
      executorReason: 'engine-not-selected',
      controlResourceId: 'pi:deepseek-chat',
    };
    const engineering = { planeTaskId: 'task_1', status: 'reported', lanes: [lane] };
    const stored = edit((r) => {
      turnOf(r)['outcome'] = { text: 'x', engineering };
    });
    expect(parseSession(stored).turns[0]?.outcome?.engineering).toEqual(engineering);
    for (const bad of [{ executor: 'other' }, { engine: 'codex' }, { token: 't' }]) {
      expectCorrupt(
        edit((r) => {
          turnOf(r)['outcome'] = { engineering: { ...engineering, lanes: [{ ...lane, ...bad }] } };
        }),
      );
    }

    const task = { taskId: 'task_1', state: 'succeeded' };
    const control = { path: 'gateway', resourceId: 'ctl-model', restarts: 1 };
    const withControl = edit((r) => {
      turnOf(r)['tasks'] = [{ ...task, control }];
    });
    expect(parseSession(withControl).turns[0]?.tasks[0]?.control).toEqual(control);
    for (const bad of [
      { path: 'other' },
      { path: 'gateway', restarts: -1 },
      { path: 'gateway', token: 't' },
    ]) {
      expectCorrupt(
        edit((r) => {
          turnOf(r)['tasks'] = [{ ...task, control: bad }];
        }),
      );
    }
  });

  it('still reads records written before the retired engine was removed (ADR-030)', () => {
    const engineering = {
      planeTaskId: 'task_1',
      status: 'reported',
      lanes: [
        { role: 'implementation', resourceId: 'x:y', executor: 'engine', engine: 'openworker' },
      ],
    };
    const lane = {
      policy: 'rules@1',
      mode: 'cowork',
      requestedLane: 'cowork',
      effectiveLane: 'direct',
      fallbackReason: 'openworker-unavailable',
    };
    const stored = edit((r) => {
      turnOf(r)['lane'] = lane;
      turnOf(r)['outcome'] = { text: 'x', engineering };
    });
    const turn = parseSession(stored).turns[0];
    expect(turn?.outcome?.engineering).toEqual(engineering);
    expect(turn?.lane?.fallbackReason).toBe('openworker-unavailable');
  });

  it('binds the record to the expected id', () => {
    expectCorrupt(serializeSession(valid()), `ses_${'b'.repeat(32)}`);
  });

  it('rejects oversize text and titles', () => {
    expectCorrupt(edit((r) => (turnOf(r)['text'] = 'x'.repeat(MAX_TEXT_CHARS + 1))));
    expectCorrupt(edit((r) => (r['title'] = 'x'.repeat(201))));
    expectCorrupt(edit((r) => (turnOf(r)['outcome'] = { text: 'x'.repeat(64 * 1024 + 1) })));
  });

  it('rejects inconsistent turn bookkeeping', () => {
    expectCorrupt(edit((r) => (r['activeTurnId'] = null)));
    expectCorrupt(edit((r) => (turnOf(r)['index'] = 3)));
    expectCorrupt(edit((r) => (turnOf(r)['state'] = 'succeeded')));
    expectCorrupt(edit((r) => (turnOf(r)['state'] = 'bogus')));
    expectCorrupt(edit((r) => (r['revision'] = 0)));
    expectCorrupt(edit((r) => (r['createdAt'] = 'yesterday')));
    expectCorrupt(
      edit((r) => {
        r['turns'] = [turnOf(r), { ...turnOf(r), id: `turn_${'2'.repeat(32)}`, index: 1 }];
      }),
    );
  });

  it('never serializes a session that would not read back', () => {
    const broken = { ...valid(), activeTurnId: null };
    expect(() => serializeSession(broken)).toThrow(NexarError);
    expect(() => serializeSession({ ...valid(), title: '' })).toThrow(NexarError);
  });

  it('parses context@1 manifests without the required-context fields and context@2 with them', () => {
    const base = {
      turnIds: [],
      omittedTurns: 0,
      truncatedTurnIds: [],
      chars: 10,
      artifactIds: [],
      hash: 'h'.repeat(64),
    };
    const withContext = (context: Record<string, unknown>): string =>
      edit((r) => (turnOf(r)['context'] = context));

    const v1 = parseSession(withContext({ policy: 'context@1', ...base }), SID);
    expect(v1.turns[0]?.context).toEqual({ policy: 'context@1', ...base });

    const v2 = {
      policy: 'context@2',
      ...base,
      requiredIds: [`mem_${'1'.repeat(32)}`],
      requiredHash: 'a'.repeat(64),
    };
    expect(parseSession(withContext(v2), SID).turns[0]?.context).toEqual(v2);

    expectCorrupt(withContext({ ...v2, requiredIds: ['nope'] }), SID);
    expectCorrupt(withContext({ ...v2, requiredHash: 'short' }), SID);
    expectCorrupt(withContext({ ...v2, extra: 1 }), SID);
  });
});
