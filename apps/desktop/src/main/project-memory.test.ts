import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { ProjectMemoryDto } from '../shared/api.js';
import { ProjectMemoryAddSchema, ProjectMemoryRemoveSchema } from './project-memory.js';
import { addProject, createHarness, type Harness } from './test-harness.js';

let h: Harness;
let projectId: string;

beforeEach(async () => {
  h = await createHarness();
  projectId = await addProject(h);
});

afterEach(async () => {
  await h.cleanup();
});

const entryId = `mem_${'a'.repeat(32)}`;

describe('projectMemory schemas', () => {
  const valid = { projectId: 'proj-1', kind: 'constraint', text: 'never push' };

  it('accepts a valid add', () => {
    expect(ProjectMemoryAddSchema.safeParse(valid).success).toBe(true);
    expect(
      ProjectMemoryAddSchema.safeParse({
        ...valid,
        sessionId: `ses_${'a'.repeat(32)}`,
        turnId: `turn_${'b'.repeat(32)}`,
      }).success,
    ).toBe(true);
  });

  it.each([
    ['bad kind', { ...valid, kind: 'secret' }],
    ['empty text', { ...valid, text: '' }],
    ['oversized text', { ...valid, text: 'x'.repeat(1001) }],
    ['control characters', { ...valid, text: 'a\u0000b' }],
    ['extra key', { ...valid, source: 'model' }],
    ['bad project id', { ...valid, projectId: '../x' }],
    ['bad session id', { ...valid, sessionId: 'nope' }],
  ])('rejects an add with %s', (_name, args) => {
    expect(ProjectMemoryAddSchema.safeParse(args).success).toBe(false);
  });

  it('validates removal ids and rejects extra keys', () => {
    expect(ProjectMemoryRemoveSchema.safeParse({ projectId: 'p', entryId }).success).toBe(true);
    expect(ProjectMemoryRemoveSchema.safeParse({ projectId: 'p', entryId: 'mem_x' }).success).toBe(
      false,
    );
    expect(ProjectMemoryRemoveSchema.safeParse({ projectId: 'p', entryId, extra: 1 }).success).toBe(
      false,
    );
  });
});

describe('projectMemory channels', () => {
  it('adds, lists and removes entries as DTOs with ids, kind, text and time only', async () => {
    const added = await h.call<ProjectMemoryDto>('projectMemory:add', {
      projectId,
      kind: 'decision',
      text: 'use pnpm',
    });
    expect(added.ok).toBe(true);
    const dto = added.ok ? added.value : undefined;
    expect(Object.keys(dto ?? {}).sort()).toEqual(['createdAt', 'id', 'kind', 'text']);
    expect(dto).toMatchObject({ kind: 'decision', text: 'use pnpm' });

    const listed = await h.call<ProjectMemoryDto[]>('projectMemory:list', { projectId });
    expect(listed).toEqual({ ok: true, value: [dto] });
    expect(JSON.stringify(listed)).not.toContain(h.userData);

    const removed = await h.call('projectMemory:remove', { projectId, entryId: dto?.id });
    expect(removed).toEqual({ ok: true, value: { removed: true } });
    expect(await h.call('projectMemory:list', { projectId })).toEqual({ ok: true, value: [] });
  });

  it('rejects an unknown project on every channel', async () => {
    for (const [channel, args] of [
      ['projectMemory:list', { projectId: 'nope' }],
      ['projectMemory:add', { projectId: 'nope', kind: 'constraint', text: 'x' }],
      ['projectMemory:remove', { projectId: 'nope', entryId }],
    ] as const) {
      const result = await h.call(channel, args);
      expect(result.ok).toBe(false);
    }
  });

  it('rejects bad kinds, oversized text and extra keys through the bridge', async () => {
    for (const args of [
      { projectId, kind: 'secret', text: 'x' },
      { projectId, kind: 'constraint', text: 'x'.repeat(1001) },
      { projectId, kind: 'constraint', text: 'x', extra: true },
    ]) {
      const result = await h.call('projectMemory:add', args);
      expect(result).toMatchObject({ ok: false, error: { code: 'VALIDATION_ERROR' } });
    }
    expect(await h.call('projectMemory:list', { projectId })).toEqual({ ok: true, value: [] });
  });

  it('refuses an add that would exceed the required-context budget with a fixed message', async () => {
    for (let i = 0; i < 15; i += 1) {
      const added = await h.call('projectMemory:add', {
        projectId,
        kind: 'constraint',
        text: String(i).padEnd(1000, 'x'),
      });
      expect(added.ok).toBe(true);
    }
    const result = await h.call('projectMemory:add', {
      projectId,
      kind: 'constraint',
      text: 'y'.repeat(1000),
    });
    expect(result).toEqual({
      ok: false,
      error: { code: 'POLICY_REJECTED', message: 'Project memory is full; remove an entry first' },
    });
    const listed = await h.call<ProjectMemoryDto[]>('projectMemory:list', { projectId });
    expect(listed.ok && listed.value.length).toBe(15);
  });

  it('feeds the turn pipeline: an added entry reaches the next turn and its manifest', async () => {
    const session = await h.call<{ id: string }>('sessions:create', { projectId, mode: 'cowork' });
    if (!session.ok) throw new Error('create failed');
    await h.call('projectMemory:add', { projectId, kind: 'constraint', text: 'drafts only' });
    const submitted = await h.call('sessions:submitTurn', {
      sessionId: session.value.id,
      submissionKey: 'submission-key-memory-1',
      text: 'hello there',
    });
    expect(submitted.ok).toBe(true);
    const stored = await waitForTurn(h, session.value.id);
    expect(stored?.context?.policy).toBe('context@2');
    expect(stored?.context?.requiredIds).toHaveLength(1);
  });

  it('answers CONFLICT when this process is not the writer, but still lists', async () => {
    const readOnly = await createHarness({ sessions: undefined });
    try {
      const id = await addProject(readOnly);
      expect(await readOnly.call('projectMemory:list', { projectId: id })).toEqual({
        ok: true,
        value: [],
      });
      const result = await readOnly.call('projectMemory:add', {
        projectId: id,
        kind: 'constraint',
        text: 'x',
      });
      expect(result).toMatchObject({ ok: false, error: { code: 'CONFLICT' } });
    } finally {
      await readOnly.cleanup();
    }
  });

  it('answers CONFLICT when no store is wired', async () => {
    const bare = await createHarness({ projectMemory: undefined });
    try {
      const id = await addProject(bare);
      const result = await bare.call('projectMemory:list', { projectId: id });
      expect(result).toMatchObject({ ok: false, error: { code: 'CONFLICT' } });
    } finally {
      await bare.cleanup();
    }
  });
});

async function waitForTurn(harness: Harness, sessionId: string) {
  for (let i = 0; i < 200; i += 1) {
    const session = await harness.sessionStore.get(sessionId);
    const turn = session?.turns[0];
    if (turn !== undefined && turn.state !== 'running' && turn.context !== undefined) return turn;
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  throw new Error('turn did not finish');
}
