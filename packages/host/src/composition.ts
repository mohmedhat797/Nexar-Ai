import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { ApprovalGate, FileApprovalStore, type ApprovalStore } from '@nexar/approvals';
import { LocalArtifactStore } from '@nexar/artifacts';
import {
  NexarError,
  type DiscoverySource,
  type DiscoverySourceReport,
  type EgressEvent,
  type ExecutionAdapter,
  type Logger,
  type ProcessLauncher,
  type SecretResolver,
  type TelemetrySink,
} from '@nexar/contracts';
import {
  createNexarWithProjects,
  loadConfig,
  type DiscoveryConfig,
  type EngineeringConfig,
  type LoadedConfig,
  type NexarRuntime,
} from '@nexar/core';
import {
  AntigravityExecutionAdapter,
  antigravityCliDiscoverySource,
} from '@nexar/integration-antigravity';
import {
  ClaudeCodeExecutionAdapter,
  claudeCodeCliDiscoverySource,
} from '@nexar/integration-claude-code';
import { CodexExecutionAdapter, codexCliDiscoverySource } from '@nexar/integration-codex';
import {
  DeepSeekHarnessExecutionAdapter,
  deepseekHarnessCliDiscoverySource,
} from '@nexar/integration-deepseek-harness';
import { DelegateSkillsExecutionAdapter } from '@nexar/integration-delegate-skills';
import { EchoExecutionAdapter } from '@nexar/integration-echo';
import {
  PiExecutionAdapter,
  localEndpointDiscoverySource,
  piCatalogDiscoverySource,
} from '@nexar/integration-pi';
import { DiscoveryService, mergeDiscovered } from '@nexar/resource-registry';
import { EngineeringRunner, PlanCatalog, laneHistoryProvider } from '@nexar/engineering';
import { SandboxLauncher, type SandboxAvailability } from '@nexar/sandbox';
import {
  JsonlFileTelemetrySink,
  TelemetryHistorySource,
  TelemetryQuotaSource,
} from '@nexar/telemetry';
import { WorkflowCatalog, WorkflowRunner } from '@nexar/workflows';
import type { EngineeringRunnerPort, EngineeringSeams, HostEnvironment } from './seams.js';

export interface Composition {
  readonly loaded: LoadedConfig;
  readonly runtime: NexarRuntime;
  /** Accounting over the configured telemetry file; absent when no telemetry file is configured. */
  readonly quotaSource?: TelemetryQuotaSource;
  /** Execution history (telemetry file, when configured) and engineering lane history. */
  readonly historySource: TelemetryHistorySource;
  /** Present when discovery ran (config `discovery.enabled` or `discover: 'always'`). */
  readonly discovery?: {
    readonly reports: readonly DiscoverySourceReport[];
    readonly collisions: number;
  };
}

/**
 * Every discovery source the host knows about (ADR-020 §9) plus the ids the owner's config switches
 * off. Detection lives in the integrations; this only instantiates them.
 */
export function discoverySources(
  config: DiscoveryConfig,
  env: Readonly<Record<string, string | undefined>>,
): { readonly sources: readonly DiscoverySource[]; readonly disabled: readonly string[] } {
  const cli = [
    claudeCodeCliDiscoverySource({ env }),
    codexCliDiscoverySource({ env }),
    antigravityCliDiscoverySource({ env }),
    deepseekHarnessCliDiscoverySource({ env, credentialSource: config.credentialSource }),
  ];
  const piCatalog = piCatalogDiscoverySource({
    providers: config.piCatalog.providers,
    credentialSource: config.credentialSource,
    maxModels: config.piCatalog.maxModels,
  });
  const local = localEndpointDiscoverySource({ endpoints: config.localEndpoints.endpoints });
  const disabled = [
    ...(config.cli.enabled ? [] : cli.map((s) => s.id)),
    ...(config.piCatalog.enabled ? [] : [piCatalog.id]),
    // Nothing to ask without owner-listed endpoints: there is no scanning.
    ...(config.localEndpoints.enabled && config.localEndpoints.endpoints.length > 0
      ? []
      : [local.id]),
  ];
  return { sources: [...cli, piCatalog, local], disabled };
}

