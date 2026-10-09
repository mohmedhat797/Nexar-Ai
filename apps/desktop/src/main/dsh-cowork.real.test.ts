import { existsSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { measured, type ModelTurnPortRequest } from '@nexar/contracts';
import { okTurn } from '@nexar/engine-gateway/testing';
import { DshCoworkService } from './dsh-cowork.js';
import { dshLaunchForEntry } from './dsh-runtime-path.js';
import {
  buildTestRuntime,
  controlKit,
  coworkRequest,
  type TestRuntime,
} from './dsh-cowork-test-kit.js';
import { newTask } from './tasks.js';
import { addProject, createHarness, type Harness } from './test-harness.js';

// Opt-in: runs the REAL pinned `dsh --profile acp` under DshCoworkService (CI installs it with
// scripts/install-dsh-runtime.mjs and exports NEXAR_DSH_ENTRY). The model is the fake port of the
// Control Model Gateway: no credentials, no network, no paid call.
const ENTRY = process.env['NEXAR_DSH_ENTRY'];
const CONTENT = '# Solution proposal\n\nREAL-RUNTIME-DRAFT\n';

let runtime: TestRuntime;
let h: Harness;
let projectId: string;
const stoppers: (() => Promise<void>)[] = [];

beforeAll(async () => {
  if (ENTRY !== undefined) runtime = await buildTestRuntime();
});
afterAll(() => runtime?.dispose());
beforeEach(async () => {
  if (ENTRY === undefined) return;
  h = await createHarness();
  projectId = await addProject(h);
});
afterEach(async () => {
  await Promise.all(stoppers.splice(0).map((stop) => stop()));
  await h?.cleanup();
});

/** The DSH `write` tool first, then the answer. */
function writeTool(request: ModelTurnPortRequest) {
  if (request.messages.at(-1)?.role === 'tool') return okTurn('Wrote proposal.md.');
  return {
    ...okTurn(),
    text: '',
    toolCalls: [
      { id: 'call_1', name: 'write', arguments: { file_path: 'proposal.md', content: CONTENT } },
    ],
    finishReason: 'tool-calls' as const,
    usage: { inputTokens: measured(1), outputTokens: measured(1) },
  };
}

describe.skipIf(ENTRY === undefined)('DshCoworkService on the real runtime', () => {
  async function ready() {
    const kit = controlKit({
      runtime,
      runtimeDir: join(dirname(h.userData), 'bridge-runtime'),
      turn: (_resource, request) => writeTool(request),
    });
    const launch = dshLaunchForEntry(ENTRY as string);
    if (launch === undefined) throw new Error('NEXAR_DSH_ENTRY must be an absolute .js path');
    const cowork = new DshCoworkService({
      settings: h.deps.settings,
      engine: h.engine,
      logger: h.deps.logger,
      stateDir: join(dirname(h.userData), 'dsh-cowork'),
      bridgeHost: kit.host,
      controlGateway: kit.gateway,
      controlChild: kit.child,
      relay: kit.relay,
      launch,
      env: process.env,
      timings: { startupTimeoutMs: 90_000, turnTimeoutMs: 120_000, probeTimeoutMs: 60_000 },
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
    kit.attach((event) => cowork.noteBridgeEvent(event));
    stoppers.push(
      () => cowork.dispose(),
      () => kit.stop(),
    );
    expect(await cowork.refresh()).toMatchObject({ state: 'ready' });
    return { cowork, kit };
  }

  it('writes the proposal in scratch and imports it as a draft artifact', async () => {
    const { cowork, kit } = await ready();
    const { request } = coworkRequest(projectId);
    const result = await cowork.run(request, new AbortController().signal);

    expect(result.text).toContain('Wrote proposal.md.');
    expect(result.artifacts).toHaveLength(1);
    expect(result.artifacts[0]).toMatchObject({ mediaType: 'text/markdown', draft: true });
    expect(
      await readFile(
        join(h.projectDir, '.nexar', 'artifacts', result.taskId, 'drafts', 'proposal.md'),
        'utf8',
      ),
    ).toBe(CONTENT);
    expect(kit.calls).toEqual(['mint', 'revoke']);
    expect(kit.turns.map((t) => t.request.messages.at(-1)?.role)).toEqual(['user', 'tool']);
    // Inside scratch, DSH either asks (and Nexar allows, recorded) or writes unasked.
    const decisions = (await h.engine.approvals().list()).filter(
      (r) => r.actionType === 'cowork.tool-call',
    );
    expect(decisions.every((r) => r.status === 'consumed')).toBe(true);
  }, 240_000);

  it('denies a write outside scratch', async () => {
    const kit = controlKit({
      runtime,
      runtimeDir: join(dirname(h.userData), 'bridge-runtime'),
      turn: (_resource, request) =>
        request.messages.at(-1)?.role === 'tool'
          ? okTurn('Done.')
          : {
              ...okTurn(),
              text: '',
              toolCalls: [
                {
                  id: 'call_1',
                  name: 'write',
                  arguments: {
                    file_path: '../outside.md',
                    content: 'ESCAPED',
                    sandbox_permissions: 'danger-full-access',
                    justification: 'the owner asked for it',
                  },
                },
              ],
              finishReason: 'tool-calls' as const,
            },
    });
    const launch = dshLaunchForEntry(ENTRY as string);
    const cowork = new DshCoworkService({
      settings: h.deps.settings,
      engine: h.engine,
      logger: h.deps.logger,
      stateDir: join(dirname(h.userData), 'dsh-cowork'),
      bridgeHost: kit.host,
      controlGateway: kit.gateway,
      controlChild: kit.child,
      relay: kit.relay,
      ...(launch === undefined ? {} : { launch }),
      env: process.env,
      timings: { startupTimeoutMs: 90_000, turnTimeoutMs: 120_000, probeTimeoutMs: 60_000 },
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
    await cowork.refresh();
    const result = await cowork.run(coworkRequest(projectId).request, new AbortController().signal);
    expect(result.artifacts).toEqual([]);
    expect(existsSync(join(dirname(h.userData), 'dsh-cowork', 'scratch', 'outside.md'))).toBe(
      false,
    );
    const decisions = (await h.engine.approvals().list()).filter(
      (r) => r.actionType === 'cowork.tool-call',
    );
    expect(decisions.length).toBeGreaterThan(0);
    expect(decisions.every((r) => r.status === 'denied')).toBe(true);
  }, 240_000);
});
