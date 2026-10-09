// A fake `nexar plane serve --stdio` for Desktop tests (ADR-025). Plain Node, no dependencies.
// It speaks the `nexar-plane/1` frame protocol by hand and is steered only by NEXAR_FAKE_PLANE_*
// variables, so the same script serves unit tests and (through NEXAR_DESKTOP_TEST_PLANE) the
// Electron end-to-end tests.
//
//   NEXAR_FAKE_PLANE_SCENARIO  handshake behaviour (default `healthy`):
//     healthy | exit-before-ready | hang | protocol-mismatch | bad-ready | config-error |
//     sandbox-unavailable | selftest-fail | hardening-drift | interop-unknown | no-plans |
//     no-projects | malformed | oversized
//   NEXAR_FAKE_PLANE_RUN       behaviour of a `run` (default `commit`):
//     commit | approve | not-accepted | failed | cancel-wait | ignore-cancel | crash | hang-run |
//     error-run | garbage | oversized-run | reported (a coding run that wrongly ends `reported`)
//   NEXAR_FAKE_PLANE_NO_REPORT `1` does not advertise `repository-report` and refuses reviews
//   NEXAR_FAKE_PLANE_NO_PLAN   `1` does not advertise `implementation-plan` and refuses `plan` intents
//   NEXAR_FAKE_PLANE_REPORT    `big` makes the report large; `truncated` flags it truncated
//   NEXAR_FAKE_PLANE_LANES     `1` makes a committed outcome list its lanes
//   NEXAR_FAKE_PLANE_PROJECTS  comma separated plane project ids (default `plane-proj`)
//   NEXAR_FAKE_PLANE_RESOURCES `1` reports `readiness.resources` to a Desktop that sent
//                              `features: ['resources']` (an older Desktop never receives it)
//   NEXAR_FAKE_PLANE_CONTROL   `1` adds `readiness.control` (the Code control policy) next to the resources
//   NEXAR_FAKE_PLANE_LANE_FACTS `1` adds the executor facts to the lanes of a committed or reported outcome
//   NEXAR_FAKE_PLANE_ACCEPTANCE `engine` | `native` makes the commit that follows an approval list a
//                              feature and a review lane on different resources with executor facts:
//                              `engine` has the feature lane driven by DSH on a control resource,
//                              `native` has it fall back with `control-unavailable`
//   NEXAR_FAKE_PLANE_DIFF    `big` makes the diff large and truncated
//   NEXAR_FAKE_PLANE_LOG       when set, a JSON-lines log of the frames received and of the
//                              environment variable NAMES this process started with
import { appendFileSync } from 'node:fs';

const scenario = process.env.NEXAR_FAKE_PLANE_SCENARIO ?? 'healthy';
const runBehavior = process.env.NEXAR_FAKE_PLANE_RUN ?? 'commit';
const projects = (process.env.NEXAR_FAKE_PLANE_PROJECTS ?? 'plane-proj').split(',').filter(Boolean);
const logPath = process.env.NEXAR_FAKE_PLANE_LOG;
const reportPlan = process.env.NEXAR_FAKE_PLANE_NO_REPORT !== '1';
const planPlan = process.env.NEXAR_FAKE_PLANE_NO_PLAN !== '1';

const TASK_ID = 'task_fake_1';
const APPROVAL_ID = `apr_${'f'.repeat(32)}`;
const COMMIT = 'c'.repeat(40);
const PATCH_SHA = 'a'.repeat(64);

const FAKE_RESOURCES = [
  {
    id: 'claude-code',
    connection: {
      id: 'anthropic.subscription',
      provider: 'anthropic',
      method: 'subscription',
      authClass: 'vendor-native',
      support: 'official',
    },
    auth: 'authenticated',
    availability: 'available',
    control: { openworker: false, dsh: false },
  },
  {
    id: 'pi:deepseek-chat',
    connection: {
      id: 'deepseek.api',
      provider: 'deepseek',
      method: 'api',
      authClass: 'official-api',
      support: 'official',
    },
    auth: 'unknown',
    availability: 'unknown',
    control: { openworker: true, dsh: true },
  },
];