/** Where Nexar keeps local state: the config file's directory, or the cwd for the built-in default. */
export function stateBaseDir(loaded: LoadedConfig, io: HostEnvironment): string {
  return loaded.path === undefined ? io.cwd : dirname(loaded.path);
}

function stateFile(loaded: LoadedConfig, io: HostEnvironment, name: string): string {
  return join(stateBaseDir(loaded, io), '.nexar', name);
}

/** Hashed client credentials (`nexar clients`). */
export const clientsFilePath = (loaded: LoadedConfig, io: HostEnvironment): string =>
  stateFile(loaded, io, 'clients.json');

/** Append-only request audit written by the MCP server. */
export const auditFilePath = (loaded: LoadedConfig, io: HostEnvironment): string =>
  stateFile(loaded, io, 'audit.jsonl');

/** Resolves the config (explicit path > NEXAR_CONFIG_PATH > cwd file > built-in default). */
export function loadHostConfig(
  io: HostEnvironment,
  explicitPath: string | undefined,
): Promise<LoadedConfig> {
  return loadConfig({
    ...(explicitPath === undefined ? {} : { explicitPath }),
    env: io.env,
    cwd: io.cwd,
  });
}

/** Every execution adapter the host knows about; the secret resolver reaches pi and DSH only. */
export function createAdapters(
  io: HostEnvironment,
  configDir: string,
  options: {
    readonly approvals?: { readonly gate: ApprovalGate; readonly store: ApprovalStore };
    readonly resolveSecret?: SecretResolver;
  } = {},
): readonly ExecutionAdapter[] {
  const secrets =
    options.resolveSecret === undefined ? {} : { resolveSecret: options.resolveSecret };
  return [
    new EchoExecutionAdapter(),
    new ClaudeCodeExecutionAdapter({ env: io.env }),
    new CodexExecutionAdapter({ env: io.env }),
    new AntigravityExecutionAdapter({ env: io.env }),
    new DeepSeekHarnessExecutionAdapter({
      env: io.env,
      stateDir: join(configDir, '.nexar', 'runtimes', 'deepseek-harness'),
      ...(options.approvals === undefined ? {} : { approvals: options.approvals }),
      ...secrets,
    }),
    new PiExecutionAdapter({ env: io.env, ...secrets }),
    new DelegateSkillsExecutionAdapter({
      env: io.env,
      stateDir: join(configDir, '.nexar', 'runtimes', 'delegate-skills'),
    }),
  ];
}

/**
 * The only place adapters are instantiated: every integration the host knows about.
 * Canonicalizes project roots, so a misconfigured project fails here with `CONFIGURATION_ERROR`.
 */
