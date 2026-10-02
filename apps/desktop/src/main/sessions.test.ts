import { mkdir, readFile, readdir, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { FileSessionStore } from '@nexar/sessions';
import { NexarError, type NexarTask } from '@nexar/contracts';
import type { RunOptions } from '@nexar/core';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { ProjectDto, SessionDto, SessionSummaryDto, SubmitTurnResult } from '../shared/api.js';
import { CHANNELS } from '../shared/channels.js';
import { createBridge } from './bridge.js';
import type { EngineHost } from './engine-host.js';
import { addProject, createHarness, type Harness } from './test-harness.js';

const KEY1 = 'a'.repeat(32);
const KEY2 = 'b'.repeat(32);
const UNKNOWN_SESSION = `ses_${'0'.repeat(32)}`;
const UNKNOWN_TURN = `turn_${'0'.repeat(32)}`;

/**
 * An engine whose `run` waits for `release()` (or an abort) before running the real one, so a test
 * can hold a turn open. It also records every task it was asked to run.
 */
function gatedEngine(base: Harness): {
  /** The harness, calling through a bridge over the gated engine. */
  readonly harness: Harness;
  readonly tasks: NexarTask[];
  release(): void;
} {
  const engine: EngineHost = base.engine;
  let release: () => void = () => undefined;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  const tasks: NexarTask[] = [];
  const gated: EngineHost = {
    ...engine,
    composition: () => {
      const composition = engine.composition();
      const real = composition.runtime.nexar;
      const nexar = Object.create(real, {
        run: {
          value: (task: NexarTask, options: RunOptions) =>
            new Promise((resolve, reject) => {
              tasks.push(task);
              options.signal?.addEventListener(
                'abort',
                () => reject(new NexarError('EXECUTION_CANCELLED', 'The task was cancelled')),
                { once: true },
              );
              void gate.then(() => real.run(task, options).then(resolve, reject));
            }),
        },
      }) as typeof real;
      return { ...composition, runtime: { ...composition.runtime, nexar } };
    },
  };
  const bridge = createBridge({ ...base.deps, engine: gated });
  return {
    tasks,
    release: () => release(),
    harness: {
      ...base,
      call: (channel, args = {}) =>
        bridge.invoke(
          channel,
          args,
          (event) => base.events.push(event),
          (event) => base.sessionEvents.push(event),
        ) as Promise<never>,
    },
  };
}

let h: Harness;
let projectId: string;

beforeEach(async () => {
  h = await createHarness();
  projectId = await addProject(h);
});
afterEach(async () => {
  await h.cleanup();
});

async function create(
  harness: Harness,
  args: { projectId?: string; title?: string } = {},
): Promise<SessionDto> {
  const result = await harness.call<SessionDto>(CHANNELS.sessionsCreate, {
    projectId: args.projectId ?? projectId,
    mode: 'cowork',
    ...(args.title === undefined ? {} : { title: args.title }),
  });
  if (!result.ok) throw new Error(`sessions:create failed: ${result.error.code}`);
  return result.value;
}

async function submit(
  harness: Harness,
  sessionId: string,
  text: string,
  submissionKey: string = KEY1,
) {
  return harness.call<SubmitTurnResult>(CHANNELS.sessionsSubmitTurn, {
    sessionId,
    submissionKey,
    text,
    kind: 'general',
  });
}

async function fetchSession(harness: Harness, sessionId: string): Promise<SessionDto> {
  const result = await harness.call<SessionDto>(CHANNELS.sessionsGet, { sessionId });
  if (!result.ok) throw new Error(`sessions:get failed: ${result.error.code}`);
  return result.value;
}

/** Waits until no turn of the session is active any more. */
async function settled(harness: Harness, sessionId: string): Promise<SessionDto> {
  await expect
    .poll(async () => (await fetchSession(harness, sessionId)).active, { timeout: 15_000 })
    .toBe(false);
  return fetchSession(harness, sessionId);
}

describe('session schemas', () => {
  const sid = `ses_${'a'.repeat(32)}`;
  const tid = `turn_${'a'.repeat(32)}`;
  const valid: Record<string, Record<string, unknown>> = {
    [CHANNELS.sessionsList]: { projectId: 'p' },
    [CHANNELS.sessionsCreate]: { projectId: 'p', mode: 'cowork' },
    [CHANNELS.sessionsGet]: { sessionId: sid },
    [CHANNELS.sessionsSubmitTurn]: {
      sessionId: sid,
      submissionKey: KEY1,
      text: 'hello',
      kind: 'general',
    },
    [CHANNELS.sessionsCancel]: { sessionId: sid, turnId: tid },
    [CHANNELS.sessionsSetMode]: { sessionId: sid, mode: 'code' },
    [CHANNELS.sessionsRename]: { sessionId: sid, title: 'Renamed' },
  };

  it.each(Object.keys(valid))('%s rejects an extra key', async (channel) => {
    const result = await h.call(channel, { ...valid[channel], extra: 1 });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.code).toBe('VALIDATION_ERROR');
  });

  it('rejects malformed fields without echoing them', async () => {
    const secret = '/etc/very-secret-location';
    const cases: [string, Record<string, unknown>][] = [
      [CHANNELS.sessionsList, { projectId: `${secret}\0` }],
      [CHANNELS.sessionsCreate, { projectId: 'p', mode: 'admin' }],
      [CHANNELS.sessionsCreate, { projectId: 'p', mode: 'cowork', title: '' }],
      [CHANNELS.sessionsCreate, { projectId: 'p', mode: 'cowork', title: 'bad\ntitle' }],
      [CHANNELS.sessionsGet, { sessionId: 'ses_short' }],
      [CHANNELS.sessionsGet, { sessionId: secret }],
      [CHANNELS.sessionsGet, { sessionId: tid }],
      [CHANNELS.sessionsSubmitTurn, { ...valid[CHANNELS.sessionsSubmitTurn], text: '' }],
      [CHANNELS.sessionsSubmitTurn, { ...valid[CHANNELS.sessionsSubmitTurn], text: 'a\0b' }],
      [CHANNELS.sessionsSubmitTurn, { ...valid[CHANNELS.sessionsSubmitTurn], submissionKey: 'x' }],
      [
        CHANNELS.sessionsSubmitTurn,
        { ...valid[CHANNELS.sessionsSubmitTurn], submissionKey: `${'a'.repeat(31)}!` },
      ],
      [CHANNELS.sessionsSubmitTurn, { ...valid[CHANNELS.sessionsSubmitTurn], kind: 'General' }],
      [CHANNELS.sessionsSubmitTurn, { ...valid[CHANNELS.sessionsSubmitTurn], maxCostUsd: -1 }],
      [
        CHANNELS.sessionsSubmitTurn,
        { ...valid[CHANNELS.sessionsSubmitTurn], text: 'x'.repeat(100_001) },
      ],
      [CHANNELS.sessionsCancel, { sessionId: sid, turnId: sid }],
      [CHANNELS.sessionsCancel, { sessionId: sid }],
      [CHANNELS.sessionsSetMode, { sessionId: sid, mode: 'other' }],
      [CHANNELS.sessionsSetMode, { sessionId: sid, mode: 'code', expectedRevision: -1 }],
      [CHANNELS.sessionsRename, { sessionId: sid, title: 'x'.repeat(201) }],
      [CHANNELS.sessionsRename, { sessionId: sid, title: 'a‮b' }],
    ];
    for (const [channel, args] of cases) {
      const result = await h.call(channel, args);
      expect(result.ok, channel).toBe(false);
      if (!result.ok) {
        expect(result.error.code, channel).toBe('VALIDATION_ERROR');
        expect(result.error.message).not.toContain(secret);
      }
    }
  });

  it('rejects unknown sessions, turns and projects', async () => {
    expect(await h.call(CHANNELS.sessionsGet, { sessionId: UNKNOWN_SESSION })).toEqual({
      ok: false,
      error: { code: 'VALIDATION_ERROR', message: 'Unknown session' },
    });
    expect((await submit(h, UNKNOWN_SESSION, 'x')).ok).toBe(false);
    expect(
      (await h.call(CHANNELS.sessionsCancel, { sessionId: UNKNOWN_SESSION, turnId: UNKNOWN_TURN }))
        .ok,
    ).toBe(false);
    for (const [channel, extra] of [
      [CHANNELS.sessionsSetMode, { mode: 'code' }],
      [CHANNELS.sessionsRename, { title: 'x' }],
    ] as const) {
      expect((await h.call(channel, { sessionId: UNKNOWN_SESSION, ...extra })).ok).toBe(false);
    }
    const session = await create(h);
    const foreign = await h.call(CHANNELS.sessionsCancel, {
      sessionId: session.id,
      turnId: UNKNOWN_TURN,
    });
    expect(foreign).toEqual({
      ok: false,
      error: { code: 'VALIDATION_ERROR', message: 'Unknown turn' },
    });
    expect(await h.call(CHANNELS.sessionsList, { projectId: 'ghost' })).toEqual({
      ok: false,
      error: { code: 'POLICY_REJECTED', message: 'Unknown project' },
    });
    expect((await h.call(CHANNELS.sessionsCreate, { projectId: 'ghost', mode: 'cowork' })).ok).toBe(
      false,
    );
  });
});