function log(entry) {
  if (logPath !== undefined) appendFileSync(logPath, `${JSON.stringify(entry)}\n`);
}

function send(frame) {
  process.stdout.write(`${JSON.stringify(frame)}\n`);
}

function readiness() {
  const base = {
    sandbox: 'ok',
    selftest: 'pass',
    automount: 'disabled',
    interop: 'disabled',
    kernel: '5.15.0-fake-WSL2',
    plans: [
      'implement-review',
      ...(reportPlan ? ['repository-report'] : []),
      ...(planPlan ? ['implementation-plan'] : []),
    ],
    projects,
  };
  switch (scenario) {
    case 'sandbox-unavailable':
      return { ...base, sandbox: 'unavailable', selftest: 'skipped' };
    case 'selftest-fail':
      return { ...base, selftest: 'fail' };
    case 'hardening-drift':
      return { ...base, automount: 'enabled' };
    case 'interop-unknown':
      return { ...base, interop: 'unknown' };
    case 'no-plans':
      return { ...base, plans: [] };
    case 'no-projects':
      return { ...base, projects: [] };
    default:
      return base;
  }
}

log({ event: 'start', env: Object.keys(process.env).sort() });

if (scenario === 'exit-before-ready') process.exit(1);

let activeRun;
let pendingDecision;
let knownTask = false;

function completed(runId, outcome) {
  send({ type: 'completed', runId, outcome });
  activeRun = undefined;
}

function summary() {
  return {
    taskId: TASK_ID,
    branch: 'nexar/task-fake-1',
    files: 2,
    gatesPassed: 3,
    reviewVerdict: 'approve',
    patchSha256: PATCH_SHA,
    ttlMs: 60_000,
  };
}

function runReport(runId, plan = false) {
  send({
    type: 'progress',
    runId,
    event: { type: 'lane.started', lane: 'report', role: 'report', round: 1 },
  });
  send({ type: 'progress', runId, event: { type: 'step', step: 'lane.completed', detail: {} } });
  const big = process.env.NEXAR_FAKE_PLANE_REPORT === 'big';
  completed(runId, {
    taskId: TASK_ID,
    status: 'reported',
    report: {
      text: plan
        ? '# Implementation plan\n\n## Steps\n\n1. Add the missing part.\n\n## Files to touch\n\n- src/index.ts\n\n## Risks\n\n- None known.\n\n## Tests\n\n- Add a unit test.\n'
        : big
          ? `# Repository review\n${'finding\n'.repeat(8_000)}`
          : '# Repository review\n\nThe repository implementation supports this proposal.\n\n- src/index.ts: entry point wires the proposal.\n',
      truncated: process.env.NEXAR_FAKE_PLANE_REPORT === 'truncated',
    },
    lanes: [
      {
        role: 'report',
        resourceId: 'dsh:deepseek',
        ...(process.env.NEXAR_FAKE_PLANE_LANE_FACTS === '1'
          ? { executor: 'engine', engine: 'dsh', controlResourceId: 'pi:deepseek-chat' }
          : {}),
      },
    ],
  });
}

/** The acceptance lane set (NXR-066): feature and review on different resources, with executor facts. */
function acceptanceLanes() {
  const set = process.env.NEXAR_FAKE_PLANE_ACCEPTANCE;
  if (set !== 'engine' && set !== 'native') return {};
  return {
    lanes: [
      {
        role: 'feature',
        resourceId: 'dsh:deepseek',
        ...(set === 'engine'
          ? { executor: 'engine', engine: 'dsh', controlResourceId: 'pi:deepseek-chat' }
          : { executor: 'native', executorReason: 'control-unavailable' }),
      },
      {
        role: 'review',
        resourceId: 'claude-code:sonnet',
        executor: 'native',
        executorReason: 'engine-not-selected',
      },
    ],
  };
}

