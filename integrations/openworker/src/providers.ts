/**
 * Upstream knowledge (ADR-026 §4): which Nexar/pi provider ids OpenWorker can use, and the provider
 * name OpenWorker knows each one by. Anything absent (for example `groq`) is unsupported.
 */
export const OPENWORKER_PROVIDERS: Readonly<Record<string, string>> = {
  anthropic: 'anthropic',
  openai: 'openai',
  google: 'gemini',
  deepseek: 'deepseek',
  mistral: 'mistral',
  xai: 'xai',
  openrouter: 'openrouter',
};

/** The OpenWorker provider name for a Nexar/pi provider id, or `undefined` when unsupported. */
export function openWorkerProviderFor(provider: string): string | undefined {
  return Object.hasOwn(OPENWORKER_PROVIDERS, provider) ? OPENWORKER_PROVIDERS[provider] : undefined;
}
