import { dirname, join } from 'node:path';
import { ApprovalGate, FileApprovalStore, type ApprovalStore } from '@nexar/approvals';
import type {
  Logger,
  ResourceDescriptor,
  ResourceSnapshot,
  SecretResolver,
} from '@nexar/contracts';
import {
  compose,
  composeWorkflows,
  loadHostConfig,
  nexarStateDir,
  type Composition,
  type ConnectionSeam,
  type HostEnvironment,
} from '@nexar/host';
import type { WorkflowCatalog, WorkflowRunner } from '@nexar/workflows';

/**
 * Everything the bridge needs from the Nexar engine. One interface so the engine can move into an
 * Electron `utilityProcess` later without touching the handlers (ADR-021 §2).
 */
export interface EngineHost {
  readonly configPath: string;
  /** The current composition (engine, registry, projects, quota source, loaded config). */
  composition(): Composition;
  workflows(): { readonly catalog: WorkflowCatalog; readonly runner: WorkflowRunner };
  /** The store the Approvals screen reads and the ACP/engineering requests write to. */
  approvals(): ApprovalStore;
  /** Registry snapshots; probes run on the first call and whenever `refresh` is set. */
  snapshots(refresh: boolean): Promise<readonly ResourceSnapshot[]>;
  /** Recomposes from the config file; on failure the previous composition stays in place. */
  reload(): Promise<void>;
}

export interface EngineHostOptions {
  readonly configPath: string;
  readonly env: Readonly<Record<string, string | undefined>>;
  readonly logger: Logger;
  readonly resolveSecret?: SecretResolver;
  /** The ChatGPT plan's token seam for the pi adapter (main only; ADR-022 amendment 2026-10-05). */
  readonly connections?: ConnectionSeam;
  /** Resources the app publishes itself (the connected plan); read on every (re)composition. */
  readonly extraResources?: () => Promise<readonly ResourceDescriptor[]>;
  /** Startup phase names for diagnostics (no data); see NEXAR_DESKTOP_STARTUP_TRACE. */
  readonly trace?: (phase: string) => void;
}

interface Built {
  readonly composition: Composition;
  readonly workflows: { readonly catalog: WorkflowCatalog; readonly runner: WorkflowRunner };
  readonly approvals: ApprovalStore;
  refreshed: boolean;
}

/** Builds the engine for the desktop: `project-only` workspace policy, approvals in the shared store. */
export async function createEngineHost(options: EngineHostOptions): Promise<EngineHost> {
  const io: HostEnvironment = { env: options.env, cwd: dirname(options.configPath) };

  async function build(): Promise<Built> {
    const loaded = await loadHostConfig(io, options.configPath);
    options.trace?.('engine-config');
    // The same store `nexar approvals` decides on, so ACP and engineering requests land here.
    const store = new FileApprovalStore(join(nexarStateDir(loaded, io), 'approvals'));
    const gate = new ApprovalGate({ mode: 'store', store, logger: options.logger });
    // A failing source publishes nothing: the plan's resources are simply absent.
    const extraResources = await (options.extraResources?.() ?? Promise.resolve([])).catch(
      () => [],
    );
    const composition = await compose(loaded, io, options.logger, {
      workingDirectoryPolicy: 'project-only',
      approvals: { gate, store },
      extraResources,
      ...(options.connections === undefined ? {} : { connections: options.connections }),
      ...(options.resolveSecret === undefined ? {} : { resolveSecret: options.resolveSecret }),
    });
    options.trace?.('engine-compose');
    const workflows = await composeWorkflows(composition.runtime, io);
    options.trace?.('engine-workflows');
    return { composition, workflows, approvals: store, refreshed: false };
  }

  let current = await build();

  return {
    configPath: options.configPath,
    composition: () => current.composition,
    workflows: () => current.workflows,
    approvals: () => current.approvals,
    async snapshots(refresh) {
      const built = current;
      const { registry } = built.composition.runtime;
      if (refresh || !built.refreshed) {
        built.refreshed = true;
        return registry.refresh();
      }
      return registry.snapshot();
    },
    async reload() {
      current = await build();
    },
  };
}
