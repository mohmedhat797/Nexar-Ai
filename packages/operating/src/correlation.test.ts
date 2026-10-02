import { NexarError } from '@nexar/contracts';
import { describe, expect, it } from 'vitest';
import { MAX_DELEGATION_DEPTH, childTask, delegate, rootCorrelation } from './correlation.js';

const SESSION = `ses_${'a'.repeat(32)}`;
const TURN = `turn_${'b'.repeat(32)}`;

function recursionError(fn: () => unknown): NexarError {
  try {
    fn();
  } catch (error) {
    expect(error).toBeInstanceOf(NexarError);
    return error as NexarError;
  }
  throw new Error('expected a rejection');
}

function expectRecursion(fn: () => unknown): void {
  const error = recursionError(fn);
  expect(error.code).toBe('POLICY_REJECTED');
  expect(error.details).toEqual({ reason: 'recursion' });
}

describe('recursion guard', () => {
  it('mints a root correlation', () => {
    expect(rootCorrelation(SESSION, TURN)).toEqual({
      rootSessionId: SESSION,
      turnId: TURN,
      rootOrchestrator: 'nexar',
      chain: ['nexar'],
      currentOrchestrator: 'nexar',
      depth: 0,
      correlationId: TURN,
    });
    expect(MAX_DELEGATION_DEPTH).toBe(2);
  });

  it('validates ids', () => {
    expect(() => rootCorrelation('nope', TURN)).toThrow(NexarError);
    expect(() => rootCorrelation(SESSION, 'nope')).toThrow(NexarError);
  });

  it('allows nexar -> openworker and does not mutate the parent', () => {
    const root = rootCorrelation(SESSION, TURN);
    const ow = delegate(root, 'openworker');
    expect(ow).toMatchObject({
      chain: ['nexar', 'openworker'],
      currentOrchestrator: 'openworker',
      depth: 1,
      correlationId: TURN,
      rootSessionId: SESSION,
    });
    expect(root.chain).toEqual(['nexar']);
    expect(root.depth).toBe(0);
  });

  it('allows nexar -> openworker -> nexar service child and it creates no turn', () => {
    const ow = delegate(rootCorrelation(SESSION, TURN), 'openworker');
    const child = childTask(ow);
    expect(child).toMatchObject({
      kind: 'service',
      depth: 2,
      chain: ['nexar', 'openworker'],
      currentOrchestrator: 'openworker',
      turnId: TURN,
      rootSessionId: SESSION,
      correlationId: TURN,
    });
  });

  it('rejects re-entering an orchestrator already in the chain', () => {
    const ow = delegate(rootCorrelation(SESSION, TURN), 'openworker');
    expectRecursion(() => delegate(ow, 'openworker'));
    expectRecursion(() => delegate(ow, 'nexar'));
    expectRecursion(() => delegate(rootCorrelation(SESSION, TURN), 'nexar'));
  });

  it('rejects anything deeper than depth 2', () => {
    const root = rootCorrelation(SESSION, TURN);
    const second = delegate(delegate(root, 'openworker'), 'dsh');
    expect(second.depth).toBe(2);
    expectRecursion(() => childTask(second));
    expectRecursion(() => childTask(childTask(delegate(root, 'openworker'))));
  });

  it('never lets a service child start an orchestrated lane', () => {
    const child = childTask(delegate(rootCorrelation(SESSION, TURN), 'openworker'));
    expectRecursion(() => delegate(child, 'dsh'));
  });

  it('carries only constant details', () => {
    const error = recursionError(() => delegate(rootCorrelation(SESSION, TURN), 'nexar'));
    expect(JSON.stringify(error.toJSON())).not.toContain(SESSION);
    expect(JSON.stringify(error.toJSON())).not.toContain(TURN);
  });
});
