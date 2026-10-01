import type { Project } from '@nexar/projects';
import type { Command } from '../args.js';
import { compose, loadCliConfig } from '../composition.js';
import { EXIT, UsageError } from '../io.js';

function toJson(project: Project): Record<string, unknown> {
  return {
    id: project.id,
    displayName: project.displayName,
    roots: project.realRoots,
    workingDirectories: project.realWorkingDirectories,
    documentSets: Object.fromEntries(
      Object.entries(project.documentSets ?? {}).map(([name, entries]) => [name, entries.length]),
    ),
    defaults: project.defaults ?? {},
    ...(project.metadata === undefined ? {} : { metadata: project.metadata }),
  };
}

function toText(project: Project): string {
  const sets = Object.entries(project.documentSets ?? {}).map(
    ([name, entries]) => `${name} (${String(entries.length)})`,
  );
  return [
    `${project.id}  ${project.displayName}`,
    `  roots:               ${project.realRoots.join(', ')}`,
    `  working directories: ${project.realWorkingDirectories.join(', ')}`,
    `  document sets:       ${sets.length === 0 ? '-' : sets.join(', ')}`,
    `  defaults:            ${JSON.stringify(project.defaults ?? {})}`,
  ].join('\n');
}

export const projectsCommand: Command = {
  name: 'projects',
  summary: 'List configured projects (canonical roots, document sets, defaults)',
  usage: 'nexar projects list [--json]',
  options: {},
  async run(ctx) {
    if (ctx.positionals.length !== 1 || ctx.positionals[0] !== 'list') {
      throw new UsageError('usage: nexar projects list [--json]');
    }
    const loaded = await loadCliConfig(ctx.io, ctx.configPath);
    // Composition canonicalizes every project root: a bad one fails here with CONFIGURATION_ERROR.
    const { runtime } = await compose(loaded, ctx.io, ctx.logger);
    const projects = runtime.projects.list();
    if (ctx.json) {
      ctx.io.stdout(JSON.stringify(projects.map(toJson), null, 2) + '\n');
    } else if (projects.length === 0) {
      ctx.io.stdout('no projects configured\n');
    } else {
      ctx.io.stdout(projects.map(toText).join('\n\n') + '\n');
    }
    return EXIT.ok;
  },
};
