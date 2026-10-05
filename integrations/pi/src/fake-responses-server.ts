import { createServer, type IncomingHttpHeaders } from 'node:http';
import type { AddressInfo } from 'node:net';

/*
 * Test kit: a fake OpenAI Responses server on 127.0.0.1 (`POST /v1/responses`, streamed). It records
 * every request (headers and JSON body) and plays scripted replies, so contract tests prove request
 * shape and error handling without ever contacting api.openai.com. Not used by production code.
 */

export type FakeResponsesReply =
  | { readonly kind: 'text'; readonly text: string }
  | { readonly kind: 'tool-call'; readonly name: string; readonly arguments: string }
  /** `code` is one of the documented `subscription_sharing_*` codes; `message` plays the body text. */
  | {
      readonly kind: 'error';
      readonly status: number;
      readonly code: string;
      readonly message?: string;
    };

export interface FakeResponsesRequest {
  readonly headers: IncomingHttpHeaders;
  readonly body: Record<string, unknown>;
}

export interface FakeResponsesServer {
  /** `http://127.0.0.1:<port>`; plan calls are redirected here by a test `fetch`. */
  readonly url: string;
  readonly requests: FakeResponsesRequest[];
  /** Consumed in order; once empty every request gets a plain text reply. */
  replies: FakeResponsesReply[];
  close(): Promise<void>;
}

const USAGE = { input_tokens: 11, output_tokens: 7, total_tokens: 18 };

function sse(
  events: readonly { readonly type: string; readonly [key: string]: unknown }[],
): string {
  return events.map((e) => `event: ${e.type}\ndata: ${JSON.stringify(e)}\n\n`).join('');
}

function textEvents(text: string): string {
  const item = { type: 'message', id: 'msg_1', role: 'assistant', status: 'completed' };
  return sse([
    { type: 'response.created', response: { id: 'resp_1', status: 'in_progress' } },
    {
      type: 'response.output_item.added',
      output_index: 0,
      item: { ...item, status: 'in_progress', content: [] },
    },
    {
      type: 'response.content_part.added',
      output_index: 0,
      item_id: 'msg_1',
      content_index: 0,
      part: { type: 'output_text', text: '', annotations: [] },
    },
    {
      type: 'response.output_text.delta',
      output_index: 0,
      item_id: 'msg_1',
      content_index: 0,
      delta: text,
    },
    {
      type: 'response.output_item.done',
      output_index: 0,
      item: { ...item, content: [{ type: 'output_text', text, annotations: [] }] },
    },
    {
      type: 'response.completed',
      response: { id: 'resp_1', status: 'completed', usage: USAGE },
    },
  ]);
}

function toolCallEvents(name: string, args: string): string {
  const item = { type: 'function_call', id: 'fc_1', call_id: 'call_1', name };
  return sse([
    { type: 'response.created', response: { id: 'resp_1', status: 'in_progress' } },
    {
      type: 'response.output_item.added',
      output_index: 0,
      item: { ...item, arguments: '', status: 'in_progress' },
    },
    {
      type: 'response.function_call_arguments.delta',
      output_index: 0,
      item_id: 'fc_1',
      delta: args,
    },
    {
      type: 'response.function_call_arguments.done',
      output_index: 0,
      item_id: 'fc_1',
      arguments: args,
    },
    {
      type: 'response.output_item.done',
      output_index: 0,
      item: { ...item, arguments: args, status: 'completed' },
    },
    {
      type: 'response.completed',
      response: { id: 'resp_1', status: 'completed', usage: USAGE },
    },
  ]);
}

export async function startFakeResponsesServer(): Promise<FakeResponsesServer> {
  let url = '';
  const state: FakeResponsesServer = {
    get url() {
      return url;
    },
    requests: [],
    replies: [],
    close: () =>
      new Promise((resolve) => {
        server.close(() => resolve());
        server.closeAllConnections();
      }),
  };
  const server = createServer((request, response) => {
    const chunks: Buffer[] = [];
    request.on('data', (chunk: Buffer) => chunks.push(chunk));
    request.on('end', () => {
      if (request.method !== 'POST' || request.url !== '/v1/responses') {
        response.writeHead(404, { 'content-type': 'application/json' });
        response.end(JSON.stringify({ error: { code: 'not_found' } }));
        return;
      }
      let body: Record<string, unknown> = {};
      try {
        body = JSON.parse(Buffer.concat(chunks).toString('utf8')) as Record<string, unknown>;
      } catch {
        /* Recorded as an empty body. */
      }
      state.requests.push({ headers: request.headers, body });
      const reply = state.replies.shift() ?? { kind: 'text', text: 'ok' };
      if (reply.kind === 'error') {
        response.writeHead(reply.status, {
          'content-type': 'application/json',
          // Keeps the SDK's own bounded retries fast.
          'retry-after-ms': '1',
        });
        response.end(
          JSON.stringify({
            error: { code: reply.code, message: reply.message ?? 'body-sentinel', type: 'error' },
          }),
        );
        return;
      }
      response.writeHead(200, { 'content-type': 'text/event-stream' });
      response.end(
        reply.kind === 'text'
          ? textEvents(reply.text)
          : toolCallEvents(reply.name, reply.arguments),
      );
    });
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  url = `http://127.0.0.1:${String((server.address() as AddressInfo).port)}`;
  return state;
}
