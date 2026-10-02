import type { ProviderKeyCheck } from '@nexar/contracts';

const MAX_BYTES = 65_536;
const ENDPOINTS: Readonly<Record<string, { url: string; header: string; shape: string }>> =
  Object.freeze({
    anthropic: { url: 'https://api.anthropic.com/v1/models', header: 'x-api-key', shape: 'data' },
    openai: { url: 'https://api.openai.com/v1/models', header: 'authorization', shape: 'data' },
    google: {
      url: 'https://generativelanguage.googleapis.com/v1beta/models',
      header: 'x-goog-api-key',
      shape: 'models',
    },
    deepseek: { url: 'https://api.deepseek.com/models', header: 'authorization', shape: 'data' },
    openrouter: { url: 'https://openrouter.ai/api/v1/key', header: 'authorization', shape: 'key' },
    groq: { url: 'https://api.groq.com/openai/v1/models', header: 'authorization', shape: 'data' },
    mistral: { url: 'https://api.mistral.ai/v1/models', header: 'authorization', shape: 'data' },
    xai: { url: 'https://api.x.ai/v1/models', header: 'authorization', shape: 'data' },
  });

export interface ProviderKeyCheckOptions {
  /** Test transport seam; URLs remain fixed and owned by this integration. */
  readonly fetch?: typeof fetch;
  readonly timeoutMs?: number;
  readonly signal?: AbortSignal;
}

function record(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** One non-generating GET, no retries/pagination; errors and upstream data never escape. */
export async function checkProviderApiKey(
  provider: string,
  key: string | undefined,
  options: ProviderKeyCheckOptions = {},
): Promise<ProviderKeyCheck> {
  const endpoint = Object.hasOwn(ENDPOINTS, provider) ? ENDPOINTS[provider] : undefined;
  if (endpoint === undefined || key === undefined || !/^[A-Za-z0-9_.:-]{16,4096}$/.test(key))
    return { status: 'unchecked' };
  const deadline = options.timeoutMs ?? 5_000;
  if (!Number.isInteger(deadline) || deadline < 1 || deadline > 10_000)
    return { status: 'unavailable' };
  if (options.signal?.aborted) return { status: 'unavailable' };
  const controller = new AbortController();
  const abort = (): void => controller.abort();
  const timer = setTimeout(abort, deadline);
  options.signal?.addEventListener('abort', abort, { once: true });
  let response: Response | undefined;
  let reader: ReadableStreamDefaultReader<Uint8Array> | undefined;
  try {
    const headers: Record<string, string> = {
      accept: 'application/json',
      [endpoint.header]: endpoint.header === 'authorization' ? `Bearer ${key}` : key,
    };
    if (provider === 'anthropic') headers['anthropic-version'] = '2023-06-01';
    response = await (options.fetch ?? fetch)(endpoint.url, {
      method: 'GET',
      headers,
      redirect: 'manual',
      signal: controller.signal,
    });
    if (response.status === 401) return { status: 'invalid' };
    if (response.status !== 200 || response.redirected) return { status: 'unavailable' };
    const length = response.headers.get('content-length');
    if (length !== null && (!/^\d+$/.test(length) || Number(length) > MAX_BYTES))
      return { status: 'unavailable' };
    if (response.body === null) return { status: 'unavailable' };
    reader = response.body.getReader();
    const chunks: Uint8Array[] = [];
    let size = 0;
    while (true) {
      const chunk = await reader.read();
      if (chunk.done) break;
      size += chunk.value.byteLength;
      if (size > MAX_BYTES) return { status: 'unavailable' };
      chunks.push(chunk.value);
    }
    const bytes = new Uint8Array(size);
    let offset = 0;
    for (const chunk of chunks) {
      bytes.set(chunk, offset);
      offset += chunk.byteLength;
    }
    const data: unknown = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes));
    if (!record(data)) return { status: 'unavailable' };
    if (endpoint.shape === 'key') return { status: record(data['data']) ? 'valid' : 'unavailable' };
    const models = data[endpoint.shape];
    const field = endpoint.shape === 'models' ? 'name' : 'id';
    if (
      !Array.isArray(models) ||
      !models.every(
        (model: unknown) =>
          record(model) && typeof model[field] === 'string' && model[field].length > 0,
      )
    )
      return { status: 'unavailable' };
    return { status: 'valid', modelCount: models.length };
  } catch {
    return { status: 'unavailable' };
  } finally {
    clearTimeout(timer);
    options.signal?.removeEventListener('abort', abort);
    // Cancellation is best effort and never exposes transport errors or stalls the result.
    if (reader !== undefined) void reader.cancel().catch(() => undefined);
    else if (response?.body !== null && response?.body !== undefined)
      void response.body.cancel().catch(() => undefined);
  }
}
