import { z } from 'zod';
import { NexarError, isNexarError, type Logger, type NexarErrorCode } from '@nexar/contracts';
import {
  MAX_ACCESS_TOKEN_CHARS,
  MAX_ID_TOKEN_CHARS,
  MAX_REFRESH_TOKEN_CHARS,
  MAX_SCOPE_CHARS,
  accountFailureReason,
  createOpenAiAccountClient,
  createPkce,
  hasPlanSharing,
  randomToken,
  type OpenAiAccountClient,
} from '@nexar/integration-openai-account';
import {
  CHATGPT_PLAN_MESSAGES,
  ChatGptPlanStatusSchema,
  type ChatGptPlanReason,
  type ChatGptPlanStatus,
} from '../shared/chatgpt-plan.js';
import { CHANNELS } from '../shared/channels.js';
import { NoArgs, defineChannel, type ChannelDefinition } from './channel.js';
import type { DesktopKeyStore } from './desktop-key-store.js';
import type { SigninCallbackSupervisor } from './signin-callback-child.js';
import type { ConnectionLease, ConnectionManager } from './connection-manager.js';
import { PLAN_ID, planScopeName } from './connection-state.js';

/*
 * The owner's ChatGPT Plus/Pro plan as an `official-account` connection (ADR-022 amendment 2026-10-05):
 * Nexar's own "Sign in with ChatGPT" (PKCE, loopback callback in a per-sign-in child), tokens only in
 * the safeStorage-backed key store, refresh in main. Every sign-in is started by the owner. Nothing
 * here logs or returns a token, code, verifier, subject or URL; failures leave as fixed ids.
 */

/** The key-store name of the one connection. */
export const CHATGPT_PLAN_CONNECTION = 'chatgpt-plan';
/** A token with less than this left is refreshed before use. */
const REFRESH_MARGIN_MS = 3 * 60 * 1000;
/** How long the owner has to finish in the browser. */
const SIGN_IN_TIMEOUT_MS = 10 * 60 * 1000;
const SIGN_IN_GRACE_MS = 15_000;
const FIXED = 'ChatGPT connection could not be completed';

const Stored = z.strictObject({
  v: z.literal(1),
  accessToken: z.string().min(1).max(MAX_ACCESS_TOKEN_CHARS),
  refreshToken: z.string().min(1).max(MAX_REFRESH_TOKEN_CHARS),
  expiresAt: z.number().int().positive(),
  clientId: z.string().regex(/^[A-Za-z0-9_-]{1,128}$/),
  sub: z.string().min(1).max(256),
  idToken: z.string().min(1).max(MAX_ID_TOKEN_CHARS),
  scope: z.string().max(MAX_SCOPE_CHARS),
});
type StoredConnection = z.output<typeof Stored>;
const Binding = z.strictObject({ v: z.literal(1), sub: z.string().min(1).max(256) });

/** Only a boolean leaves the private Plan binding authority, never the decoded subject. */
export function hasRetainedPlanBinding(
  keys: Pick<DesktopKeyStore, 'readBlob'>,
  id: string,
): boolean {
  try {
    const scope = planScopeName(id);
    const encoded = scope === undefined ? undefined : keys.readBlob(scope + ':binding');
    return (
      encoded !== undefined &&
      Binding.safeParse(JSON.parse(Buffer.from(encoded, 'base64url').toString('utf8'))).success
    );
  } catch {
    return false;
  }
}

export interface ChatGptPlanDeps {
  readonly keys: Pick<DesktopKeyStore, 'availability' | 'saveBlob' | 'readBlob' | 'removeBlob'>;
  readonly callback: Pick<SigninCallbackSupervisor, 'begin'>;
  /** Opens the authorization page in the owner's browser (Electron's `shell.openExternal`). */
  readonly openExternal: (url: string) => Promise<void>;
  /** The random per-installation id (`installation-id.ts`). */
  readonly installationId: () => Promise<string>;
  readonly logger: Logger;
  readonly client?: OpenAiAccountClient;
  readonly clock?: () => number;
  /** Bound on the owner finishing in the browser. Default 10 minutes. */
  readonly signInTimeoutMs?: number;
  /**
   * Called (no arguments, no data) after the connection appears or disappears: sign-in, disconnect,
   * or an expired grant. Desktop uses it to republish the plan's resources.
   */
  readonly onChange?: () => void;
  /** Clears public inventory before account-changing operations, including a cancelled sign-in. */
  readonly onChanging?: () => void;
  readonly authority?: ConnectionManager;
}

