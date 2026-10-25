import { EventEmitter, once } from 'node:events';
import { spawn, type ChildProcess } from 'node:child_process';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { finishProcess, waitForMainProcessExit } from '../apps/desktop/e2e/process-lifecycle.js';

function processFixture() {
  const child = Object.assign(new EventEmitter(), {
    exitCode: null as number | null,
    signalCode: null,
  });
  return {
    child: child as unknown as ChildProcess,
    exit: () => {
      child.exitCode = 0;
      child.emit('exit', 0, null);
    },
  };
}

afterEach(() => vi.useRealTimers());

describe('Desktop E2E process ownership', () => {
  it('terminates and observes an owned real child before permitting cleanup', async () => {
    const child = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], {
      stdio: 'ignore',
      windowsHide: true,
    });
    try {
      await once(child, 'spawn');
      expect(
        await finishProcess(child, () => new Promise(() => undefined), {
          graceMs: 0,
          killMs: 5_000,
        }),
      ).toEqual({ forced: true });
      expect(child.exitCode !== null || child.signalCode !== null).toBe(true);
    } finally {
      if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL');
    }
  });

  it('waits for actual exit even when the protocol close resolved', async () => {
    vi.useFakeTimers();
    const fixture = processFixture(),
      terminate = vi.fn(() => Promise.resolve());
    let done = false;
    const result = finishProcess(fixture.child, () => Promise.resolve(), {
      graceMs: 10,
      killMs: 5,
      terminate,
    }).then((r) => {
      done = true;
      return r;
    });
    await vi.advanceTimersByTimeAsync(10);
    expect(terminate).toHaveBeenCalledOnce();
    expect(done).toBe(false);
    fixture.exit();
    expect(await result).toEqual({ forced: true });
    expect(vi.getTimerCount()).toBe(0);
  });

  it('observes exit when protocol close never resolves and clears the deadline', async () => {
    vi.useFakeTimers();
    const fixture = processFixture(),
      terminate = vi.fn(() => Promise.resolve());
    const result = finishProcess(fixture.child, () => new Promise(() => undefined), {
      graceMs: 10,
      terminate,
    });
    fixture.exit();
    expect(await result).toEqual({ forced: false });
    expect(terminate).not.toHaveBeenCalled();
    expect(vi.getTimerCount()).toBe(0);
  });

  it('refuses profile cleanup when forced termination does not produce exit', async () => {
    vi.useFakeTimers();
    const fixture = processFixture(),
      terminate = vi.fn(() => Promise.resolve());
    const result = finishProcess(
      fixture.child,
      () => Promise.reject(new Error('closed protocol')),
      { graceMs: 10, killMs: 5, terminate },
    ).catch((e: unknown) => e);
    await vi.advanceTimersByTimeAsync(15);
    expect(await result).toMatchObject({ message: 'E2E process did not exit; profile retained' });
    expect(fixture.child.listenerCount('exit')).toBe(0);
    expect(vi.getTimerCount()).toBe(0);
  });

  it('does not relaunch closure or kill an already exited owned process', async () => {
    const fixture = processFixture(),
      close = vi.fn(() => Promise.resolve()),
      terminate = vi.fn(() => Promise.resolve());
    fixture.exit();
    expect(await finishProcess(fixture.child, close, { terminate })).toEqual({ forced: false });
    expect(close).not.toHaveBeenCalled();
    expect(terminate).not.toHaveBeenCalled();
  });

  it('verifies the real main process after a Windows launcher has already exited', async () => {
    const fixture = processFixture();
    fixture.exit();
    const close = vi.fn(() => Promise.resolve());
    const verifyExit = vi.fn(() => Promise.resolve());
    expect(await finishProcess(fixture.child, close, { verifyExit })).toEqual({ forced: false });
    expect(close).toHaveBeenCalledOnce();
    expect(verifyExit).toHaveBeenCalledOnce();
  });

  it('refuses cleanup when the launcher exited but main-process exit is unverified', async () => {
    const fixture = processFixture();
    fixture.exit();
    const verifyExit = () =>
      Promise.reject(new Error('Main process still present; profile retained'));
    await expect(
      finishProcess(fixture.child, () => Promise.resolve(), { verifyExit }),
    ).rejects.toThrow('Main process still present; profile retained');
  });

  it('waits for main PID absence without sending a termination signal', async () => {
    vi.useFakeTimers();
    const probe = vi.spyOn(process, 'kill').mockReturnValue(true);
    let settled = false;
    const waiting = waitForMainProcessExit({ pid: 456, createdAtEpochMs: 1234 }).then(() => {
      settled = true;
    });
    await vi.advanceTimersByTimeAsync(25);
    expect(settled).toBe(false);
    probe.mockImplementation(() => {
      throw Object.assign(new Error('Synthetic missing process'), { code: 'ESRCH' });
    });
    await vi.advanceTimersByTimeAsync(25);
    await waiting;
    expect(probe.mock.calls.every((args) => args[0] === 456 && args[1] === 0)).toBe(true);
    expect(vi.getTimerCount()).toBe(0);
    probe.mockRestore();
  });

  it('fails closed for a live or reused main PID and for an unqueryable PID', async () => {
    vi.useFakeTimers();
    const probe = vi.spyOn(process, 'kill').mockReturnValue(true);
    const waiting = waitForMainProcessExit({ pid: 456 }).catch((error: unknown) => error);
    await vi.advanceTimersByTimeAsync(5_000);
    expect(await waiting).toMatchObject({
      message: 'E2E main process remains present; profile retained',
    });
    probe.mockImplementation(() => {
      throw Object.assign(new Error('Synthetic denied probe'), { code: 'EPERM' });
    });
    await expect(waitForMainProcessExit({ pid: 456 })).rejects.toThrow('could not be verified');
    await expect(waitForMainProcessExit({ pid: 0 })).rejects.toThrow('identity unavailable');
    expect(vi.getTimerCount()).toBe(0);
    probe.mockRestore();
  });
});
