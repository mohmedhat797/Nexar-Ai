/**
 * Process launching for engineering lanes (ADR-018, ADR-019).
 *
 * A launcher turns a command an adapter wants to run into the exact command the
 * adapter must spawn. A sandboxing launcher wraps it in Nexar's OS sandbox and
 * starts a per-launch egress proxy; adapters keep their own spawn/kill logic.
 */

/** Egress allowed to the launched process. `none` means no network namespace access at all. */
export type NetworkPolicy =
  | { readonly mode: 'none' }
  | {
      readonly mode: 'proxy';
      /** Exact host names (optionally `host:port`, default port 443). No wildcards, no IP literals. */
      readonly allowHosts: readonly string[];
    };

/** An extra host path made visible inside the sandbox (for example a runtime's own credential directory). */
export interface LaunchMount {
  /** Absolute host path; must exist. Never the home directory itself. */
  readonly hostPath: string;
  /** Absolute path inside the sandbox. */
  readonly sandboxPath: string;
  readonly access: 'read-only' | 'read-write';
}

/**
 * Nexar-hosted services exposed to the process (ADR-027 section 9b): a host directory holding unix
 * sockets the caller already created, mounted read-only (connecting to a socket works on it).
 */
export interface LaunchServices {
  /** Canonical, owner-private (0700) host directory holding gateway.sock and/or bridge.sock. */
  readonly dir: string;
  /** gateway.sock is reachable as a loopback TCP port (the Chat Completions translator). */
  readonly gateway: boolean;
  /** bridge.sock is mounted for the stdio bridge relay. */
  readonly bridge: boolean;
  /** Absolute host path of the bundled relay script, mounted read-only inside. */
  readonly relayScript?: string;
}

/** What the adapter wants to run. Paths are host paths; the launcher maps them. */
export interface LaunchSpec {
  readonly command: string;
  readonly args: readonly string[];
  /** The complete environment for the process; nothing is inherited. */
  readonly env: Readonly<Record<string, string>>;
  /** Canonical host path of the workspace (worktree) the process works in. */
  readonly workspace: string;
  readonly workspaceAccess: 'read-only' | 'read-write';
  readonly network: NetworkPolicy;
  readonly mounts?: readonly LaunchMount[];
  readonly services?: LaunchServices;
}

/** One egress decision made by the launcher's proxy. Host only, never payload. */
export interface EgressEvent {
  readonly host: string;
  readonly port: number;
  readonly outcome: 'allowed' | 'denied';
  readonly reason?: string;
}

/** The command an adapter must spawn instead of its own, plus cleanup. */
export interface PreparedLaunch {
  readonly command: string;
  readonly args: readonly string[];
  readonly env: Readonly<Record<string, string>>;
  /** Host working directory for `spawn`. */
  readonly cwd: string;
  /** Where the workspace appears to the launched process (e.g. `/work` inside the sandbox). */
  readonly workspacePath: string;
  /** The isolation actually applied; adapters re-check it before enabling write mode. */
  readonly isolation: 'none' | 'sandbox';
  /** Stops the proxy and removes per-launch state. Idempotent; call it after the process exits. */
  dispose(): Promise<void>;
}

/** Supplies process isolation. Implementations MUST fail closed (throw) rather than degrade. */
export interface ProcessLauncher {
  readonly isolation: 'none' | 'sandbox';
  prepare(spec: LaunchSpec, signal: AbortSignal): Promise<PreparedLaunch>;
}

/** The engineering workspace a lane runs in, passed to adapters through the execution context. */
export interface EngineeringWorkspace {
  /** Canonical host path of the task worktree. */
  readonly path: string;
  readonly access: 'read-only' | 'read-write';
  readonly launcher: ProcessLauncher;
}
