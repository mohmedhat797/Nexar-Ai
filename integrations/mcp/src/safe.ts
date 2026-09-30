import type { ResourceSnapshot, RouteDecision } from '@nexar/contracts';

/** The tools the server exposes. Client scopes (`nexar clients add --tools`) are named from this list. */
export const NEXAR_MCP_TOOLS = [
  'nexar.submit_work',
  'nexar.work_status',
  'nexar.route',
  'nexar.resources',
  'nexar.workflows',
] as const;

export type NexarMcpToolName = (typeof NEXAR_MCP_TOOLS)[number];

/**
 * A resource as an MCP client may see it. An allowlist on purpose: no credential references, env
 * var names, metadata, runtime options, tags, limits, costs or probe detail strings.
 */
export interface SafeResource {
  readonly id: string;
  readonly displayName: string;
  /** `model:<provider>/<model>`, `agent:<name>` or `tool:<name>`. */
  readonly kind: string;
  readonly capabilities: readonly string[];
  readonly availability: 'available' | 'degraded' | 'unavailable' | 'unknown';
  readonly auth: 'ready' | 'needs-auth' | 'unknown' | 'not-required';
  readonly locality: 'local' | 'third-party';
}

const AUTH: Readonly<Record<ResourceSnapshot['state']['auth'], SafeResource['auth']>> = {
  authenticated: 'ready',
  unauthenticated: 'needs-auth',
  'not-required': 'not-required',
  unknown: 'unknown',
};

function describeKind(kind: ResourceSnapshot['descriptor']['kind']): string {
  switch (kind.type) {
    case 'model':
      return `model:${kind.provider}/${kind.model}`;
    case 'agent':
      return `agent:${kind.agent}`;
    case 'tool-runtime':
      return `tool:${kind.tool}`;
  }
}

/** Projects a snapshot onto the safe allowlist; every field is copied explicitly. */
export function toSafeResource(snapshot: ResourceSnapshot): SafeResource {
  const { descriptor, state } = snapshot;
  return {
    id: descriptor.id,
    displayName: descriptor.displayName,
    kind: describeKind(descriptor.kind),
    capabilities: [...descriptor.capabilities],
    availability: state.availability,
    auth: AUTH[state.auth],
    locality: descriptor.dataLocality,
  };
}

/** The outcome of routing a task, without executing it. */
export interface RouteSummary {
  readonly outcome: 'selected' | 'no-eligible-resource';
  readonly policy: { readonly name: string; readonly version: string };
  readonly selected?: {
    readonly resourceId: string;
    readonly score: number;
    readonly reasonCodes: readonly string[];
  };
  readonly alternatives: readonly { readonly resourceId: string; readonly score: number }[];
  readonly rejected: readonly {
    readonly resourceId: string;
    readonly reasonCodes: readonly string[];
  }[];
  readonly explanation: string;
}

/** Maps a decision to its summary; `explanation` is `explainRouteDecision(decision)`. */
export function summarizeRoute(decision: RouteDecision, explanation: string): RouteSummary {
  return {
    outcome: decision.outcome,
    policy: { name: decision.policy.name, version: decision.policy.version },
    ...(decision.outcome === 'selected'
      ? {
          selected: {
            resourceId: decision.selected.resourceId,
            score: decision.selected.score,
            reasonCodes: decision.selected.reasons.map((r) => r.code),
          },
        }
      : {}),
    alternatives:
      decision.outcome === 'selected'
        ? decision.alternatives.map((a) => ({ resourceId: a.resourceId, score: a.score }))
        : [],
    rejected: decision.rejected.map((r) => ({
      resourceId: r.resourceId,
      reasonCodes: r.reasons.filter((x) => x.effect === 'rejects').map((x) => x.code),
    })),
    explanation,
  };
}
