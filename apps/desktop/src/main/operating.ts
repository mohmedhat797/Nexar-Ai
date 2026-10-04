import {
  OperatingService,
  type CodeRequest,
  type CoworkRequest,
  type CoworkResult,
  type DirectRequest,
  type DirectResult,
} from '@nexar/operating';
import { NexarError, projectId, type ArtifactRef } from '@nexar/contracts';
import type { Project } from '@nexar/projects';
import { toArtifactDto } from './artifacts.js';
import type { BridgeDeps, CallContext, JobRegistry } from './channel.js';
import { behaviorProfile } from './behavior.js';
import { createTask, progressLine, storeDraftRef } from './tasks.js';

/** A path inside a project (relative, never `..`); anything else is dropped. */
function displayPath(project: Project, ref: ArtifactRef): string | undefined {
  try {
    const path = toArtifactDto(project, ref, '').path;
    const escapes =
      path === '' ||
      path.startsWith('/') ||
      /^[A-Za-z]:/.test(path) ||
      path.split(/[\\/]/).includes('..');
    return escapes ? undefined : path;
  } catch {
    return undefined;
  }
}

/**
 * One `OperatingService` over the session store (ADR-024). Direct execution and the Code lane
 * (the WSL2 engineering plane, ADR-025) and the Cowork lane (supervised OpenWorker, ADR-026) can run. The session's own project is
 * authoritative, direct tasks carry Nexar-set lineage and the NRC still routes them with every
 * hard filter.
 */
export function createOperating(deps: BridgeDeps, jobs: JobRegistry): OperatingService | undefined {
  const store = deps.sessions;
  if (store === undefined) return undefined;
  const { codePlane, cowork } = deps;
  // The direct pipeline only needs `deps`; it never emits task events for session turns.
  const ctx: CallContext = { deps, jobs, emit: () => undefined, operating: undefined };

  async function executeDirect(request: DirectRequest, signal: AbortSignal): Promise<DirectResult> {
    const { nexar } = deps.engine.composition().runtime;
    const project = deps.engine.composition().runtime.projects.get(projectId(request.projectId));
    if (project === undefined) {
      throw new NexarError('VALIDATION_ERROR', 'The conversation project is no longer available');
    }
    request.onProgress('status', 'Routing the task');
    const task = createTask(
      ctx,
      {
        projectId: project.id,
        kind: request.kind,
        prompt: request.prompt,
        preferredResourceIds: request.preferredResourceIds,
        maxCostUsd: request.maxCostUsd,
      },
      request.turnId,
      { sessionId: request.sessionId, turnId: request.turnId },
    );
    await request.onTask(task.id);

    const outcome = await nexar.run(task, {
      signal,
      onEvent: (event) => {
        const line = progressLine(event);
        if (line !== undefined) request.onProgress(line.type, line.message);
      },
    });

    // Read only Cowork stores no draft artifact, also for a direct turn in a Cowork session.
    const ref = request.readOnly === true ? undefined : await storeDraftRef(ctx, project, outcome);
    const { decision } = outcome;
    return {
      taskId: task.id,
      text: outcome.result.text,
      artifacts: ref === undefined ? [] : [ref],
      resourceId: outcome.record.resourceId,
      policyId: `${decision.policy.name}@${decision.policy.version}`,
      fallback: decision.policy.fallback !== undefined,
    };
  }

  function executeCowork(request: CoworkRequest, signal: AbortSignal): Promise<CoworkResult> {
    if (cowork === undefined) {
      return Promise.reject(
        new NexarError('INTEGRATION_UNAVAILABLE', 'The Cowork lane is not available'),
      );
    }
    return cowork.run(request, signal);
  }

  /** Only the session's own project can describe its artifacts; nothing else is consulted. */
  function describeArtifact(ref: ArtifactRef, id: string): string | undefined {
    const project = deps.engine.composition().runtime.projects.get(projectId(id));
    return project === undefined ? undefined : displayPath(project, ref);
  }

  return new OperatingService({
    store,
    lanes: {
      // The Code lane is available for a project only when the engineering plane is ready and the
      // project is mapped to a plane project; Cowork only when OpenWorker is ready with a usable
      // resource. Nexar never reports a lane as available when it cannot run it.
      available: (lane, projectId) =>
        lane === 'code'
          ? (codePlane?.available(projectId) ?? false)
          : (cowork?.available() ?? false),
      reason: (lane, projectId) =>
        lane === 'code' ? codePlane?.reason(projectId) : cowork?.reason(),
      // OpenWorker itself is fine but no control resource can run it: recorded precisely.
      fallbackReason: () => cowork?.fallbackReason(),
      // A read-only review turn runs on the plane only when it advertises the report-only plan
      // (false while unknown); otherwise it runs direct, recorded as such.
      supports: (lane, kind) =>
        !(lane === 'code' && kind === 'review') || (codePlane?.supportsReport() ?? false),
      // The Plan profile needs the plane's report-only implementation plan.
      supportsPlan: () => codePlane?.supportsPlan() ?? false,
    },
    behavior: (mode) => behaviorProfile(deps.settings, mode),
    executeDirect,
    ...(codePlane === undefined
      ? {}
      : {
          executeCode: (request: CodeRequest, signal: AbortSignal) =>
            codePlane.run(request, signal),
        }),
    ...(cowork === undefined ? {} : { executeCowork }),
    describeArtifact,
    onTurnChanged: (sessionId, turnId) =>
      deps.broadcastSession({ sessionId, turnId, type: 'turn' }),
    onProgress: (sessionId, turnId, type, message) =>
      deps.broadcastSession({ sessionId, turnId, type, message }),
    logger: deps.logger,
  });
}