type Idle =
  | { readonly state: 'signed-out'; readonly reason?: ChatGptPlanReason }
  | { readonly state: 'error'; readonly reason: ChatGptPlanReason };

const IDLE_MESSAGES: Readonly<Record<ChatGptPlanReason, ChatGptPlanStatus['message']>> = {
  disconnected: CHATGPT_PLAN_MESSAGES.disconnected,
  cancelled: CHATGPT_PLAN_MESSAGES.cancelled,
  expired: CHATGPT_PLAN_MESSAGES.expired,
  denied: CHATGPT_PLAN_MESSAGES.denied,
  timeout: CHATGPT_PLAN_MESSAGES.timeout,
  failed: CHATGPT_PLAN_MESSAGES.failed,
  'key-store-unavailable': CHATGPT_PLAN_MESSAGES['key-store-unavailable'],
};

const PUBLIC_CODES: ReadonlySet<NexarErrorCode> = new Set<NexarErrorCode>([
  'AUTH_REQUIRED',
  'CONFLICT',
  'CONFIGURATION_ERROR',
  'POLICY_REJECTED',
]);

/** Only a few codes leave this service; anything else (timeouts, upstream) is a provider error. */
function publicError(error: unknown): NexarError {
  const code = isNexarError(error) && PUBLIC_CODES.has(error.code) ? error.code : 'PROVIDER_ERROR';
  return new NexarError(code, FIXED);
}

const cancelled = (): NexarError => new NexarError('EXECUTION_CANCELLED', FIXED);

/** Rejects when `signal` aborts; the pending promise is left to settle on its own. */
function abortable<T>(promise: Promise<T>, signal: AbortSignal): Promise<T> {
  if (signal.aborted) return Promise.reject(cancelled());
  return new Promise<T>((resolve, reject) => {
    const onAbort = (): void => reject(cancelled());
    signal.addEventListener('abort', onAbort, { once: true });
    promise.then(resolve, reject).finally(() => signal.removeEventListener('abort', onAbort));
  });
}

export class ChatGptPlanService {
  private readonly client: OpenAiAccountClient;
  private readonly now: () => number;
  private signIn:
    { readonly controller: AbortController; readonly done: Promise<void> } | undefined;
  private idle: Idle = { state: 'signed-out' };
  private lock: Promise<unknown> = Promise.resolve();
  private disposed = false;
  private disconnecting = false;
  private connectionId = PLAN_ID;
  private credentialScope = CHATGPT_PLAN_CONNECTION;
  private removed = false;

  constructor(private readonly deps: ChatGptPlanDeps) {
    this.client = deps.client ?? createOpenAiAccountClient();
    this.now = deps.clock ?? Date.now;
  }

  async status(): Promise<ChatGptPlanStatus> {
    await this.loadIdentity();
    if (this.removed)
      return {
        state: 'signed-out',
        reason: 'disconnected',
        message: CHATGPT_PLAN_MESSAGES.disconnected,
      };
    return this.currentStatus();
  }

  private async loadIdentity(): Promise<void> {
    const record = await this.deps.authority?.currentPlan();
    if (record !== undefined) {
      this.connectionId = record.id;
      this.credentialScope = planScopeName(record.id)!;
      this.removed = record.lifecycleState === 'TOMBSTONED';
    }
  }

  /**
   * One owner-initiated sign-in. Resolves with the status once the owner finishes (or cancels) in the
   * browser; fails with a fixed error otherwise. Only one sign-in runs at a time.
   */
  async connect(): Promise<ChatGptPlanStatus> {
    if (this.disposed || this.disconnecting || this.signIn !== undefined)
      throw new NexarError('CONFLICT', FIXED);
    this.notifyChanging();
    const controller = new AbortController();
    let finished!: () => void;
    // Reserved before the first await so simultaneous calls cannot start two sign-ins.
    this.signIn = {
      controller,
      done: new Promise<void>((resolve) => {
        finished = resolve;
      }),
    };
    let timedOut = false;
    let lease: ConnectionLease | undefined;
    const timer = setTimeout(
      () => {
        timedOut = true;
        controller.abort();
      },
      (this.deps.signInTimeoutMs ?? SIGN_IN_TIMEOUT_MS) + SIGN_IN_GRACE_MS,
    );
    try {
      await this.loadIdentity();
      lease = await this.deps.authority?.acquirePlanOperation(this.connectionId, 'signin');
      await this.signInOnce(controller.signal);
      this.idle = { state: 'signed-out' };
    } catch (error) {
      if (controller.signal.aborted && !timedOut) {
        this.idle = { state: 'signed-out', reason: 'cancelled' };
      } else {
        const reason = timedOut ? 'timeout' : failureReason(error);
        this.idle = { state: 'error', reason };
        this.deps.logger.warn('chatgpt-plan.sign-in-failed', { reason });
        throw timedOut ? new NexarError('PROVIDER_ERROR', FIXED) : publicError(error);
      }
    } finally {
      lease?.release();
      clearTimeout(timer);
      this.signIn = undefined;
      finished();
      this.notifyChange();
    }
    return this.currentStatus();
  }