describe('sessions: create, list, get', () => {
  it('creates, lists (this project only, newest first) and gets sessions', async () => {
    const first = await create(h);
    expect(first).toMatchObject({
      projectId,
      mode: 'cowork',
      title: 'New conversation',
      turnCount: 0,
      active: false,
      turns: [],
    });
    const second = await create(h, { title: 'Quarterly plan' });
    expect(second.title).toBe('Quarterly plan');

    const other = join(dirname(h.projectDir), 'other-project');
    await mkdir(other);
    h.pick = other;
    const added = await h.call<ProjectDto | null>(CHANNELS.projectsAdd);
    const otherId = added.ok && added.value !== null ? added.value.id : '';
    const foreign = await create(h, { projectId: otherId });

    // Renaming bumps `updatedAt`, so the first session is now the most recent one.
    const renamed = await h.call<SessionDto>(CHANNELS.sessionsRename, {
      sessionId: first.id,
      title: 'Renamed',
    });
    expect(renamed.ok && renamed.value.title).toBe('Renamed');

    const listed = await h.call<SessionSummaryDto[]>(CHANNELS.sessionsList, { projectId });
    expect(listed.ok && listed.value.map((s) => s.id)).toEqual([first.id, second.id]);
    const others = await h.call<SessionSummaryDto[]>(CHANNELS.sessionsList, { projectId: otherId });
    expect(others.ok && others.value.map((s) => s.id)).toEqual([foreign.id]);

    const got = await fetchSession(h, second.id);
    expect(got.id).toBe(second.id);
    expect(got.projectId).toBe(projectId);
  });

  it('omits unreadable session files from the listing', async () => {
    const good = await create(h);
    const bad = `ses_${'f'.repeat(32)}`;
    await writeFile(join(h.userData, '.nexar', 'sessions', `${bad}.json`), '{ not json');
    const listed = await h.call<SessionSummaryDto[]>(CHANNELS.sessionsList, { projectId });
    expect(listed.ok && listed.value.map((s) => s.id)).toEqual([good.id]);
    const got = await h.call(CHANNELS.sessionsGet, { sessionId: bad });
    expect(got.ok).toBe(false);
    if (!got.ok) expect(got.error.message).not.toContain(h.userData);
  });

  it('changes mode and title with revision checks', async () => {
    const session = await create(h);
    const mode = await h.call<SessionDto>(CHANNELS.sessionsSetMode, {
      sessionId: session.id,
      mode: 'code',
      expectedRevision: session.revision,
    });
    expect(mode.ok && mode.value).toMatchObject({ mode: 'code', revision: session.revision + 1 });
    const stale = await h.call(CHANNELS.sessionsRename, {
      sessionId: session.id,
      title: 'Late',
      expectedRevision: session.revision,
    });
    expect(stale.ok).toBe(false);
    if (!stale.ok) expect(stale.error.code).toBe('CONFLICT');
    expect((await fetchSession(h, session.id)).title).toBe('New conversation');
  });
});

