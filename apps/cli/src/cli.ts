import { parseArgs } from 'node:util';
import type { NexarError } from '@nexar/contracts';
import { toNexarError, type LogLevel } from '@nexar/contracts';
import { createJsonLogger } from '@nexar/telemetry';
import { GLOBAL_OPTIONS, type CliSeams, type Command } from './args.js';
import { approvalsCommand } from './commands/approvals.js';
import { artifactsCommand } from './commands/artifacts.js';
import { clientsCommand } from './commands/clients.js';
import { doctorCommand } from './commands/doctor.js';
import { engineerCommand } from './commands/engineer.js';
import { mcpCommand } from './commands/mcp.js';
import { planeCommand } from './commands/plane.js';
import { projectsCommand } from './commands/projects.js';
import { resourcesCommand } from './commands/resources.js';
import { routeCommand } from './commands/route.js';
import { runCommand } from './commands/run.js';
import { sandboxCommand } from './commands/sandbox.js';
import { workflowsCommand } from './commands/workflows.js';
import { coworkCommand } from './commands/cowork.js';
import { EXIT, UsageError, exitCodeFor, type CliIo } from './io.js';

import { CLI_VERSION } from './version.js';

export { CLI_VERSION };

const COMMANDS: readonly Command[] = [
  doctorCommand,
  resourcesCommand,
  projectsCommand,
  artifactsCommand,
  approvalsCommand,
  clientsCommand,
  mcpCommand,
  workflowsCommand,
  engineerCommand,
  sandboxCommand,
  planeCommand,
  coworkCommand,
  routeCommand,
  runCommand,
];
const LOG_LEVELS: readonly string[] = ['debug', 'info', 'warn', 'error'];
const GLOBAL_STRING_OPTIONS: ReadonlySet<string> = new Set(['--config', '--log-level']);

function usage(): string {
  const commands = COMMANDS.map((c) => `  ${c.name.padEnd(10)}${c.summary}`).join('\n');
  return [
    'Usage: nexar [global options] <command> [options]',
    '',
    'Commands:',
    commands,
    '',
    'Global options:',
    '  --config <path>       Config file (default: $NEXAR_CONFIG_PATH, ./nexar.config.json, built-in)',
    '  --log-level <level>   debug | info | warn | error (default: $NEXAR_LOG_LEVEL or warn)',
    '  --json                Machine-readable output',
    '  -h, --help            Show help',
    '  --version             Print the version',
    '',
  ].join('\n');
}

function commandUsage(command: Command): string {
  return `Usage: ${command.usage}\n\n${command.summary}\n`;
}

/** The first argument that is neither an option nor the value of a global string option. */
function findCommandIndex(argv: readonly string[]): number {
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i] as string;
    if (GLOBAL_STRING_OPTIONS.has(arg)) i++;
    else if (!arg.startsWith('-')) return i;
  }
  return -1;
}

function logLevel(raw: string | undefined, env: NodeJS.ProcessEnv): LogLevel {
  const value = raw ?? env['NEXAR_LOG_LEVEL'] ?? 'warn';
  if (!LOG_LEVELS.includes(value)) {
    throw new UsageError(`invalid log level "${value}" (expected ${LOG_LEVELS.join(' | ')})`);
  }
  return value as LogLevel;
}

function reportError(error: NexarError, io: CliIo): number {
  io.stderr(`error [${error.code}]: ${error.message}\n`);
  const rejected = (error.details as { rejected?: unknown } | undefined)?.rejected;
  if (error.code === 'NO_ELIGIBLE_RESOURCE' && Array.isArray(rejected)) {
    for (const entry of rejected as { resourceId: string; reasonCodes: string[] }[]) {
      io.stderr(`  - ${entry.resourceId}: ${entry.reasonCodes.join(', ')}\n`);
    }
  }
  return exitCodeFor(error.code);
}

async function dispatch(argv: readonly string[], io: CliIo, seams: CliSeams): Promise<number> {
  const commandIndex = findCommandIndex(argv);
  const name = commandIndex === -1 ? undefined : argv[commandIndex];
  const command = name === undefined ? undefined : COMMANDS.find((c) => c.name === name);
  if (name !== undefined && command === undefined) {
    throw new UsageError(`unknown command "${name}"`);
  }
  const rest = commandIndex === -1 ? [...argv] : argv.filter((_, i) => i !== commandIndex);

  const { values, positionals } = parseArgs({
    args: rest,
    options: { ...GLOBAL_OPTIONS, ...command?.options },
    allowPositionals: true,
    strict: true,
  });

  if (values.version === true) {
    io.stdout(`${CLI_VERSION}\n`);
    return EXIT.ok;
  }
  if (values.help === true) {
    io.stdout(command === undefined ? usage() : commandUsage(command));
    return EXIT.ok;
  }
  if (command === undefined) throw new UsageError('a command is required');

  const logger = createJsonLogger({
    level: logLevel(values['log-level'], io.env),
    write: (line) => io.stderr(line + '\n'),
  });
  return command.run({
    io,
    logger,
    configPath: values.config,
    json: values.json === true,
    values: values,
    positionals,
    seams,
  });
}

/**
 * Runs the CLI and returns the process exit code. Fully in-process: all I/O goes through `io`.
 * `seams` replace outside-world pieces (sandbox probes, the engineering runner) in tests.
 */
export async function runCli(argv: string[], io: CliIo, seams: CliSeams = {}): Promise<number> {
  try {
    return await dispatch(argv, io, seams);
  } catch (error) {
    const code = (error as { code?: unknown } | null)?.code;
    const isParseError =
      error instanceof TypeError && typeof code === 'string' && code.startsWith('ERR_PARSE_ARGS');
    if (error instanceof UsageError || (isParseError && error instanceof Error)) {
      io.stderr(`nexar: ${error.message}\n\n${usage()}`);
      return EXIT.usage;
    }
    return reportError(toNexarError(error), io);
  }
}
