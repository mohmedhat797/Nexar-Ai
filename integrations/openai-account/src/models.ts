import { NexarError } from '@nexar/contracts';
import { MAX_ACCESS_TOKEN_CHARS } from './constants.js';

export interface OpenAiAccountModel {
  readonly slug: string;
  readonly displayName: string;
}

export interface OpenAiAccountModelClient {
  listModels(input: {
    readonly accessToken: string;
    readonly signal?: AbortSignal;
  }): Promise<readonly OpenAiAccountModel[]>;
}

export interface OpenAiAccountModelClientOptions {
  /** Offline test seam; the production endpoint is always fixed. */
  readonly fetch?: typeof fetch;
  readonly timeoutMs?: number;
}

const ENDPOINT = 'https://api.openai.com/v1/models';
const MAX_MODELS = 256;
// Catalog metadata can exceed the OAuth response ceiling; keep its own bounded budget.
const MAX_CATALOG_RESPONSE_BYTES = 1024 * 1024;
const catalogErrors = new WeakSet<NexarError>();
const fail = (reason: string): NexarError => {
  const error = new NexarError(
    reason === 'cancelled'
      ? 'EXECUTION_CANCELLED'
      : reason === 'timeout'
        ? 'EXECUTION_TIMEOUT'
        : reason === 'auth-rejected'
          ? 'AUTH_REQUIRED'
          : 'PROVIDER_ERROR',
    'The ChatGPT model catalog could not be loaded',
    { details: { reason } },
  );
  catalogErrors.add(error);
  return error;
};

function object(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function hasControl(value: string): boolean {
  return Array.from(value).some((char) => char.charCodeAt(0) < 32 || char.charCodeAt(0) === 127);
}

/** No API-key catalog shape, static fallback, limits or prices are inferred here. */
function parse(text: string): readonly OpenAiAccountModel[] {
  let body: unknown;
  try {
    body = JSON.parse(text);
  } catch {
    throw fail('malformed');
  }
  if (!object(body) || !Array.isArray(body.models) || body.models.length > MAX_MODELS)
    throw fail('malformed');
  const seen = new Set<string>();
  const out: OpenAiAccountModel[] = [];
  for (const model of body.models) {
    if (!object(model)) throw fail('malformed');
    if (model.visibility !== 'list') continue;
    const slug = model.slug;
    const displayName = model.display_name;
    if (
      typeof slug !== 'string' ||
      !/^\S{1,200}$/.test(slug) ||
      hasControl(slug) ||
      typeof displayName !== 'string' ||
      displayName.trim() === '' ||
      displayName.length > 160 ||
      hasControl(displayName) ||
      seen.has(slug)
    )
      throw fail('malformed');
    seen.add(slug);
    out.push(Object.freeze({ slug, displayName }));
  }
  return Object.freeze(out);
}

export function createOpenAiAccountModelClient(
  options: OpenAiAccountModelClientOptions = {},
): OpenAiAccountModelClient {
  const doFetch = options.fetch ?? fetch;
  const timeoutMs = options.timeoutMs ?? 5_000;
  if (!Number.isInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 10_000)
    throw fail('invalid-timeout');
  return {
    async listModels({ accessToken, signal }) {
      if (
        typeof accessToken !== 'string' ||
        accessToken === '' ||
        accessToken.length > MAX_ACCESS_TOKEN_CHARS ||
        /\s/.test(accessToken) ||
        hasControl(accessToken)
      )
        throw fail('invalid-token');
      const deadline = AbortSignal.timeout(timeoutMs);
      const combined = signal === undefined ? deadline : AbortSignal.any([signal, deadline]);
      let reader: ReadableStreamDefaultReader<Uint8Array> | undefined;
      let rejectAbort: ((reason: unknown) => void) | undefined;
      const onAbort = (): void => {
        void reader?.cancel().catch(() => undefined);
        rejectAbort?.(fail(signal?.aborted === true ? 'cancelled' : 'timeout'));
      };
      const aborted = new Promise<never>((_resolve, reject) => {
        rejectAbort = reject;
      });
      combined.addEventListener('abort', onAbort, { once: true });
      try {
        if (combined.aborted) throw fail(signal?.aborted === true ? 'cancelled' : 'timeout');
        const response = await Promise.race([
          doFetch(ENDPOINT, {
            method: 'GET',
            headers: { authorization: `Bearer ${accessToken}`, accept: 'application/json' },
            redirect: 'error',
            signal: combined,
          }),
          aborted,
        ]);
        if (!response.ok) {
          void response.body?.cancel().catch(() => undefined);
          throw fail(response.status === 401 ? 'auth-rejected' : 'rejected');
        }
        const length = response.headers.get('content-length');
        if (
          length !== null &&
          (!/^\d+$/.test(length) || Number(length) > MAX_CATALOG_RESPONSE_BYTES)
        ) {
          void response.body?.cancel().catch(() => undefined);
          throw fail('oversize');
        }
        if (response.body === null) throw fail('malformed');
        reader = response.body.getReader();
        const chunks: Uint8Array[] = [];
        let bytes = 0;
        for (;;) {
          const next = await Promise.race([reader.read(), aborted]);
          if (next.done) break;
          bytes += next.value.byteLength;
          if (bytes > MAX_CATALOG_RESPONSE_BYTES) throw fail('oversize');
          chunks.push(next.value);
        }
        return parse(new TextDecoder('utf-8', { fatal: true }).decode(Buffer.concat(chunks)));
      } catch (error) {
        if (signal?.aborted === true) throw fail('cancelled');
        if (deadline.aborted) throw fail('timeout');
        if (error instanceof NexarError && catalogErrors.has(error)) throw error;
        throw fail('network');
      } finally {
        combined.removeEventListener('abort', onAbort);
        void reader?.cancel().catch(() => undefined);
      }
    },
  };
}
