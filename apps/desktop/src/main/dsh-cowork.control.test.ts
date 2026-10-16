import { dirname, join } from 'node:path';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { ControlResourcePolicy } from '@nexar/contracts';
import { DshCoworkService } from './dsh-cowork.js';
import {
  buildTestRuntime,
  controlKit,
  coworkRequest,
  fakeLaunch,
  recordingSpawn,
  type ControlKit,
  type TestRuntime,
} from './dsh-cowork-test-kit.js';
import { newTask } from './tasks.js';
import { silentLogger } from '@nexar/engine-gateway/testing';
import { addProject, createHarness, type Harness } from './test-harness.js';

/*
 * A4/A5 (UDSH-02): every model call of a Cowork turn is bound to the NRC. Two fake model resources on
 * two different connections sit behind the real Control Model Gateway and Intelligence Bridge; the
 * owner's control policy decides which one answers, and the other is never called.
 */

const RESOURCES = [
  ['res-alpha', 'alpha'],
  ['res-beta', 'beta'],
] as const;
const AUTO: ControlResourcePolicy = { mode: 'auto', fallback: 'auto' };

let runtime: TestRuntime;
let h: Harness;
let projectId: string;
const stoppers: (() => Promise<void>)[] = [];

beforeAll(async () => {
  runtime = await buildTestRuntime();
});
afterAll(() => runtime.dispose());
beforeEach(async () => {
  h = await createHarness();
  projectId = await addProject(h);
});
afterEach(async () => {
  await Promise.all(stoppers.splice(0).map((stop) => stop()));
  await h.cleanup();
});

async function setup(policy?: ControlResourcePolicy) {
  if (policy !== undefined) await h.deps.settings.setCoworkControlResource(policy);
  const kit: ControlKit = controlKit({
    runtime,
    runtimeDir: join(dirname(h.userData), 'bridge-runtime'),
    resources: RESOURCES,
  });
  const spawned = recordingSpawn();
  const cowork = new DshCoworkService({
    settings: h.deps.settings,
    engine: h.engine,
    logger: silentLogger,
    stateDir: join(dirname(h.userData), 'dsh-cowork'),
    bridgeHost: kit.host,
    controlGateway: kit.gateway,
    controlChild: kit.child,
    relay: kit.relay,
    launch: fakeLaunch(runtime, { 'fake-unit': '0' }),
    spawn: spawned.spawn,
    env: { PATH: process.env['PATH'], SystemRoot: process.env['SystemRoot'] },
    timings: { startupTimeoutMs: 20_000, turnTimeoutMs: 30_000, probeTimeoutMs: 15_000 },
    createTask: (request, excluded) =>
      newTask(
        h.engine,
        {
          projectId: request.projectId,
          kind: request.kind,
          prompt: request.prompt,
          preferredResourceIds: request.preferredResourceIds,
          maxCostUsd: request.maxCostUsd,
          excludedResourceIds: excluded,
        },
        request.turnId,
        { sessionId: request.sessionId, turnId: request.turnId },
      ),
  });
  stoppers.push(
    () => cowork.dispose(),
    () => kit.stop(),
  );
  return { cowork, kit, spawned };
}

const other = (id: string): string => (id === 'res-alpha' ? 'res-beta' : 'res-alpha');

describe('Cowork control resource (A4/A5)', () => {
  it('Auto follows the NRC policy: the previewed resource answers every model call', async () => {
    const { cowork, kit, spawned } = await setup(AUTO);
    expect(await cowork.refresh()).toMatchObject({ state: 'ready' });
    const picked = await cowork.effectiveControlResourceId();
    expect(picked).toBe(kit.gateway.preview('dsh', AUTO)?.resourceId);

    const result = await cowork.run(coworkRequest(projectId).request, signal());

    expect(result).toMatchObject({ resourceId: picked, policyId: 'control@1:auto' });
    // A13: the model ran once per DSH completion (a tool turn, then the answer), on one resource.
    expect(kit.turns.map((t) => t.resource)).toEqual([picked, picked]);
    expect(kit.events.filter((e) => e.type === 'control.decided')).toHaveLength(1);
    expect(kit.events.some((e) => e.type === 'control.retry' || e.type === 'control.failed')).toBe(
      false,
    );
    // DSH was given the loopback translator and the grant token, never a provider key.
    const [session] = spawned.calls.filter((c) => c.args.includes('acp'));
    expect(session?.env['NEXAR_CONTROL_TOKEN']).toBe(kit.tokens[0]);
    expect(Object.keys(session?.env ?? {}).filter((n) => /KEY/i.test(n))).toEqual([]);
  });

  it('a pin selects the pinned resource and the other connection receives no call', async () => {
    const auto = controlKit({
      runtime,
      runtimeDir: join(dirname(h.userData), 'bridge-runtime-auto'),
      resources: RESOURCES,
    });
    const autoPick = auto.gateway.preview('dsh', AUTO)?.resourceId ?? '';
    await auto.stop();
    const pinned = other(autoPick);

    const { cowork, kit } = await setup({ mode: 'pinned', resourceId: pinned, fallback: 'none' });
    await cowork.refresh();
    expect(await cowork.effectiveControlResourceId()).toBe(pinned);
    const result = await cowork.run(coworkRequest(projectId).request, signal());

    expect(result).toMatchObject({ resourceId: pinned, policyId: 'control@1:pinned' });
    expect(kit.turns.map((t) => t.resource)).toEqual([pinned, pinned]);
    expect(kit.turns.some((t) => t.resource === other(pinned))).toBe(false);
  });

  it('a pinned resource that is unavailable fails with fallback none, before anything starts', async () => {
    const { cowork, kit, spawned } = await setup({
      mode: 'pinned',
      resourceId: 'res-gone',
      fallback: 'none',
    });
    expect(await cowork.refresh()).toMatchObject({
      state: 'configuration-missing',
      reason: 'No control-compatible resource can run Cowork',
    });
    expect(cowork.fallbackReason()).toBe('dsh-control-unavailable');
    await expect(cowork.run(coworkRequest(projectId).request, signal())).rejects.toMatchObject({
      code: 'INTEGRATION_UNAVAILABLE',
      message: 'No control-compatible resource can run Cowork',
    });
    expect(kit.calls).toEqual([]);
    expect(kit.turns).toEqual([]);
    expect(spawned.calls.filter((c) => c.args.includes('acp'))).toEqual([]);
  });

  it('a pinned resource that is unavailable falls back to Auto when the policy allows it', async () => {
    const { cowork, kit } = await setup({
      mode: 'pinned',
      resourceId: 'res-gone',
      fallback: 'auto',
    });
    await cowork.refresh();
    const picked = await cowork.effectiveControlResourceId();
    expect(RESOURCES.map(([id]) => id as string)).toContain(picked);
    const result = await cowork.run(coworkRequest(projectId).request, signal());
    expect(result.resourceId).toBe(picked);
    expect(new Set(kit.turns.map((t) => t.resource))).toEqual(new Set([picked]));
  });
});

const signal = (): AbortSignal => new AbortController().signal;