describe('sessions: turns', () => {
  it('runs a turn on the echo resource and stores text, task link and a project-relative draft', async () => {
    const gated = gatedEngine(h);
    const harness = gated.harness;
    try {
      const id = projectId;
      const session = await create(harness, { projectId: id });
      gated.release();
      const submitted = await submit(harness, session.id, 'say hello in a session');
      expect(submitted.ok).toBe(true);
      if (!submitted.ok) return;
      expect(submitted.value.created).toBe(true);
      expect(submitted.value.turn).toMatchObject({ index: 0, state: 'running', kind: 'general' });

      const done = await settled(harness, session.id);
      const turn = done.turns[0];
      expect(done).toMatchObject({ turnCount: 1, lastTurnState: 'succeeded', active: false });
      expect(turn?.state).toBe('succeeded');
      expect(turn?.text).toBe('say hello in a session');
      expect(turn?.outcome?.text).toContain('say hello in a session');
      expect(turn?.tasks).toHaveLength(1);
      expect(turn?.tasks[0]).toMatchObject({ state: 'succeeded', resourceId: 'local-echo' });
      const taskId = turn?.tasks[0]?.taskId ?? '';
      expect(turn?.artifacts).toEqual([
        {
          taskId,
          path: `.nexar/artifacts/${taskId}/drafts/result.md`,
          name: 'result.md',
          mediaType: 'text/markdown',
          sizeBytes: expect.any(Number) as number,
          draft: true,
        },
      ]);
      expect(await readFile(join(harness.projectDir, turn?.artifacts[0]?.path ?? ''), 'utf8')).toBe(
        turn?.outcome?.text,
      );

      // Lineage is set by Nexar on the task, with the turn as correlation id.
      expect(gated.tasks).toHaveLength(1);
      expect(gated.tasks[0]?.origin).toEqual({
        source: 'desktop',
        project: id,
        correlationId: turn?.id,
        sessionId: session.id,
        turnId: turn?.id,
      });
      expect(gated.tasks[0]?.input.prompt).toBe('say hello in a session');

      // Events carry ids and short status lines only.
      const kinds = new Set(harness.sessionEvents.map((e) => e.type));
      expect(kinds.has('turn')).toBe(true);
      expect(kinds.has('status')).toBe(true);
      for (const event of harness.sessionEvents) {
        expect(
          Object.keys(event).every((k) => ['sessionId', 'turnId', 'type', 'message'].includes(k)),
        ).toBe(true);
        expect(event.sessionId).toBe(session.id);
        expect(event.turnId).toBe(turn?.id);
        if (event.type === 'turn') expect(event.message).toBeUndefined();
      }
      expect(harness.events).toEqual([]);

      // A second turn sees the same session; both stay in order.
      const next = await submit(harness, session.id, 'and again', KEY2);
      expect(next.ok && next.value.turn.index).toBe(1);
      const both = await settled(harness, session.id);
      expect(both.turns.map((t) => t.text)).toEqual(['say hello in a session', 'and again']);
      expect(both.turns.every((t) => t.state === 'succeeded')).toBe(true);
    } finally {
      gated.release();
    }
  });

  it('returns the existing turn for a repeated key and starts exactly one task', async () => {
    const gated = gatedEngine(h);
    const harness = gated.harness;
    try {
      const id = projectId;
      const session = await create(harness, { projectId: id });
      const first = await submit(harness, session.id, 'only once');
      const again = await submit(harness, session.id, 'only once');
      expect(first.ok && again.ok).toBe(true);
      if (!first.ok || !again.ok) return;
      expect(first.value.created).toBe(true);
      expect(again.value.created).toBe(false);
      expect(again.value.turn.id).toBe(first.value.turn.id);

      const reused = await submit(harness, session.id, 'different text');
      expect(reused.ok).toBe(false);
      if (!reused.ok) expect(reused.error.code).toBe('VALIDATION_ERROR');

      gated.release();
      const done = await settled(harness, session.id);
      expect(done.turns).toHaveLength(1);
      const replay = await submit(harness, session.id, 'only once');
      expect(replay.ok && replay.value.created).toBe(false);
      expect(gated.tasks).toHaveLength(1);
      expect(await readdir(join(harness.projectDir, '.nexar', 'artifacts'))).toHaveLength(1);
    } finally {
      gated.release();
    }
  });

  it('rejects a second turn while one is running', async () => {
    const gated = gatedEngine(h);
    const harness = gated.harness;
    try {
      const id = projectId;
      const session = await create(harness, { projectId: id });
      expect((await submit(harness, session.id, 'first')).ok).toBe(true);
      const busy = await submit(harness, session.id, 'second', KEY2);
      expect(busy.ok).toBe(false);
      if (!busy.ok) expect(busy.error.code).toBe('CONFLICT');
      expect((await fetchSession(harness, session.id)).active).toBe(true);

      // A different session of the same project is not blocked.
      const other = await create(harness, { projectId: id });
      expect((await submit(harness, other.id, 'parallel', KEY2)).ok).toBe(true);
      gated.release();
      await settled(harness, session.id);
      await settled(harness, other.id);
    } finally {
      gated.release();
    }
  });

  it('cancels a running turn, keeps its history and frees the session', async () => {
    const gated = gatedEngine(h);
    const harness = gated.harness;
    try {
      const id = projectId;
      const session = await create(harness, { projectId: id });
      const started = await submit(harness, session.id, 'slow job');
      const turnId = started.ok ? started.value.turn.id : '';
      await expect
        .poll(async () => (await fetchSession(harness, session.id)).turns[0]?.tasks.length, {
          timeout: 15_000,
        })
        .toBe(1);

      expect(
        await harness.call(CHANNELS.sessionsCancel, { sessionId: session.id, turnId }),
      ).toEqual({ ok: true, value: { cancelled: true } });
      const done = await settled(harness, session.id);
      expect(done.turns[0]).toMatchObject({
        state: 'cancelled',
        text: 'slow job',
        tasks: [{ state: 'cancelled' }],
      });
      expect(done.lastTurnState).toBe('cancelled');
      // Nothing left to cancel, and the session accepts a new turn.
      expect(
        await harness.call(CHANNELS.sessionsCancel, { sessionId: session.id, turnId }),
      ).toEqual({ ok: true, value: { cancelled: false } });
      gated.release();
      expect((await submit(harness, session.id, 'next', KEY2)).ok).toBe(true);
      const after = await settled(harness, session.id);
      expect(after.turns.map((t) => t.state)).toEqual(['cancelled', 'succeeded']);
    } finally {
      gated.release();
    }
  });

  it('records an engine refusal as a failed turn with a safe error', async () => {
    await h.config.update((raw) => {
      const projects = raw['projects'] as { defaults?: unknown }[];
      projects[0]!.defaults = { excludedResourceIds: ['local-echo'] };
    });
    await h.engine.reload();
    const session = await create(h);
    expect((await submit(h, session.id, 'nobody can run this')).ok).toBe(true);
    const done = await settled(h, session.id);
    const turn = done.turns[0];
    expect(turn?.state).toBe('failed');
    expect(turn?.outcome?.error?.code).toBe('NO_ELIGIBLE_RESOURCE');
    expect(turn?.outcome?.text).toBeUndefined();
    expect(JSON.stringify(done)).not.toContain(h.userData);
    expect(turn?.tasks).toMatchObject([{ state: 'failed' }]);
    expect(done.lastTurnState).toBe('failed');
  });

  it('never exposes paths, file URIs or stacks in DTOs or events', async () => {
    const session = await create(h);
    await submit(h, session.id, 'check the wire format');
    const done = await settled(h, session.id);
    const wire = JSON.stringify([done, h.sessionEvents]);
    expect(wire).not.toContain(h.projectDir);
    expect(wire).not.toContain(h.userData);
    expect(wire).not.toContain('file:');
    expect(wire).not.toMatch(/\n\s+at /);
    expect(wire).not.toMatch(/[A-Za-z]:\\\\/);
  });

  it('refuses to list turns or submit once the session project is gone', async () => {
    const session = await create(h);
    expect((await h.call(CHANNELS.projectsRemove, { id: projectId })).ok).toBe(true);
    for (const result of [
      await h.call(CHANNELS.sessionsGet, { sessionId: session.id }),
      await submit(h, session.id, 'orphaned'),
      await h.call(CHANNELS.sessionsRename, { sessionId: session.id, title: 'x' }),
    ]) {
      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.error.code).toBe('VALIDATION_ERROR');
        expect(result.error.message).not.toContain(h.projectDir);
      }
    }
    expect((await h.sessionStore.get(session.id))?.turns).toEqual([]);
  });
});