  /** Ends a running sign-in (the child included) and resolves once it is gone. */
  async cancel(): Promise<ChatGptPlanStatus> {
    const running = this.signIn;
    if (running !== undefined) {
      running.controller.abort();
      await running.done;
    }
    return this.currentStatus();
  }

  /** Forgets the tokens on this computer. The grant itself is revoked in ChatGPT settings. */
  async disconnect(): Promise<ChatGptPlanStatus> {
    if (this.deps.authority !== undefined)
      throw new NexarError('POLICY_REJECTED', 'Use the confirmed connection Forget action');
    if (this.disconnecting) throw new NexarError('CONFLICT', FIXED);
    this.disconnecting = true;
    this.notifyChanging();
    try {
      await this.cancel();
      await this.locked(() => this.deps.keys.removeBlob(this.credentialScope));
    } catch (error) {
      this.deps.logger.warn('chatgpt-plan.disconnect-failed', {});
      throw publicError(error);
    } finally {
      this.disconnecting = false;
      this.notifyChanging();
    }
    this.idle = { state: 'signed-out', reason: 'disconnected' };
    this.deps.logger.info('chatgpt-plan.disconnected', {});
    this.notifyChange();
    return this.currentStatus();
  }

  /**
   * A valid access token, refreshed (once, however many callers) when under three minutes remain.
   * `refresh` forces a new token after the provider rejected the current one; a caller that finds the
   * token already replaced by a concurrent refresh gets that one (the refresh token rotates, so it
   * must not be spent twice).
   */
  async accessToken(options: { readonly refresh?: boolean } = {}): Promise<string> {
    await this.loadIdentity();
    const lease = await this.deps.authority?.acquirePlanOperation(this.connectionId, 'refresh');
    try {
      const current = this.require();
      const forced = options.refresh === true;
      if (!forced && current.expiresAt - this.now() > REFRESH_MARGIN_MS) return current.accessToken;
      try {
        return await this.locked(async () => {
          // Re-read: a concurrent caller may already have refreshed, or the owner disconnected.
          const latest = this.require();
          if (
            forced
              ? latest.accessToken !== current.accessToken
              : latest.expiresAt - this.now() > REFRESH_MARGIN_MS
          ) {
            return latest.accessToken;
          }
          return (await this.refresh(latest)).accessToken;
        });
      } catch (error) {
        throw isNexarError(error) && error.code === 'AUTH_REQUIRED' ? error : publicError(error);
      }
    } finally {
      lease?.release();
    }
  }

  /** Ends a running sign-in (and its child); nothing starts afterwards. */
  dispose(): void {
    this.disposed = true;
    this.signIn?.controller.abort();
  }

  private notifyChange(): void {
    try {
      this.deps.onChange?.();
    } catch {
      /* A failing listener never affects the connection. */
    }
  }

  private notifyChanging(): void {
    try {
      this.deps.onChanging?.();
    } catch {
      /* Listener cannot change sign-in outcome. */
    }
  }

