import { basename, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { projectId, NexarError } from '@nexar/contracts';
import {
  parseCoworkFiles,
  readCoworkFile,
  type CoworkFile,
} from '@nexar/integration-deepseek-harness';
import { resolveContainedPath } from '@nexar/projects';
import type { FileSessionStore } from '@nexar/sessions';
import type { CoworkRequest } from '@nexar/operating';
import type { EngineHost } from './engine-host.js';

/** Owner-configured `cowork` document set and this conversation's own prior drafts only. */
export async function loadCoworkInputs(
  engine: EngineHost,
  sessions: FileSessionStore | undefined,
  request: CoworkRequest,
): Promise<readonly CoworkFile[]> {
  const projects = engine.composition().runtime.projects;
  const project = projects.require(projectId(request.projectId));
  const files: CoworkFile[] = [];
  const seen = new Set<string>();
  const add = async (uri: string): Promise<void> => {
    const path = await resolveContainedPath(fileURLToPath(uri), project.realRoots);
    if (seen.has(path)) return;
    if (files.length >= 32) throw new NexarError('VALIDATION_ERROR', 'Too many Cowork input files');
    seen.add(path);
    const safeName = basename(path)
      .replace(/[^A-Za-z0-9._-]/g, '_')
      .slice(0, 100)
      .replace(/[. ]+$/, '_');
    const name = `input-${String(files.length + 1)}-${safeName}`;
    files.push(await readCoworkFile(dirname(path), basename(path), name));
  };
  if (Object.hasOwn(project.documentSets ?? {}, 'cowork')) {
    for (const ref of await projects.resolveDocumentSet(project, 'cowork')) await add(ref.uri);
  }
  const session = await sessions?.get(request.sessionId);
  if (session !== undefined) {
    if (session.projectId !== request.projectId)
      throw new NexarError('POLICY_REJECTED', 'Cowork project mismatch');
    // Most recent preceding completed draft turn: revisions do not grow the input set without bound.
    const current = session.turns.find((turn) => turn.id === request.turnId);
    const previous = [...session.turns]
      .reverse()
      .find(
        (turn) =>
          turn.index < (current?.index ?? 0) &&
          turn.state === 'succeeded' &&
          turn.artifacts.length > 0,
      );
    for (const ref of previous?.artifacts ?? []) await add(ref.uri);
  }
  return parseCoworkFiles(files);
}