describe('sessions: restart and availability', () => {
  it('marks a running turn interrupted when a new process takes the lease, and frees the session', async () => {
    const session = await create(h);
    // A turn that was running when the previous process died (nothing is replayed).
    await h.sessionStore.beginTurn(session.id, {
      submissionKey: KEY1,
      text: 'in flight',
      state: 'running',
      intent: { kind: 'general', source: 'explicit', ruleIds: [], policy: 'desktop-explicit@1' },
    });
    await h.sessionStore.linkTask(
      session.id,
      (await h.sessionStore.get(session.id))!.turns[0]!.id,
      {
        taskId: 'task-in-flight',
        state: 'running',
      },
    );

    const restarted = new FileSessionStore(join(h.userData, '.nexar', 'sessions'), {
      instanceId: 'restarted-instance',
      pid: process.pid + 100_000,
      isProcessAlive: () => false,
    });
    expect((await restarted.acquireLease()).interruptedTurns).toBe(1);
    const bridge = createBridge({ ...h.deps, sessions: restarted });
    const read = await bridge.invoke(
      CHANNELS.sessionsGet,
      { sessionId: session.id },
      () => undefined,
    );
    expect(read.ok).toBe(true);
    const dto = read.ok ? (read.value as SessionDto) : undefined;
    expect(dto).toMatchObject({ active: false, lastTurnState: 'interrupted' });
    expect(dto?.turns[0]).toMatchObject({
      state: 'interrupted',
      text: 'in flight',
      tasks: [{ taskId: 'task-in-flight', state: 'interrupted' }],
    });

    const next = await bridge.invoke(
      CHANNELS.sessionsSubmitTurn,
      { sessionId: session.id, submissionKey: KEY2, text: 'after restart', kind: 'general' },
      () => undefined,
    );
    expect(next.ok).toBe(true);
    // Let the background turn finish before the directory is removed.
    await expect
      .poll(async () => (await restarted.get(session.id))?.activeTurnId, { timeout: 15_000 })
      .toBeNull();
    await restarted.releaseLease();
  });

  it('answers CONFLICT on every session channel when the lease is held elsewhere', async () => {
    const unavailable = await createHarness({ sessions: undefined });
    try {
      const id = await addProject(unavailable);
      const sid = `ses_${'a'.repeat(32)}`;
      const calls: [string, Record<string, unknown>][] = [
        [CHANNELS.sessionsList, { projectId: id }],
        [CHANNELS.sessionsCreate, { projectId: id, mode: 'cowork' }],
        [CHANNELS.sessionsGet, { sessionId: sid }],
        [
          CHANNELS.sessionsSubmitTurn,
          { sessionId: sid, submissionKey: KEY1, text: 'x', kind: 'general' },
        ],
        [CHANNELS.sessionsCancel, { sessionId: sid, turnId: UNKNOWN_TURN }],
        [CHANNELS.sessionsSetMode, { sessionId: sid, mode: 'code' }],
        [CHANNELS.sessionsRename, { sessionId: sid, title: 'x' }],
      ];
      for (const [channel, args] of calls) {
        expect(await unavailable.call(channel, args), channel).toEqual({
          ok: false,
          error: { code: 'CONFLICT', message: 'Sessions are open in another Nexar process' },
        });
      }
    } finally {
      await unavailable.cleanup();
    }
  });

  it('keeps the lease conflict real: a second live store cannot write', async () => {
    const intruder = new FileSessionStore(join(h.userData, '.nexar', 'sessions'), {
      instanceId: 'intruder',
      pid: process.pid + 200_000,
      isProcessAlive: () => true,
    });
    await expect(intruder.acquireLease()).rejects.toMatchObject({ code: 'CONFLICT' });
    const bridge = createBridge({ ...h.deps, sessions: undefined });
    const result = await bridge.invoke(CHANNELS.sessionsList, { projectId }, () => undefined);
    expect(result.ok).toBe(false);
  });
});
