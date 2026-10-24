import { EventEmitter } from 'node:events';
import { access, readFile, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  createHarness,
  stateProcessObservation,
  type Harness,
} from '../apps/desktop/e2e/harness.js';
import { STATE_GUARD_TRACE_EVENT } from '../apps/desktop/src/main/private-state-process.js';

const launches: unknown[] = [];
type Application = Awaited<ReturnType<NonNullable<Parameters<typeof createHarness>[1]>>>;
const launchApplication: NonNullable<Parameters<typeof createHarness>[1]> = () =>
  Promise.resolve(launches.shift() as Application);

function fakeApp() {
  const child = Object.assign(new EventEmitter(), {
    pid: 123,
    exitCode: null as number | null,
    signalCode: null,
    stdout: new EventEmitter(),
    stderr: new EventEmitter(),
  });
  return {
    child,
    app: {
      process: () => child,
      firstWindow: () => Promise.resolve({ waitForSelector: () => Promise.resolve(undefined) }),
      close: vi.fn(() => {
        child.exitCode = 0;
        child.emit('exit', 0, null);
        return Promise.resolve();
      }),
    },
  };
}

const fixtures: Harness[] = [];
afterEach(async () => {
  for (const harness of fixtures.splice(0)) {
    await harness.dispose();
    await rm(harness.base, { recursive: true, force: true });
  }
  launches.length = 0;
  vi.restoreAllMocks();
});

describe('Desktop E2E fixture diagnostics and cleanup', () => {
  it('attributes Windows startup to the Electron main child rather than its shell launcher', async () => {
    const { app } = fakeApp();
    const observations = [
      { event: 'request', parentPid: 456 },
      { event: 'result', parentPid: 456, childPid: 789 },
    ];
    const inspected = Object.assign(app, {
      evaluate: (_expression: unknown, eventName?: unknown) =>
        Promise.resolve(
          eventName === STATE_GUARD_TRACE_EVENT
            ? observations
            : {
                pid: 456,
                parentPid: 123,
                createdAtEpochMs: 1792860000000,
                nodeVersion: '24.21.0',
                electronVersion: '44.5.1',
              },
        ),
    });
    await expect(stateProcessObservation(inspected as unknown as Application)).resolves.toEqual(
      observations,
    );
  });

  it('removes a successful fixture only after its owned application exits', async () => {
    const harness = await createHarness(() => undefined, launchApplication);
    fixtures.push(harness);
    const { app, child } = fakeApp();
    launches.push(app);
    await harness.launch(harness.newUserData('success'));
    await harness.dispose();
    expect(child.exitCode).toBe(0);
    await expect(access(harness.base)).rejects.toMatchObject({ code: 'ENOENT' });
  });

  it('retains failed fixture state while still closing its owned application', async () => {
    vi.spyOn(process.stderr, 'write').mockReturnValue(true);
    const hooks: (() => void)[] = [];
    const harness = await createHarness((hook) => hooks.push(hook), launchApplication);
    fixtures.push(harness);
    const { app, child } = fakeApp();
    launches.push(app);
    const userData = harness.newUserData('failed');
    await harness.launch(userData);
    const proof = join(userData, 'state-proof.txt');
    await writeFile(proof, 'synthetic diagnostic evidence', 'utf8');
    expect(hooks).toHaveLength(1);
    hooks[0]?.();
    await harness.dispose();
    expect(child.exitCode).toBe(0);
    expect(await readFile(proof, 'utf8')).toBe('synthetic diagnostic evidence');
  });

  it('keeps late output attributed to its original application after another launch', async () => {
    const output: string[] = [];
    vi.spyOn(process.stderr, 'write').mockImplementation((chunk) => {
      output.push(String(chunk));
      return true;
    });
    const hooks: (() => void)[] = [];
    const harness = await createHarness((hook) => hooks.push(hook), launchApplication);
    fixtures.push(harness);
    const first = fakeApp();
    const second = fakeApp();
    launches.push(first.app, second.app);
    await harness.launch(harness.newUserData('first'));
    await harness.launch(harness.newUserData('second'));
    first.child.stdout.emit('data', Buffer.from('first-only-marker'));
    second.child.stderr.emit('data', Buffer.from('second-only-marker'));
    expect(hooks).toHaveLength(2);
    hooks[0]?.();
    hooks[1]?.();
    expect(output[0]).toContain('first-only-marker');
    expect(output[0]).not.toContain('second-only-marker');
    expect(output[1]).toContain('second-only-marker');
    expect(output[1]).not.toContain('first-only-marker');
  });

  it('retains seeded evidence when the application launcher rejects before returning a handle', async () => {
    vi.spyOn(process.stderr, 'write').mockReturnValue(true);
    const hooks: (() => void)[] = [];
    const harness = await createHarness(
      (hook) => hooks.push(hook),
      () => Promise.reject(new Error('synthetic launcher rejection')),
    );
    fixtures.push(harness);
    const userData = harness.newUserData('rejected-launch');
    await expect(harness.launch(userData)).rejects.toThrow('synthetic launcher rejection');
    expect(hooks).toHaveLength(1);
    hooks[0]?.();
    await harness.dispose();
    await expect(access(join(userData, 'nexar.config.json'))).resolves.toBeUndefined();
  });
});
