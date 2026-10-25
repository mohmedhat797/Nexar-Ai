import { describe, expect, it } from 'vitest';
import {
  runWindowsStateProcess,
  STATE_GUARD_PHASE,
  STATE_GUARD_READY,
  WindowsStateProcessError,
  type WindowsStateProcessEvent,
  type WindowsStateProcessHooks,
  type WindowsStateProcessResult,
  type WindowsStateToolOptions,
} from './private-state-process.js';

const SECRET = 'synthetic-private-value-that-must-not-be-logged';
const options: WindowsStateToolOptions = {
  env: { SystemRoot: 'C:\\Windows', NEXAR_PRIVATE_STATE_PATH: `C:\\${SECRET}` },
  windowsHide: true,
  shell: false,
  timeout: 15_000,
  maxBuffer: 16 * 1024,
};
const at = '2026-10-25T01:00:00.000Z';
const phase = (name: string, pid = 42): string =>
  `${STATE_GUARD_PHASE}|${name}|${pid}|${at}|${at}|${at}|12`;

function observe(spawn: NonNullable<WindowsStateProcessHooks['spawn']>): {
  readonly events: WindowsStateProcessEvent[];
  readonly result: WindowsStateProcessResult;
  readonly error: unknown;
} {
  const events: WindowsStateProcessEvent[] = [];
  let error: unknown;
  try {
    runWindowsStateProcess(`C:\\${SECRET}.exe`, ['-EncodedCommand', SECRET], options, {
      spawn,
      onEvent: (event) => events.push(event),
    });
  } catch (caught) {
    error = caught;
  }
  const result = events.find((event) => event.event === 'result');
  expect(result?.event).toBe('result');
  return { events, result: result as WindowsStateProcessResult, error };
}