export async function compose(
  loaded: LoadedConfig,
  io: HostEnvironment,
  logger: Logger,
  options: {
    readonly workingDirectoryPolicy?: 'project-only' | 'project-or-unscoped';
    /** Lets the DeepSeek Harness adapter answer ACP permission requests through Nexar approvals. */
    readonly approvals?: { readonly gate: ApprovalGate; readonly store: ApprovalStore };
    /** `config` (default): discover only when `discovery.enabled`; `always`: for `--discovered`. */
    readonly discover?: 'config' | 'always';
    /**
     * Resolves `keystore` credential references (ADR-022). Handed only to the pi and DeepSeek
     * Harness adapters. The CLI passes none, so a keystore reference there is `AUTH_REQUIRED`.
     */
    readonly resolveSecret?: SecretResolver;
  } = {},
): Promise<Composition> {
  const configDir = stateBaseDir(loaded, io);
  // Configured resources always win; discovered ones only add new ids (ADR-020 §9).
  const discoveryConfig = loaded.config.discovery;
  let resources = mergeDiscovered(loaded.config.resources, []).resources;
  let discovery: Composition['discovery'];
  if (discoveryConfig.enabled || options.discover === 'always') {
    const { sources, disabled } = discoverySources(discoveryConfig, io.env);
    const service = new DiscoveryService({
      sources,
      disabled,
      refreshIntervalMs: discoveryConfig.refreshIntervalMs,
      timeoutMs: discoveryConfig.timeoutMs,
    });
    const result = await service.discover();
    const merged = mergeDiscovered(loaded.config.resources, result.batches, {
      excludeIds: discoveryConfig.excludeIds,
    });
    resources = merged.resources;
    discovery = { reports: result.reports, collisions: merged.collisions };
  }
  const adapters = createAdapters(io, configDir, options);
  // Without a telemetry file nothing can be accounted: quota stays unknown rather than "0 used".
  const telemetryPath =
    loaded.source === 'default'
      ? join(io.cwd, '.nexar', 'telemetry.jsonl')
      : loaded.config.telemetry.jsonlPath === undefined
        ? undefined
        : resolve(configDir, loaded.config.telemetry.jsonlPath);
  const quotaSource =
    telemetryPath === undefined
      ? undefined
      : new TelemetryQuotaSource({
          path: telemetryPath,
          allowances: loaded.config.routing.resourceIntelligence.allowances,
        });
  // Execution history from telemetry (when configured) plus engineering lane history (ADR-020 §7-8).
  const { windowDays } = loaded.config.routing.resourceIntelligence.history;
  const historySource = new TelemetryHistorySource({
    ...(telemetryPath === undefined ? {} : { path: telemetryPath }),
    windowDays,
    lanes: laneHistoryProvider(nexarStateDir(loaded, io), windowDays),
  });
  const runtime = await createNexarWithProjects(
    { ...loaded.config, resources },
    {
      adapters,
      ...(quotaSource === undefined ? {} : { quotaSource }),
      historySource,
      logger,
      configDir,
      // The owner at their own terminal may run unscoped (`--cwd` without `--project`). External
      // clients (the MCP server / Work Bridge) must ask for 'project-only'.
      workingDirectoryPolicy: options.workingDirectoryPolicy ?? 'project-or-unscoped',
      // The built-in default config has no telemetry path of its own.
      ...(loaded.source === 'default'
        ? { telemetry: new JsonlFileTelemetrySink(join(io.cwd, '.nexar', 'telemetry.jsonl')) }
        : {}),
    },
  );
  return {
    loaded,
    runtime,
    ...(quotaSource === undefined ? {} : { quotaSource }),
    historySource,
    ...(discovery === undefined ? {} : { discovery }),
  };
}

/**
 * The shipped workflows: `<repo>/workflows`, found relative to this package (the same from `src`
 * and `dist`), unless `NEXAR_WORKFLOWS_DIR` names another directory.
 */
export function builtinWorkflowsDir(io: HostEnvironment): string {
  const override = io.env['NEXAR_WORKFLOWS_DIR'];
  if (override !== undefined && override !== '') return resolve(io.cwd, override);
  return fileURLToPath(new URL('../../../workflows', import.meta.url));
}

/** The workflow catalog (built-in plus per-project) and a runner on the same engine and projects. */
export async function composeWorkflows(
  runtime: NexarRuntime,
  io: HostEnvironment,
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
export function builtinEngineeringPlansDir(io: HostEnvironment): string {
  const override = io.env['NEXAR_ENGINEERING_PLANS_DIR'];
  if (override !== undefined && override !== '') return resolve(io.cwd, override);
  return fileURLToPath(new URL('../../../engineering/plans', import.meta.url));
}

/** `<state>/.nexar`: engineering records, approvals and the rest of the local state. */
export const nexarStateDir = (loaded: LoadedConfig, io: HostEnvironment): string =>
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
function engineeringTelemetry(loaded: LoadedConfig, io: HostEnvironment): TelemetrySink {
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
  io: HostEnvironment,
  logger: Logger,
  seams: EngineeringSeams = {},
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
