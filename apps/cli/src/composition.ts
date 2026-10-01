import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { ApprovalGate, FileApprovalStore, type ApprovalStore } from '@nexar/approvals';
import { LocalArtifactStore } from '@nexar/artifacts';
import {
  NexarError,
  type EgressEvent,
  type Logger,
  type ProcessLauncher,
  type TelemetrySink,
} from '@nexar/contracts';
import {
  createNexarWithProjects,
  loadConfig,
  type EngineeringConfig,
  type LoadedConfig,
  type NexarRuntime,
} from '@nexar/core';
import { AntigravityExecutionAdapter } from '@nexar/integration-antigravity';
import { ClaudeCodeExecutionAdapter } from '@nexar/integration-claude-code';
import { CodexExecutionAdapter } from '@nexar/integration-codex';
import { DeepSeekHarnessExecutionAdapter } from '@nexar/integration-deepseek-harness';
import { DelegateSkillsExecutionAdapter } from '@nexar/integration-delegate-skills';
import { EchoExecutionAdapter } from '@nexar/integration-echo';
import { PiExecutionAdapter } from '@nexar/integration-pi';
import { EngineeringRunner, PlanCatalog } from '@nexar/engineering';
import { SandboxLauncher, type SandboxAvailability } from '@nexar/sandbox';
import { JsonlFileTelemetrySink } from '@nexar/telemetry';
import { WorkflowCatalog, WorkflowRunner } from '@nexar/workflows';
import type { CliSeams, EngineeringRunnerPort } from './args.js';
import type { CliIo } from './io.js';

export interface Composition {
  readonly loaded: LoadedConfig;
  readonly runtime: NexarRuntime;
}

/** Where Nexar keeps local state: the config file's directory, or the cwd for the built-in default. */
export function stateBaseDir(loaded: LoadedConfig, io: CliIo): string {
  return loaded.path === undefined ? io.cwd : dirname(loaded.path);
}

function stateFile(loaded: LoadedConfig, io: CliIo, name: string): string {
  return join(stateBaseDir(loaded, io), '.nexar', name);
}

/** Hashed client credentials (`nexar clients`). */
export const clientsFilePath = (loaded: LoadedConfig, io: CliIo): string =>
  stateFile(loaded, io, 'clients.json');

/** Append-only request audit written by the MCP server. */
export const auditFilePath = (loaded: LoadedConfig, io: CliIo): string =>
  stateFile(loaded, io, 'audit.jsonl');

/** Resolves the config (explicit path > NEXAR_CONFIG_PATH > cwd file > built-in default). */
export function loadCliConfig(io: CliIo, explicitPath: string | undefined): Promise<LoadedConfig> {
  return loadConfig({
    ...(explicitPath === undefined ? {} : { explicitPath }),
    env: io.env,
    cwd: io.cwd,
  });
}

/**
 * The only place adapters are instantiated: every integration the CLI knows about.
 * Canonicalizes project roots, so a misconfigured project fails here with `CONFIGURATION_ERROR`.
 */
export async function compose(
  loaded: LoadedConfig,
  io: CliIo,
  logger: Logger,
  options: {
    readonly workingDirectoryPolicy?: 'project-only' | 'project-or-unscoped';
    /** Lets the DeepSeek Harness adapter answer ACP permission requests through Nexar approvals. */
    readonly approvals?: { readonly gate: ApprovalGate; readonly store: ApprovalStore };
  } = {},
): Promise<Composition> {
  const configDir = stateBaseDir(loaded, io);
  const adapters = [
    new EchoExecutionAdapter(),
    new ClaudeCodeExecutionAdapter({ env: io.env }),
    new CodexExecutionAdapter({ env: io.env }),
    new AntigravityExecutionAdapter({ env: io.env }),
    new DeepSeekHarnessExecutionAdapter({
      env: io.env,
      stateDir: join(configDir, '.nexar', 'runtimes', 'deepseek-harness'),
      ...(options.approvals === undefined ? {} : { approvals: options.approvals }),
    }),
    new PiExecutionAdapter({ env: io.env }),
    new DelegateSkillsExecutionAdapter({
      env: io.env,
      stateDir: join(configDir, '.nexar', 'runtimes', 'delegate-skills'),
    }),
  ];
  const runtime = await createNexarWithProjects(loaded.config, {
    adapters,
    logger,
    configDir,
    // The owner at their own terminal may run unscoped (`--cwd` without `--project`). External
    // clients (the MCP server / Work Bridge) must ask for 'project-only'.
    workingDirectoryPolicy: options.workingDirectoryPolicy ?? 'project-or-unscoped',
    // The built-in default config has no telemetry path of its own.
    ...(loaded.source === 'default'
      ? { telemetry: new JsonlFileTelemetrySink(join(io.cwd, '.nexar', 'telemetry.jsonl')) }
      : {}),
  });
  return { loaded, runtime };
}

/**
 * The shipped workflows: `<repo>/workflows`, found relative to this package (the same from `src`
 * and `dist`), unless `NEXAR_WORKFLOWS_DIR` names another directory.
 */
