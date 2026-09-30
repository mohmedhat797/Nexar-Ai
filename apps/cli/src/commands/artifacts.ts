import { LocalArtifactStore } from '@nexar/artifacts';
import { projectId, taskId, type ProjectId, type TaskId } from '@nexar/contracts';
import { stringOption, type Command } from '../args.js';
import { compose, loadCliConfig } from '../composition.js';
import { renderTable } from '../format.js';
import { EXIT, UsageError } from '../io.js';

const USAGE = 'nexar artifacts list --project <id> --task <task-id> [--json]';

function parseId<T>(kind: string, raw: string, make: (s: string) => T): T {
  try {
    return make(raw);
  } catch {
    throw new UsageError(`invalid ${kind} "${raw}"`);
  }
}

export const artifactsCommand: Command = {
  name: 'artifacts',
  summary: 'List the artifacts stored for a task',
  usage: USAGE,
  options: { project: { type: 'string' }, task: { type: 'string' } },
  async run(ctx) {
    if (ctx.positionals.length !== 1 || ctx.positionals[0] !== 'list') {
      throw new UsageError(`usage: ${USAGE}`);
    }
    const project = stringOption(ctx, 'project');
    const task = stringOption(ctx, 'task');
    if (project === undefined || project === '') throw new UsageError('--project <id> is required');
    if (task === undefined || task === '') throw new UsageError('--task <task-id> is required');
    const pid: ProjectId = parseId('project id', project, projectId);
    const tid: TaskId = parseId('task id', task, taskId);

    const loaded = await loadCliConfig(ctx.io, ctx.configPath);
    const { runtime } = await compose(loaded, ctx.io, ctx.logger);
    const store = new LocalArtifactStore({ projects: runtime.projects });
    const refs = await store.list({ projectId: pid, taskId: tid });

    if (ctx.json) {
      ctx.io.stdout(JSON.stringify(refs, null, 2) + '\n');
    } else if (refs.length === 0) {
      ctx.io.stdout('no artifacts\n');
    } else {
      ctx.io.stdout(
        renderTable(
          ['LABEL', 'MEDIA TYPE', 'SIZE', 'DRAFT', 'SHA256', 'URI'],
          refs.map((r) => [
            r.label ?? '',
            r.mediaType ?? '-',
            r.sizeBytes === undefined ? '-' : String(r.sizeBytes),
            r.draft === true ? 'yes' : 'no',
            r.sha256?.slice(0, 12) ?? '-',
            r.uri,
          ]),
        ) + '\n',
      );
    }
    return EXIT.ok;
  },
};
