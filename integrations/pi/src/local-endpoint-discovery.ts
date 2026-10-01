import { NexarError } from '@nexar/contracts';
import type { DiscoveryContext, DiscoverySource, ResourceDescriptor } from '@nexar/contracts';
import { slugifyResourceId } from './catalog-discovery.js';
import { isLoopbackUrl, piModelResource } from './resource.js';

export const LOCAL_ENDPOINTS_SOURCE_ID = 'local-endpoints';

const MAX_BODY_BYTES = 1024 * 1024;
const MAX_MODELS = 200;
const MAX_NAME_LENGTH = 200;
const ENDPOINT_ID = /^[a-z0-9][a-z0-9._-]{0,31}$/;

export interface LocalEndpointInput {
  readonly id: string;
  readonly kind: 'ollama' | 'openai-compatible';
  readonly baseUrl: string;
}

export interface LocalEndpointDiscoveryOptions {
  /** Only these owner-listed URLs are contacted: no scanning, no host derivation. */
  readonly endpoints: readonly LocalEndpointInput[];
  /** Test seam; default global `fetch`. */
  readonly fetch?: typeof fetch;
}

function fail(message: string): NexarError {
  return new NexarError('INTEGRATION_UNAVAILABLE', message);
}

function parseBase(endpoint: LocalEndpointInput): string {
  if (!ENDPOINT_ID.test(endpoint.id)) {
    throw new NexarError('CONFIGURATION_ERROR', 'local endpoint id is invalid');
  }
  let url: URL;
  try {
    url = new URL(endpoint.baseUrl);
  } catch {
    throw new NexarError('CONFIGURATION_ERROR', 'local endpoint URL is invalid');
  }
  if (
    (url.protocol !== 'http:' && url.protocol !== 'https:') ||
    url.username !== '' ||
    url.password !== ''
  ) {
    throw new NexarError('CONFIGURATION_ERROR', 'local endpoint URL must be plain http(s)');
  }
  return endpoint.baseUrl.replace(/\/+$/, '');
}

/** Reads at most {@link MAX_BODY_BYTES}; an oversize body is refused, never truncated. */
async function readCapped(response: Response): Promise<string> {
  const body = response.body;
  if (body === null) return '';
  const reader = body.getReader() as ReadableStreamDefaultReader<Uint8Array>;
  const chunks: Uint8Array[] = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > MAX_BODY_BYTES) {
      await reader.cancel().catch(() => undefined);
      throw fail('local endpoint response too large');
    }
    chunks.push(value);
  }
  return Buffer.concat(chunks).toString('utf8');
}

function validName(name: unknown): name is string {
  return (
    typeof name === 'string' &&
    name.length > 0 &&
    name.length <= MAX_NAME_LENGTH &&
    // Printable ASCII and above; no control characters.
    // eslint-disable-next-line no-control-regex
    !/[\u0000-\u001f\u007f]/.test(name)
  );
}

function modelNames(kind: LocalEndpointInput['kind'], json: unknown): string[] {
  const list = kind === 'ollama' ? field(json, 'models') : field(json, 'data');
  if (!Array.isArray(list)) throw fail('local endpoint returned an unexpected response');
  const names: string[] = [];
  for (const item of list.slice(0, MAX_MODELS) as unknown[]) {
    const name =
      kind === 'ollama' ? (field(item, 'name') ?? field(item, 'model')) : field(item, 'id');
    if (validName(name)) names.push(name);
  }
  return names;
}

function field(value: unknown, key: string): unknown {
  return typeof value === 'object' && value !== null
    ? (value as Record<string, unknown>)[key]
    : undefined;
}

async function listEndpoint(
  endpoint: LocalEndpointInput,
  fetchFn: typeof fetch,
  signal: AbortSignal,
): Promise<ResourceDescriptor[]> {
  const base = parseBase(endpoint);
  const path = endpoint.kind === 'ollama' ? '/api/tags' : '/v1/models';
  let response: Response;
  try {
    response = await fetchFn(base + path, {
      method: 'GET',
      redirect: 'error',
      signal,
      headers: { accept: 'application/json' },
    });
  } catch {
    // Unreachable, refused redirect or timeout: a code only, never the URL or the cause.
    throw fail('local endpoint request failed');
  }
  if (!response.ok) {
    await response.body?.cancel().catch(() => undefined);
    throw fail('local endpoint request failed');
  }
  let json: unknown;
  try {
    json = JSON.parse(await readCapped(response));
  } catch (e) {
    if (e instanceof NexarError) throw e;
    throw fail('local endpoint returned malformed JSON');
  }
  const loopback = isLoopbackUrl(base);
  const baseUrl = endpoint.kind === 'ollama' ? `${base}/v1` : base;
  const seen = new Set<string>();
  const out: ResourceDescriptor[] = [];
  for (const name of [...new Set(modelNames(endpoint.kind, json))].sort()) {
    const id = slugifyResourceId(`local.${endpoint.id}.${name}`);
    if (id === undefined || seen.has(id)) continue;
    seen.add(id);
    out.push({
      ...piModelResource({ id, provider: endpoint.id, model: name, baseUrl }),
      cost: loopback ? { model: 'local-compute' } : { model: 'unknown' },
    });
  }
  return out;
}

/**
 * Candidates from owner-listed Ollama / OpenAI-compatible endpoints. Bounded (1 MiB, 200 models),
 * no redirects, no auth header, and no host other than the listed ones. An endpoint that fails
 * is skipped while another succeeds; if every endpoint fails the source fails.
 */
export function localEndpointDiscoverySource(
  options: LocalEndpointDiscoveryOptions,
): DiscoverySource {
  return {
    id: LOCAL_ENDPOINTS_SOURCE_ID,
    async discover(ctx: DiscoveryContext): Promise<readonly ResourceDescriptor[]> {
      const fetchFn = options.fetch ?? fetch;
      const out: ResourceDescriptor[] = [];
      const seen = new Set<string>();
      let failure: unknown;
      let succeeded = 0;
      // Validate every URL up front so a bad entry is a configuration failure, not a silent skip.
      options.endpoints.forEach(parseBase);
      for (const endpoint of [...options.endpoints].sort((a, b) => (a.id < b.id ? -1 : 1))) {
        try {
          for (const d of await listEndpoint(endpoint, fetchFn, ctx.signal)) {
            if (!seen.has(d.id)) {
              seen.add(d.id);
              out.push(d);
            }
          }
          succeeded += 1;
        } catch (e) {
          failure = e;
        }
      }
      if (succeeded === 0 && failure !== undefined) {
        throw failure instanceof NexarError ? failure : fail('local endpoint request failed');
      }
      return out;
    },
  };
}
