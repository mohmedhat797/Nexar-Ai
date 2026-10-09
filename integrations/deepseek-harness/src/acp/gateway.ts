import { createHash } from 'node:crypto';
import { basename, isAbsolute } from 'node:path';
import { NexarError } from '@nexar/contracts';
import type { ExecutionGateway, PreparedLaunch } from '@nexar/contracts';
import { NEXAR_CONTROL_MODEL, NEXAR_ROUTE } from '../overlay.js';

/** The MCP server name of the Intelligence Bridge relay in `session/new` (tools are `mcp__nexar__...`). */
export const BRIDGE_SERVER_NAME = 'nexar';
/** The relay's tool names as the relay registers them (`integrations/mcp/src/bridge-relay.ts`). */
const BRIDGE_RAW_TOOLS = ['nexar.intelligence_submit', 'nexar.intelligence_status'] as const;

const MAX_PUBLIC_NAME_LENGTH = 64;
const INVALID_NAME_CHARS = /[^A-Za-z0-9_-]/g;
const HASH_LENGTH = 12;

/**
 * DSH's model-facing name for one MCP tool: `mcp__<server>__<tool>`, with characters outside
 * `[A-Za-z0-9_-]` replaced and, when that changed anything, a hash of the identity appended
 * (dsh-mcp-client `src/tools.ts` `publicToolName`, upstream 639ed01).
 */
export function publicMcpToolName(serverName: string, rawName: string): string {
  const joined = `mcp__${serverName}__${rawName}`;
  const normalized = joined.replace(INVALID_NAME_CHARS, '_');
  if (normalized === joined && normalized.length <= MAX_PUBLIC_NAME_LENGTH) return normalized;
  const hash = createHash('sha256').update(`${serverName}\0${rawName}`).digest('hex');
  return `${normalized.slice(0, MAX_PUBLIC_NAME_LENGTH - HASH_LENGTH - 1)}_${hash.slice(0, HASH_LENGTH)}`;
}

/** Exactly the two tool names the bridge relay adds to a gateway session. */
export function bridgeToolNames(): readonly string[] {
  return BRIDGE_RAW_TOOLS.map((tool) => publicMcpToolName(BRIDGE_SERVER_NAME, tool));
}

/** The opaque ACP `model` option value for a route: the JSON pair (dsh-acp `model-control.ts`). */
export function acpModelValue(provider: string, model: string): string {
  return JSON.stringify([provider, model]);
}

/** The route a gateway session selects. */
export const GATEWAY_ROUTE = { provider: NEXAR_ROUTE, model: NEXAR_CONTROL_MODEL } as const;

/** What `prepare` reported for the mounted services, once checked against what was asked for. */
export interface GatewayEndpoints {
  readonly baseURL: string;
  readonly bridge?: { readonly endpoint: string; readonly relayPath: string };
}

export function isGatewayMode(
  gateway: ExecutionGateway | undefined,
): gateway is ExecutionGateway & { readonly engine: 'dsh' } {
  return gateway?.engine === 'dsh';
}

/** Fails (`INTEGRATION_UNAVAILABLE`) before anything is spawned when a requested service is not mounted. */
export function requireGatewayEndpoints(
  gateway: ExecutionGateway,
  prepared: Pick<PreparedLaunch, 'services'>,
): GatewayEndpoints {
  const services = prepared.services;
  const baseURL = services?.gatewayBaseUrl;
  if (baseURL === undefined) throw unavailable('the control gateway is not mounted');
  if (!gateway.services.bridge) return { baseURL };
  const endpoint = services?.bridgeEndpoint;
  const relayPath = services?.relayPath;
  if (endpoint === undefined || relayPath === undefined) {
    throw unavailable('the intelligence bridge is not mounted');
  }
  return { baseURL, bridge: { endpoint, relayPath } };
}

/**
 * The Node executable that runs the relay inside the sandbox: the DSH launch's own command when that
 * is an absolute `node` binary (a toolchain path the sandbox already shows). `dsh` itself is a Node
 * script, but nothing else tells Nexar where the sandbox's Node is, so it is never guessed.
 */
export function resolveNodeCommand(
  configured: string | undefined,
  binaryCommand: string,
): string | undefined {
  if (configured !== undefined) return isAbsolute(configured) ? configured : undefined;
  return isAbsolute(binaryCommand) && /^node(\.exe)?$/.test(basename(binaryCommand))
    ? binaryCommand
    : undefined;
}

/** The single ACP stdio MCP server entry for the bridge relay (`{ name, value }[]` env). */
export function bridgeMcpServer(
  nodeCommand: string,
  bridge: { readonly endpoint: string; readonly relayPath: string },
  token: string,
): Record<string, unknown> {
  return {
    name: BRIDGE_SERVER_NAME,
    command: nodeCommand,
    args: [bridge.relayPath],
    env: [
      { name: 'NEXAR_BRIDGE_ENDPOINT', value: bridge.endpoint },
      { name: 'NEXAR_BRIDGE_TOKEN', value: token },
    ],
  };
}

function unavailable(what: string): NexarError {
  return new NexarError('INTEGRATION_UNAVAILABLE', `${what}; refusing to start dsh`, {
    details: { reason: 'gateway-services' },
  });
}