function handleRun(frame) {
  if (activeRun !== undefined) {
    send({
      type: 'error',
      runId: frame.runId,
      code: 'CONFLICT',
      message: 'A run is already active',
    });
    return;
  }
  if (frame.intent === 'review' && !reportPlan) {
    send({
      type: 'error',
      runId: frame.runId,
      code: 'POLICY_REJECTED',
      message: 'Report-only engineering plans are not available',
    });
    return;
  }
  if (frame.intent === 'plan' && !planPlan) {
    send({
      type: 'error',
      runId: frame.runId,
      code: 'POLICY_REJECTED',
      message: 'Report-only engineering plans are not available',
    });
    return;
  }
  const runId = frame.runId;
  activeRun = { runId };
  send({ type: 'progress', runId, event: { type: 'step', step: 'task.started', detail: {} } });
  if (frame.intent === 'review' || frame.intent === 'plan' || runBehavior === 'reported') {
    // `reported` makes a coding run end reported too: a protocol violation Desktop must refuse.
    runReport(runId, frame.intent === 'plan');
    return;
  }
  switch (runBehavior) {
    case 'commit':
      knownTask = true;
      send({
        type: 'progress',
        runId,
        event: { type: 'lane.started', lane: 'impl', role: 'implementation', round: 1 },
      });
      send({
        type: 'progress',
        runId,
        event: { type: 'step', step: 'gate.completed', detail: {} },
      });
      completed(runId, {
        taskId: TASK_ID,
        status: 'committed',
        branch: 'nexar/task-fake-1',
        commit: COMMIT,
        ...(process.env.NEXAR_FAKE_PLANE_LANES === '1'
          ? {
              lanes: [
                {
                  role: 'implementation',
                  resourceId: 'dsh:deepseek',
                  ...(process.env.NEXAR_FAKE_PLANE_LANE_FACTS === '1'
                    ? {
                        executor: 'engine',
                        engine: 'dsh',
                        controlResourceId: 'pi:deepseek-chat',
                      }
                    : {}),
                },
                {
                  role: 'review',
                  resourceId: 'claude-code:sonnet',
                  ...(process.env.NEXAR_FAKE_PLANE_LANE_FACTS === '1'
                    ? { executor: 'native', executorReason: 'engine-not-selected' }
                    : {}),
                },
              ],
            }
          : {}),
      });
      break;
    case 'approve': {
      knownTask = true;
      const s = summary();
      send({
        type: 'progress',
        runId,
        event: {
          type: 'awaiting-approval',
          projectId: projects[0] ?? 'plane-proj',
          baseCommit: COMMIT,
          ...s,
        },
      });
      send({ type: 'approval-required', runId, approvalId: APPROVAL_ID, summary: s });
      pendingDecision = { runId };
      break;
    }
    case 'not-accepted':
      knownTask = true;
      completed(runId, { taskId: TASK_ID, status: 'not-accepted', reason: 'gate.failed' });
      break;
    case 'failed':
      completed(runId, { taskId: TASK_ID, status: 'failed', reason: 'setup.failed' });
      break;
    case 'crash':
      process.exit(3);
      break;
    case 'garbage':
      process.stdout.write('{ not a frame' + String.fromCharCode(10));
      break;
    case 'oversized-run':
      process.stdout.write('x'.repeat(1024 * 1024 + 10) + String.fromCharCode(10));
      break;
    case 'error-run':
      activeRun = undefined;
      send({ type: 'error', runId, code: 'CONFLICT', message: 'The plane is busy' });
      break;
    default:
      // cancel-wait, ignore-cancel, hang-run: stay running.
      break;
  }
}

