import { ClientRegistry, JsonlAuditLog } from '@nexar/access';
import { LocalArtifactStore } from '@nexar/artifacts';
import {
  NEXAR_MCP_TOOLS,
  serveNexarStdio,
  summarizeRoute,
  toSafeResource,
  type NexarMcpDeps,
} from '@nexar/integration-mcp';
import { createWorkBridge } from '@nexar/integration-openworker';
import { explainRouteDecision } from '@nexar/resource-controller';
import type { Command } from '../args.js';
import {
  auditFilePath,
  clientsFilePath,
  compose,
  composeWorkflows,
  loadCliConfig,
} from '../composition.js';
import { CLI_VERSION } from '../version.js';
import { EXIT, UsageError } from '../io.js';

const USAGE = 'nexar mcp serve';

/** No job runs forever: a hung runtime is cut off after this long. */
const JOB_TIMEOUT_MS = 30 * 60_000;

export const mcpCommand: Command = {
  name: 'mcp',
  summary: 'Serve Nexar to MCP clients such as OpenWorker (stdio only)',
  usage: `${USAGE}\n\nReads the client token from $NEXAR_CLIENT_TOKEN. Create one with "nexar clients add".`,
  options: {},
  async run(ctx) {
    if (ctx.positionals.length !== 1 || ctx.positionals[0] !== 'serve') {
      throw new UsageError(`usage: ${USAGE}`);
    }
    const loaded = await loadCliConfig(ctx.io, ctx.configPath);
    // External clients must never get an unscoped working directory: 'project-only'.
    const { runtime } = await compose(loaded, ctx.io, ctx.logger, {
      workingDirectoryPolicy: 'project-only',
    });
    const clients = await ClientRegistry.open(clientsFilePath(loaded, ctx.io));
    const audit = new JsonlAuditLog(auditFilePath(loaded, ctx.io));
    const lifetime = new AbortController();
    const { runner } = await composeWorkflows(runtime, ctx.io);
    const bridge = createWorkBridge({
      engine: runtime.nexar,
      projects: runtime.projects,
      artifacts: new LocalArtifactStore({ projects: runtime.projects }),
      workflows: runner,
      logger: ctx.logger.child({ component: 'work-bridge' }),
      timeoutMs: JOB_TIMEOUT_MS,
    });
    const token = ctx.io.env['NEXAR_CLIENT_TOKEN'];

    const deps: NexarMcpDeps = {
      bridge,
      router: {
        async route(input) {
          const task = runtime.nexar.createTask({
            kind: input.taskKind,
            prompt: input.request ?? 'route preview',
            projectId: input.project,
            requirements: {
              capabilities: [...input.capabilities],
              ...(input.maxCostUsd === undefined ? {} : { maxCostUsd: input.maxCostUsd }),
            },
            origin: { source: 'openworker', project: input.project },
          });
          const decision = await runtime.nexar.route(task);
          return summarizeRoute(decision, explainRouteDecision(decision));
        },
      },
      resources: {
        async list() {
          return (await runtime.registry.refresh()).map(toSafeResource);
        },
      },
      workflows: runner,
      clients,
      audit,
      token,
      logger: ctx.logger,
      version: CLI_VERSION,
      signal: lifetime.signal,
    };

    // Startup notice goes to stderr: stdout is reserved for protocol frames.
    if (token === undefined || token === '') {
      ctx.io.stderr('nexar mcp serve: NEXAR_CLIENT_TOKEN is not set; every call will be refused\n');
    }
    const handle = serveNexarStdio(deps);
    ctx.io.stderr(
      `nexar mcp serve: listening on stdio (${String(NEXAR_MCP_TOOLS.length)} tools, ${String(clients.list().length)} clients)\n`,
    );
    await handle.closed;
    lifetime.abort();
    await handle.close();
    return EXIT.ok;
  },
};