  private currentStatus(): ChatGptPlanStatus {
    if (this.disconnecting || this.removed)
      return ChatGptPlanStatusSchema.parse({
        state: 'signed-out',
        reason: 'disconnected',
        message: IDLE_MESSAGES.disconnected,
      });
    if (this.signIn !== undefined) {
      return ChatGptPlanStatusSchema.parse({
        state: 'signing-in',
        message: CHATGPT_PLAN_MESSAGES['signing-in'],
      });
    }
    try {
      const stored = this.peek();
      if (stored !== undefined) {
        return ChatGptPlanStatusSchema.parse({
          state: 'connected',
          planSharing: hasPlanSharing(stored.scope),
          message: CHATGPT_PLAN_MESSAGES.connected,
        });
      }
    } catch {
      return ChatGptPlanStatusSchema.parse({
        state: 'error',
        reason: 'key-store-unavailable',
        message: CHATGPT_PLAN_MESSAGES['key-store-unavailable'],
      });
    }
    return ChatGptPlanStatusSchema.parse({
      state: this.idle.state,
      ...(this.idle.reason === undefined ? {} : { reason: this.idle.reason }),
      message:
        this.idle.reason === undefined
          ? CHATGPT_PLAN_MESSAGES['signed-out']
          : IDLE_MESSAGES[this.idle.reason],
    });
  }

  private async signInOnce(signal: AbortSignal): Promise<void> {
    const { keys, callback } = this.deps;
    if (!keys.availability()) {
      throw new KeyStoreUnavailable();
    }
    const agentHostId = `urn:uuid:${await this.deps.installationId()}`;
    const pkce = createPkce();
    const state = randomToken();
    const nonce = randomToken();
    const session = await callback.begin(state, signal);
    try {
      const redirectUri = `http://127.0.0.1:${String(session.port)}/callback`;
      const url = this.client.authorizeUrl({
        agentHostId,
        redirectUri,
        state,
        nonce,
        codeChallenge: pkce.challenge,
      });
      // Only OpenAI's authorization page is ever opened.
      if (!url.startsWith(`${this.client.issuer}/`)) throw new NexarError('INTERNAL_ERROR', FIXED);
      await this.deps.openExternal(url);
      const outcome = await abortable(session.result, signal);
      if ('error' in outcome) {
        throw new SignInFailure(
          outcome.error === 'denied' || outcome.error === 'timeout' ? outcome.error : 'failed',
        );
      }
      const tokens = await this.client.exchangeCode({
        code: outcome.code,
        codeVerifier: pkce.verifier,
        redirectUri,
        clientId: outcome.clientId,
        signal,
      });
      const { sub } = await this.client.verifyIdToken({
        idToken: tokens.idToken,
        clientId: outcome.clientId,
        nonce,
      });
      if (signal.aborted) throw cancelled();
      await this.locked(() =>
        this.store({
          v: 1,
          accessToken: tokens.accessToken,
          refreshToken: tokens.refreshToken,
          expiresAt: this.now() + tokens.expiresInSeconds * 1000,
          clientId: outcome.clientId,
          sub,
          idToken: tokens.idToken,
          scope: tokens.scope,
        }),
      );
      this.deps.logger.info('chatgpt-plan.connected', { planSharing: tokens.planSharing });
    } finally {
      await session.stop().catch(() => undefined);
    }
  }

  private async refresh(current: StoredConnection): Promise<StoredConnection> {
    let next;
    try {
      next = await this.client.refresh({
        refreshToken: current.refreshToken,
        clientId: current.clientId,
      });
    } catch (error) {
      if (accountFailureReason(error) !== 'grant-rejected') throw error;
      // The grant is gone (refresh token expired or revoked): forget it and ask for a new sign-in.
      this.notifyChanging();
      // The binding is retained even when the grant expires. Do not silently swallow deletion failure.
      if (this.deps.authority !== undefined)
        await this.deps.authority.expirePlanCredentials(this.connectionId);
      else await this.deps.keys.removeBlob(this.credentialScope);
      this.idle = { state: 'signed-out', reason: 'expired' };
      this.deps.logger.warn('chatgpt-plan.expired', {});
      this.notifyChange();
      throw new NexarError('AUTH_REQUIRED', 'The ChatGPT sign-in expired');
    }
    // Publish refreshed credentials only after any supplied identity evidence verifies continuity.
    let idToken = current.idToken;
    if (next.idToken !== undefined) {
      const verified = await this.client.verifyIdToken({
        idToken: next.idToken,
        clientId: current.clientId,
      });
      if (verified.sub !== current.sub)
        throw new NexarError('POLICY_REJECTED', 'ChatGPT account identity does not match');
      idToken = next.idToken;
    }
    const updated: StoredConnection = {
      ...current,
      accessToken: next.accessToken,
      refreshToken: next.refreshToken ?? current.refreshToken,
      expiresAt: this.now() + next.expiresInSeconds * 1000,
      scope: next.scope ?? current.scope,
      idToken,
    };
    const sharingChanged = hasPlanSharing(current.scope) !== hasPlanSharing(updated.scope);
    if (sharingChanged) this.notifyChanging();
    await this.store(updated);
    this.notifyChange();
    return updated;
  }