export function builtinWorkflowsDir(io: CliIo): string {
  const override = io.env['NEXAR_WORKFLOWS_DIR'];
  if (override !== undefined && override !== '') return resolve(io.cwd, override);
  return fileURLToPath(new URL('../../../workflows', import.meta.url));
}

/** The workflow catalog (built-in plus per-project) and a runner on the same engine and projects. */
export async function composeWorkflows(
  runtime: NexarRuntime,
  io: CliIo,
): Promise<{ readonly catalog: WorkflowCatalog; readonly runner: WorkflowRunner }> {
  const catalog = await WorkflowCatalog.load({
    builtinDir: builtinWorkflowsDir(io),
    projects: runtime.projects,
  });
  const runner = new WorkflowRunner({
    nexar: runtime.nexar,
    projects: runtime.projects,
    artifacts: new LocalArtifactStore({ projects: runtime.projects }),
    catalog,
  });
  return { catalog, runner };
}

/** The shipped engineering plans: `<repo>/engineering/plans`, unless `NEXAR_ENGINEERING_PLANS_DIR` says otherwise. */
export function builtinEngineeringPlansDir(io: CliIo): string {
  const override = io.env['NEXAR_ENGINEERING_PLANS_DIR'];
  if (override !== undefined && override !== '') return resolve(io.cwd, override);
  return fileURLToPath(new URL('../../../engineering/plans', import.meta.url));
}

/** `<state>/.nexar`: engineering records, approvals and the rest of the local state. */
export const nexarStateDir = (loaded: LoadedConfig, io: CliIo): string =>
  join(stateBaseDir(loaded, io), '.nexar');

/** The top-level `engineering` settings, or `CONFIGURATION_ERROR` telling the owner what to add. */
export function requireEngineeringConfig(loaded: LoadedConfig): EngineeringConfig {
  const engineering = loaded.config.engineering;
  if (engineering === undefined) {
    throw new NexarError(
      'CONFIGURATION_ERROR',
      'Engineering is not configured: add a top-level "engineering" section to the config ' +
        '(keys: "toolchainPaths", "author", and optionally "worktreesDir" and "approvalTtlMs") ' +
        'and an "engineering" section to the project',
    );
  }
  return engineering;
}

/** Running totals of the sandbox egress proxy's decisions, for the run summary. */
export interface EgressCounts {
  allowed: number;
  denied: number;
}

export interface EngineeringComposition {
  readonly runtime: NexarRuntime;
  readonly runner: EngineeringRunnerPort;
  /** Mutated while the runner works. */
  readonly egress: EgressCounts;
}

/** The sink the runtime itself uses (the config's JSONL file), or a discarding one. */
function engineeringTelemetry(loaded: LoadedConfig, io: CliIo): TelemetrySink {
  const path = loaded.config.telemetry.jsonlPath;
  if (path === undefined) return { emit: () => undefined };
  return new JsonlFileTelemetrySink(resolve(stateBaseDir(loaded, io), path));
}

/**
 * Everything `nexar engineer run|cleanup` needs: the real sandbox launcher, the file-backed
 * approval gate (the same store `nexar approvals` decides on), the ACP-permission-aware DSH adapter
 * and the runner. It never calls `recoverAfterRestart`: that would cancel the pending requests of a
 * concurrently running MCP server.
 */
export async function composeEngineering(
  loaded: LoadedConfig,
  io: CliIo,
  logger: Logger,
  seams: CliSeams['engineering'] = {},
  availability?: () => Promise<SandboxAvailability>,
): Promise<EngineeringComposition> {
  const engineering = requireEngineeringConfig(loaded);
  const stateDir = nexarStateDir(loaded, io);
  const store = new FileApprovalStore(join(stateDir, 'approvals'));
  const gate = new ApprovalGate({ mode: 'store', store, logger });
  const { runtime } = await compose(loaded, io, logger, { approvals: { gate, store } });

  const egress: EgressCounts = { allowed: 0, denied: 0 };
  const onEgress = (event: EgressEvent): void => {
    egress[event.outcome] += 1;
    logger.debug('sandbox egress', {
      host: event.host,
      port: event.port,
      outcome: event.outcome,
    });
  };
  const launcher: ProcessLauncher =
    seams?.launcher ??
    new SandboxLauncher({
      toolchainPaths: engineering.toolchainPaths,
      onEgress,
      ...(availability === undefined ? {} : { availability }),
    });

  const runner: EngineeringRunnerPort =
    seams?.runner ??
    new EngineeringRunner({
      nexar: runtime.nexar,
      projects: runtime.projects,
      plans: await PlanCatalog.load(builtinEngineeringPlansDir(io)),
      launcher,
      approvals: gate,
      artifacts: new LocalArtifactStore({ projects: runtime.projects }),
      telemetry: engineeringTelemetry(loaded, io),
      logger,
      stateDir,
      author: engineering.author,
      approvalTtlMs: engineering.approvalTtlMs,
      ...(engineering.worktreesDir === undefined ? {} : { worktreesDir: engineering.worktreesDir }),
    });
  return { runtime, runner, egress };
}