function handle(frame) {
  log({ event: 'frame', type: frame.type, frame });
  switch (frame.type) {
    case 'initialize': {
      if (scenario === 'hang') return;
      if (scenario === 'protocol-mismatch') {
        send({ type: 'error', code: 'VALIDATION_ERROR', message: 'Unsupported protocol' });
        process.exit(1);
      }
      if (scenario === 'config-error') {
        send({ type: 'error', code: 'CONFIGURATION_ERROR', message: 'not configured' });
        process.exit(1);
      }
      if (scenario === 'malformed') {
        process.stdout.write('this is not json\n');
        return;
      }
      if (scenario === 'oversized') {
        process.stdout.write(`${'x'.repeat(1024 * 1024 + 10)}\n`);
        return;
      }
      send({
        type: 'ready',
        protocol: scenario === 'bad-ready' ? 'nexar-plane/2' : 'nexar-plane/1',
        planeVersion: '0.0.0-fake',
        // Like the real plane: `resources` only for a Desktop that asked for the feature.
        readiness:
          process.env.NEXAR_FAKE_PLANE_RESOURCES === '1' &&
          Array.isArray(frame.features) &&
          frame.features.includes('resources')
            ? {
                ...readiness(),
                resources: FAKE_RESOURCES,
                ...(process.env.NEXAR_FAKE_PLANE_CONTROL === '1'
                  ? {
                      control: {
                        code: { mode: 'pinned', resourceId: 'pi:deepseek-chat', fallback: 'none' },
                      },
                    }
                  : {}),
              }
            : readiness(),
      });
      return;
    }
    case 'run':
      handleRun(frame);
      return;
    case 'cancel':
      if (activeRun === undefined || activeRun.runId !== frame.runId) {
        send({
          type: 'error',
          runId: frame.runId,
          code: 'VALIDATION_ERROR',
          message: 'Unknown run',
        });
        return;
      }
      if (runBehavior === 'cancel-wait') {
        completed(frame.runId, { taskId: TASK_ID, status: 'cancelled' });
      }
      return;
    case 'decide':
      if (pendingDecision === undefined || frame.approvalId !== APPROVAL_ID) {
        send({ type: 'error', code: 'POLICY_REJECTED', message: 'Unknown approval' });
        return;
      }
      {
        const { runId } = pendingDecision;
        pendingDecision = undefined;
        const approved = frame.decision === 'approve';
        send({
          type: 'decided',
          approvalId: APPROVAL_ID,
          status: approved ? 'approved' : 'denied',
        });
        if (approved) {
          send({
            type: 'progress',
            runId,
            event: { type: 'step', step: 'commit.created', detail: {} },
          });
          completed(runId, {
            taskId: TASK_ID,
            status: 'committed',
            branch: 'nexar/task-fake-1',
            commit: COMMIT,
            ...acceptanceLanes(),
          });
        } else {
          completed(runId, { taskId: TASK_ID, status: 'not-accepted', reason: 'owner-denied' });
        }
      }
      return;
    case 'diff': {
      if (!knownTask || frame.taskId !== TASK_ID) {
        send({ type: 'error', code: 'POLICY_REJECTED', message: 'Unknown task' });
        return;
      }
      const big = process.env.NEXAR_FAKE_PLANE_DIFF === 'big';
      send({
        type: 'diff',
        taskId: TASK_ID,
        text: big
          ? `diff --git a/big.txt b/big.txt\n${'+line\n'.repeat(40_000)}`
          : 'diff --git a/a.txt b/a.txt\n--- a/a.txt\n+++ b/a.txt\n@@ -1 +1 @@\n-old\n+new\n',
        truncated: big,
        files: ['a.txt', 'src/b.ts'],
      });
      return;
    }
    case 'shutdown':
      if (activeRun !== undefined && runBehavior !== 'ignore-cancel') {
        completed(activeRun.runId, { taskId: TASK_ID, status: 'cancelled' });
      }
      if (runBehavior === 'ignore-cancel' && activeRun !== undefined) return; // stays alive
      process.exit(0);
      break;
    default:
      break;
  }
}

let buffer = '';
process.stdin.setEncoding('utf8');
process.stdin.on('data', (chunk) => {
  buffer += chunk;
  for (let at = buffer.indexOf('\n'); at >= 0; at = buffer.indexOf('\n')) {
    const line = buffer.slice(0, at).trim();
    buffer = buffer.slice(at + 1);
    if (line !== '') handle(JSON.parse(line));
  }
});
process.stdin.on('end', () => process.exit(0));