  private async store(connection: StoredConnection): Promise<void> {
    const bindingText = this.deps.keys.readBlob(this.credentialScope + ':binding');
    const retained =
      bindingText === undefined
        ? this.peek()?.sub
        : Binding.parse(JSON.parse(Buffer.from(bindingText, 'base64url').toString('utf8'))).sub;
    if (retained !== undefined && retained !== connection.sub)
      throw new NexarError('POLICY_REJECTED', 'ChatGPT account identity does not match');
    const encoded = Buffer.from(JSON.stringify(Stored.parse(connection)), 'utf8').toString(
      'base64url',
    );
    const binding = Buffer.from(JSON.stringify({ v: 1, sub: connection.sub })).toString(
      'base64url',
    );
    if (this.deps.authority !== undefined)
      await this.deps.authority.commitPlanCredentials(this.connectionId, encoded, binding);
    else {
      // Standalone service compatibility; production Desktop always supplies the shared authority.
      await this.deps.keys.saveBlob(this.credentialScope + ':binding', binding);
      await this.deps.keys.saveBlob(this.credentialScope, encoded);
    }
  }

  /** The stored connection, `undefined` when none; throws when storage or its content is unusable. */
  private peek(): StoredConnection | undefined {
    const encoded = this.deps.keys.readBlob(this.credentialScope);
    if (encoded === undefined) return undefined;
    try {
      return Stored.parse(JSON.parse(Buffer.from(encoded, 'base64url').toString('utf8')));
    } catch {
      throw new NexarError('AUTH_REQUIRED', 'Desktop credential storage is unavailable');
    }
  }

  private require(): StoredConnection {
    if (this.disconnecting || this.signIn !== undefined || this.disposed)
      throw new NexarError('AUTH_REQUIRED', 'ChatGPT is not connected');
    const stored = this.peek();
    if (stored === undefined) throw new NexarError('AUTH_REQUIRED', 'ChatGPT is not connected');
    return stored;
  }

  private locked<T>(task: () => Promise<T>): Promise<T> {
    const next = this.lock.then(task);
    this.lock = next.catch(() => undefined);
    return next;
  }
}

class KeyStoreUnavailable extends NexarError {
  constructor() {
    super('AUTH_REQUIRED', 'Desktop credential storage is unavailable');
  }
}

class SignInFailure extends Error {
  constructor(readonly reason: ChatGptPlanReason) {
    super(FIXED);
  }
}

function failureReason(error: unknown): ChatGptPlanReason {
  if (error instanceof KeyStoreUnavailable) return 'key-store-unavailable';
  if (error instanceof SignInFailure) return error.reason;
  if (accountFailureReason(error) === 'grant-rejected') return 'denied';
  return 'failed';
}

function requireService(service: ChatGptPlanService | undefined): ChatGptPlanService {
  if (service === undefined) throw new NexarError('AUTH_REQUIRED', FIXED);
  return service;
}

export const chatgptPlanChannels: Readonly<Record<string, ChannelDefinition>> = {
  [CHANNELS.chatgptPlanStatus]: defineChannel(NoArgs, async (_args, { deps }) =>
    ChatGptPlanStatusSchema.parse(await requireService(deps.chatgptPlan).status()),
  ),
  // Starts the sign-in and answers at once (`signing-in`); the renderer polls `status`, which also
  // carries the outcome (an error is recorded there with its fixed reason).
  [CHANNELS.chatgptPlanConnect]: defineChannel(NoArgs, async (_args, { deps }) => {
    const service = requireService(deps.chatgptPlan);
    service.connect().catch(() => undefined);
    return ChatGptPlanStatusSchema.parse(await service.status());
  }),
  [CHANNELS.chatgptPlanCancel]: defineChannel(NoArgs, async (_args, { deps }) =>
    ChatGptPlanStatusSchema.parse(await requireService(deps.chatgptPlan).cancel()),
  ),
  [CHANNELS.chatgptPlanDisconnect]: defineChannel(NoArgs, async (_args, { deps }) =>
    ChatGptPlanStatusSchema.parse(await requireService(deps.chatgptPlan).disconnect()),
  ),
};
