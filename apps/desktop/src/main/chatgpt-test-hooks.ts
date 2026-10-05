/*
 * Test-only wiring for the ChatGPT plan (E2E). Honoured only under the `NEXAR_DESKTOP_USER_DATA`
 * test override (never set in production) and only for plain `http://127.0.0.1:<port>` URLs, so the
 * real OpenAI endpoints are never replaced in a real run and a fake can never point elsewhere:
 *  - `NEXAR_DESKTOP_TEST_CHATGPT_ISSUER`: a fake auth server; the "browser" is a plain fetch that
 *    follows its redirect to the real callback child.
 *  - `NEXAR_DESKTOP_TEST_RESPONSES_URL`: a fake Responses server that plan calls are redirected to.
 */

const LOOPBACK = /^http:\/\/127\.0\.0\.1:\d{1,5}$/;
const OPENAI_API = 'https://api.openai.com/v1';

function loopback(value: string | undefined): string | undefined {
  return value !== undefined && LOOPBACK.test(value) ? value : undefined;
}

export interface ChatGptTestHooks {
  readonly issuer: string;
  readonly openExternal: (url: string) => Promise<void>;
  readonly responsesFetch?: typeof fetch;
}

export function chatGptTestHooks(
  env: Readonly<Record<string, string | undefined>>,
  underTestOverride: boolean,
): ChatGptTestHooks | undefined {
  if (!underTestOverride) return undefined;
  const issuer = loopback(env['NEXAR_DESKTOP_TEST_CHATGPT_ISSUER']);
  if (issuer === undefined) return undefined;
  const responses = loopback(env['NEXAR_DESKTOP_TEST_RESPONSES_URL']);
  return {
    issuer,
    // Only the fake issuer's authorize page is ever fetched; its redirect reaches the callback child.
    openExternal: async (url) => {
      if (!url.startsWith(`${issuer}/`)) return;
      await fetch(url, { redirect: 'follow' }).then(
        (response) => response.body?.cancel(),
        () => undefined,
      );
    },
    ...(responses === undefined
      ? {}
      : {
          responsesFetch: (input, init) => {
            const target =
              typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
            if (!target.startsWith(`${OPENAI_API}/`)) {
              return Promise.reject(new Error('Only the fake Responses server is reachable'));
            }
            return fetch(`${responses}/v1/${target.slice(OPENAI_API.length + 1)}`, init);
          },
        }),
  };
}