describe('synchronous private-state process observation', () => {
  it('retains native parent/child identity and does not yield before completion', () => {
    const events: WindowsStateProcessEvent[] = [];
    const order: string[] = [];
    const clock = [10, 24];
    runWindowsStateProcess('absolute-powershell', ['fixed-script'], options, {
      monotonicNow: () => clock.shift()!,
      wallNow: () => new Date(at),
      onEvent: (event) => {
        events.push(event);
        order.push(event.event);
      },
      spawn: (command, args, received) => {
        order.push('native');
        expect(command).toBe('absolute-powershell');
        expect(args).toEqual(['fixed-script']);
        expect(received).toBe(options);
        expect(events).toHaveLength(1);
        return {
          pid: 42,
          status: 0,
          stdout: Buffer.from(`${STATE_GUARD_READY}\n${phase('ready')}`),
        };
      },
    });
    order.push('returned');
    expect(order).toEqual(['request', 'native', 'result', 'returned']);
    const [request, result] = events;
    expect(request?.parentPid).toBe(process.pid);
    expect(result).toMatchObject({
      event: 'result',
      childPid: 42,
      childCreated: true,
      readinessCaptured: true,
      timeoutMs: 15000,
      elapsedMs: 14,
      termination: 'exited',
      exitCode: 0,
      observation: 'synchronous-buffered',
    });
    expect(result?.correlationId).toBe(request?.correlationId);
    expect(result?.attemptId).toBe(request?.attemptId);
    expect(result?.correlationId).toMatch(/^[0-9a-f-]{36}$/);
    if (result?.event !== 'result') throw new Error('Missing observation');
    expect(result.scriptPhases).toHaveLength(1);
    expect(result.unavailableTimings).toContain('first-parent-output-callback');
    expect(result.unavailableTimings).toContain('live-spawn-confirmation');
  });

  it('uses monotonic duration when wall time moves backwards', () => {
    const events: WindowsStateProcessEvent[] = [];
    const ticks = [100, 15125];
    const dates = [new Date(at), new Date('2026-10-24T23:00:00.000Z')];
    expect(() =>
      runWindowsStateProcess('fixed', [], options, {
        monotonicNow: () => ticks.shift()!,
        wallNow: () => dates.shift()!,
        onEvent: (event) => events.push(event),
        spawn: () => ({ pid: 42, status: null, error: { code: 'ETIMEDOUT' } }),
      }),
    ).toThrow(WindowsStateProcessError);
    expect(events.at(-1)).toMatchObject({ elapsedMs: 15025, termination: 'timeout' });
  });

  it.each([false, true])(
    'retains timeout PID with readiness=%s without native output or arguments',
    (ready) => {
      const observed = observe(() => ({
        pid: 42,
        status: null,
        signal: 'SIGTERM',
        error: { code: 'ETIMEDOUT', message: SECRET, spawnargs: [SECRET] },
        stdout: Buffer.from(`${ready ? STATE_GUARD_READY : ''}\n${SECRET}`),
      }));
      expect(observed.error).toBeInstanceOf(WindowsStateProcessError);
      expect(observed.result).toMatchObject({
        childPid: 42,
        childCreated: true,
        readinessCaptured: ready,
        termination: 'timeout',
        signal: 'SIGTERM',
        timeoutMs: 15000,
      });
      expect(JSON.stringify(observed.events)).not.toContain(SECRET);
      expect(JSON.stringify(observed.error)).not.toContain(SECRET);
      expect(observed.error).not.toHaveProperty('stdout');
      expect(observed.error).not.toHaveProperty('cause');
    },
  );

  it('distinguishes a process creation failure from an existing timed-out child', () => {
    const observed = observe(() => ({
      pid: 0,
      status: null,
      error: { code: 'ENOENT', path: SECRET },
    }));
    expect(observed.error).toMatchObject({ nativeCode: 'ENOENT' });
    expect(observed.result).toMatchObject({ childCreated: false, termination: 'spawn-failed' });
    expect(observed.result).not.toHaveProperty('childPid');
    expect(observed.result.nativeReturnedAtUtc).toMatch(/^\d{4}-/);
    expect(observed.result).not.toHaveProperty('exitObservedAtUtc');
    expect(observed.result).not.toHaveProperty('outputCapturedAtUtc');
    expect(JSON.stringify(observed)).not.toContain(SECRET);
  });

  it('rejects a child exiting nonzero before readiness without retrying', () => {
    let calls = 0;
    const observed = observe(() => {
      calls += 1;
      return { pid: 42, status: 7, stdout: '' };
    });
    expect(calls).toBe(1);
    expect(observed.error).toBeInstanceOf(WindowsStateProcessError);
    expect(observed.result).toMatchObject({
      exitCode: 7,
      readinessCaptured: false,
      termination: 'exited',
    });
  });

  it('preserves exit-zero authority while explicitly reporting absent readiness evidence', () => {
    const observed = observe(() => ({ pid: 42, status: 0, stdout: '' }));
    expect(observed.error).toBeUndefined();
    expect(observed.result).toMatchObject({
      exitCode: 0,
      readinessCaptured: false,
      outputCaptured: false,
    });
    expect(observed.result.scriptPhases).toEqual([]);
  });

  it('does not accept output-buffer failure or a termination signal as success', () => {
    for (const native of [
      {
        pid: 42,
        status: 0,
        error: { code: 'ENOBUFS', message: SECRET },
        stdout: STATE_GUARD_READY,
      },
      { pid: 42, status: null, signal: 'SIGTERM', stdout: STATE_GUARD_READY },
    ]) {
      const observed = observe(() => native);
      expect(observed.error).toBeInstanceOf(WindowsStateProcessError);
      expect(JSON.stringify(observed)).not.toContain(SECRET);
    }
  });

  it('parses only bounded fixed phases with the actual native PID and valid timestamps', () => {
    const observed = observe(() => ({
      pid: 42,
      status: 0,
      stdout: [
        STATE_GUARD_READY,
        SECRET,
        phase('ready'),
        phase('ready'),
        phase('tree-checked', 99),
        phase('credential-secret'),
        phase('acl-verified').replace(at, SECRET),
        phase('complete'),
        `${phase('ready')}|${SECRET}`,
      ].join('\n'),
    }));
    expect(observed.result.scriptPhases.map((item) => item.phase)).toEqual(['ready', 'complete']);
    expect(observed.result.scriptPhases.every((item) => item.childPid === 42)).toBe(true);
    expect(JSON.stringify(observed)).not.toContain(SECRET);
    expect(JSON.stringify(observed)).not.toContain('credential-secret');
  });

  it('fails closed on a thrown native invocation error and omits its message', () => {
    const observed = observe(() => {
      throw Object.assign(new Error(SECRET), { code: 'ENOENT' });
    });
    expect(observed.error).toBeInstanceOf(WindowsStateProcessError);
    expect(observed.result).toMatchObject({ childCreated: false, termination: 'spawn-failed' });
    expect(JSON.stringify(observed)).not.toContain(SECRET);
  });

  it('does not convert an unclassified native result into success', () => {
    const observed = observe(() => ({ status: null }));
    expect(observed.error).toBeInstanceOf(WindowsStateProcessError);
    expect(observed.result).toMatchObject({ childCreated: false, termination: 'invalid-result' });
  });
});
