import { randomUUID } from 'node:crypto';
import { userInfo } from 'node:os';
import { dirname, isAbsolute, join, resolve } from 'node:path';
import { app, BrowserWindow, clipboard, dialog, ipcMain, safeStorage, shell } from 'electron';
import {
  BUILTIN_CONNECTIONS,
  NexarError,
  isNexarError,
  type ResourceDescriptor,
} from '@nexar/contracts';
import { createOpenAiAccountClient } from '@nexar/integration-openai-account';
import { BridgeHost, ControlModelGateway } from '@nexar/engine-gateway';
import { FileProjectMemoryStore } from '@nexar/project-memory';
import { FileSessionStore } from '@nexar/sessions';
import {
  checkProviderCredential,
  createControlModelTurnPorts,
  createNativeSubscriptions,
  createNativeModelInventories,
  engineAllocator,
} from '@nexar/host';
import { SESSION_EVENT_CHANNEL, TASK_EVENT_CHANNEL } from '../shared/channels.js';
import { createBridge } from './bridge.js';
import { CodePlane } from './code-plane.js';
import { ControlGatewayChild } from './control-gateway-child.js';
import { DshCoworkService, type CoworkLane } from './dsh-cowork.js';
import { WslCoworkBackend } from './wsl-cowork.js';
import { loadCoworkInputs } from './cowork-inputs.js';
import { boundedCoworkExecutor } from './cowork-executor.js';
import { ConfigStore } from './config-store.js';
import { createEngineHost, type EngineHost } from './engine-host.js';
import { DesktopKeyStore } from './desktop-key-store.js';
import { ConnectionManager } from './connection-manager.js';
import { ConnectionRuntime } from './connection-runtime.js';
import { ChatGptPlanService } from './chatgpt-plan.js';
import { chatGptPlanInventoryDefinition } from './chatgpt-plan-resources.js';
import { ProviderInventoryService } from './provider-inventory.js';
import { chatGptTestHooks } from './chatgpt-test-hooks.js';
import { installationId } from './installation-id.js';
import { ProviderService } from './providers.js';
import { SigninCallbackSupervisor } from './signin-callback-child.js';
import { SubscriptionService } from './subscriptions.js';
import { LocalEndpointService } from './local-endpoints.js';
import { createStderrLogger } from './logger.js';
import {
  createScriptLauncher,
  createWslLauncher,
  disabledPlaneLauncher,
  type PlaneLauncher,
} from './plane-connection.js';
import { ensurePrivateStateDirectory, PrivateStateError } from './private-state.js';
import { SettingsStore } from './settings-store.js';
import { holdQuitUntil } from './shutdown.js';
import { newTask } from './tasks.js';
import {
  bundlePaths,
  createMainWindow,
  hardenSession,
  installWebContentsLockdown,
  isTrustedFrameUrl,
} from './window.js';

// Per-user state lives in `<appData>/Nexar` (%APPDATA%\Nexar on Windows, ADR-021 §4). Tests point
// the app at a throwaway directory instead. Both must happen before `ready`.
app.setName('Nexar');
const userDataOverride = process.env['NEXAR_DESKTOP_USER_DATA'];
const userDataPath =
  userDataOverride !== undefined && userDataOverride !== ''
    ? resolve(userDataOverride)
    : join(app.getPath('appData'), 'Nexar');
app.setPath('userData', userDataPath);
// Chromium's runtime data (disk caches, storage, crash dumps) is not Nexar state and grows without
// bound. Keeping it outside the ACL-guarded state tree keeps the per-entry guard small and fast;
// on Windows it lives in the owner-private %LOCALAPPDATA%, next to a test override otherwise.
const localAppData = process.env['LOCALAPPDATA'];
const runtimePath =
  userDataOverride !== undefined && userDataOverride !== ''
    ? `${userDataPath}.runtime`
    : process.platform === 'win32' && localAppData !== undefined && localAppData !== ''
      ? join(localAppData, 'Nexar', 'Runtime')
      : join(app.getPath('appData'), 'Nexar Runtime');
app.setPath('sessionData', runtimePath);
app.setPath('crashDumps', join(runtimePath, 'Crashpad'));

/** Upper bound on ending the lanes' children and releasing the sessions lease at quit. */
const QUIT_CLEANUP_BOUND_MS = 15_000;

function decider(): string {
  try {
    return `desktop:${userInfo().username}`;
  } catch {
    return 'desktop:unknown';
  }
}

/** Startup phase timings on stderr when tracing is requested (tests); phase names and ms only. */
const traceStartup =
  process.env['NEXAR_DESKTOP_STARTUP_TRACE'] === '1'
    ? (() => {
        const began = Date.now();
        return (phase: string): void => {
          process.stderr.write(`nexar-desktop: startup ${phase} ${String(Date.now() - began)}ms\n`);
        };
      })()
    : (): void => undefined;

async function start(): Promise<void> {
  const userData = app.getPath('userData');
  traceStartup('begin');
  await ensurePrivateStateDirectory(userData, { forbiddenPaths: [app.getPath('appData')] });
  traceStartup('state-guard');
  await app.whenReady();
  traceStartup('ready');
  hardenSession();
  installWebContentsLockdown();

  const logger = createStderrLogger();
  const config = new ConfigStore(join(userData, 'nexar.config.json'), logger);
  await config.ensure();
  const settings = new SettingsStore(join(userData, 'desktop-settings.json'));
  // The existing per-profile writer lease also protects connection authority across Desktop instances.
  const sessionStore = new FileSessionStore(join(userData, '.nexar', 'sessions'));
  let sessions: FileSessionStore | undefined;
  try {
    const { interruptedTurns } = await sessionStore.acquireLease();
    sessions = sessionStore;
    if (interruptedTurns > 0) logger.info('marked running turns interrupted', { interruptedTurns });
  } catch (error) {
    if (!isNexarError(error) || error.code !== 'CONFLICT') throw error;
    logger.warn('sessions are open in another Nexar process', { code: error.code });
  }
  // The installed app's catalogs are shipped beside app.asar, outside the workspace layout.
  // Keep owner-declared catalog overrides; only supply packaged defaults for missing values.
  const engineEnv = { ...process.env };
  if (app.isPackaged) {
    if (!engineEnv['NEXAR_WORKFLOWS_DIR']) {
      engineEnv['NEXAR_WORKFLOWS_DIR'] = join(process.resourcesPath, 'workflows');
    }
    if (!engineEnv['NEXAR_ENGINEERING_PLANS_DIR']) {
      engineEnv['NEXAR_ENGINEERING_PLANS_DIR'] = join(
        process.resourcesPath,
        'engineering',
        'plans',
      );
    }
  }
  const keys = new DesktopKeyStore({ userData, encryption: safeStorage });
  traceStartup('stores');
  const underTestOverride = userDataOverride !== undefined && userDataOverride !== '';
  // The ChatGPT plan connection (ADR-022 amendment 2026-10-05): sign-ins start only from the owner's click;
  // the loopback callback lives in a per-sign-in child, never in this process. Its resources are
  // republished (a recomposition) whenever the connection appears or disappears.
  const planTest = chatGptTestHooks(process.env, underTestOverride);
  const engineRef: { current?: EngineHost } = {};
  const providersRef: { current?: ProviderService } = {};
  const inventoryRef: { current?: ProviderInventoryService } = {};
  const previousConnections = new Map<string, string>();
  const connectionManager: ConnectionManager = new ConnectionManager({
    settingsStore: settings,
    keyStore: keys,
    isWriter: () => sessionStore.holdsLease(),
    affectedPins: (record) => {
      const current = engineRef.current;
      if (current === undefined)
        throw new NexarError('RESOURCE_UNAVAILABLE', 'Connection management is not ready');
      return connectionRuntime.effects(record, settings, current);
    },
    onChange: async () => {
      for (const record of await connectionManager.listConnections()) {
        const version = `${record.credentialGeneration}:${record.lifecycleState}`;
        if (previousConnections.get(record.id) !== version) {
          inventoryRef.current?.invalidateConnection(record.id);
          if (record.builtIn) providersRef.current?.invalidate(record.provider);
        }
        previousConnections.set(record.id, version);
      }
      const plan = await connectionManager.currentPlan();
      inventoryRef.current?.rebindConnection('chatgpt-plan', plan.id);
      await engineRef.current?.reload();
    },
  });
  await connectionManager.initialize();
  for (const record of await connectionManager.listConnections())
    previousConnections.set(record.id, `${record.credentialGeneration}:${record.lifecycleState}`);
  const connectionRuntime: ConnectionRuntime = new ConnectionRuntime(connectionManager);
  const chatgptPlan = new ChatGptPlanService({
    keys,
    authority: connectionManager,
    callback: new SigninCallbackSupervisor(),
    openExternal: planTest?.openExternal ?? ((url) => shell.openExternal(url)),
    installationId: () => installationId(userData),
    logger,
    ...(planTest === undefined
      ? {}
      : { client: createOpenAiAccountClient({ issuer: planTest.issuer }) }),
    onChanging: () => inventoryRef.current?.invalidate('chatgpt-plan'),
    onChange: () => {
      const inventory = inventoryRef.current;
      if (inventory !== undefined) void inventory.refresh('chatgpt-plan').catch(() => undefined);
    },
  });
  app.on('before-quit', () => chatgptPlan.dispose());
  const providerInventory = new ProviderInventoryService({
    definitions: [
      ...createNativeModelInventories({ env: engineEnv, privateDirectory: userData }),
      chatGptPlanInventoryDefinition(
        chatgptPlan,
        planTest?.responsesFetch === undefined ? {} : { fetch: planTest.responsesFetch },
      ),
    ],
    cachePath: join(userData, 'provider-model-inventory.json'),
    logger,
    onChange: () => engineRef.current?.reload() ?? Promise.resolve(),
    acquire: async (identity) =>
      identity.routeId === 'openai.responses.account'
        ? connectionManager.acquirePlanOperation(
            (await connectionManager.currentPlan()).id,
            'refresh',
          )
        : connectionManager.acquireExecution(identity.connectionId),
  });
  inventoryRef.current = providerInventory;
  providerInventory.rebindConnection('chatgpt-plan', (await connectionManager.currentPlan()).id);
  await providerInventory.restore();
  app.on('before-quit', () => providerInventory.dispose());
  // The token seam reaches the pi adapter and the control ports here only; the CLI and the plane get none.
  const planConnections = {
    isPlanModelAvailable: (descriptor: ResourceDescriptor) => {
      try {
        connectionManager.validateResource(descriptor);
      } catch {
        return false;
      }
      const connection = descriptor.metadata?.['connection'] as { id?: string } | undefined;
      return (
        (connection?.id !== undefined &&
          connectionManager.getActiveExecutionCount(connection.id) > 0) ||
        providerInventory.isModelAvailable('chatgpt-plan', descriptor)
      );
    },
    onPlanModelRejected: (descriptor: ResourceDescriptor) =>
      providerInventory.rejectResource(descriptor),
    resolve: async (
      descriptor: ResourceDescriptor,
      signal: AbortSignal,
      options?: { readonly refresh?: boolean },
    ) => {
      connectionManager.validateResource(descriptor);
      const current = await connectionManager.currentPlan();
      if ((descriptor.metadata?.['connection'] as { id?: string } | undefined)?.id !== current.id)
        throw new NexarError('AUTH_REQUIRED', 'The Plan connection is unavailable');
      const generation = providerInventory.snapshot('chatgpt-plan').generation;
      const token = await chatgptPlan.accessToken(
        options?.refresh === true ? { refresh: true } : {},
      );
      if (signal.aborted) throw new NexarError('EXECUTION_CANCELLED', 'Execution was cancelled');
      if (
        (generation !== providerInventory.snapshot('chatgpt-plan').generation ||
          !providerInventory.isModelAvailable('chatgpt-plan', descriptor)) &&
        connectionManager.getActiveExecutionCount(current.id) === 0
      ) {
        throw new NexarError('RESOURCE_UNAVAILABLE', 'Model inventory is not current', {
          retryable: false,
        });
      }
      return token;
    },
    ...(planTest?.responsesFetch === undefined ? {} : { fetch: planTest.responsesFetch }),
  };
  const engine = await createEngineHost({
    configPath: config.path,
    env: engineEnv,
    logger,
    resolveSecret: keys.resolveSecret,
    connections: planConnections,
    extraResources: async () => {
      const api = await connectionRuntime.descriptors();
      const plan = await connectionManager.currentPlan();
      const other = providerInventory
        .descriptors()
        .map((descriptor) => {
          if (
            (descriptor.metadata?.['connection'] as { id?: string } | undefined)?.id !==
            'openai.chatgpt-plan'
          )
            return descriptor;
          return {
            ...descriptor,
            metadata: {
              ...descriptor.metadata,
              connection: {
                id: plan.id,
                provider: plan.provider,
                method: plan.method,
                authClass: plan.authClass,
                support: plan.support,
              },
              connectionHost: plan.machine,
              connectionGeneration: plan.credentialGeneration,
            },
          };
        })
        .filter((descriptor) => connectionManager.isAvailable(descriptor));
      connectionRuntime.remember(other);
      return [...other, ...api];
    },
    inventoryGuard: connectionRuntime.guard({
      isAvailable: (descriptor) => providerInventory.isAvailable(descriptor),
      onModelRejected: (descriptor) => providerInventory.rejectResource(descriptor),
    }),
    trace: traceStartup,
  });
  engineRef.current = engine;
  // Existing credentials may refresh metadata; this never starts browser sign-in.
  // Test launches without a fake provider must not contact a real vendor.
  if (!underTestOverride || planTest?.responsesFetch !== undefined) {
    void providerInventory.refresh('chatgpt-plan').catch(() => undefined);
  }
  const inventoryTimer = setInterval(() => {
    if (!underTestOverride || planTest?.responsesFetch !== undefined) {
      void providerInventory.refresh('chatgpt-plan').catch(() => undefined);
    }
  }, 5 * 60_000);
  inventoryTimer.unref();
  app.on('before-quit', () => clearInterval(inventoryTimer));
  const providers = new ProviderService({
    keys,
    authority: connectionManager,
    clipboard,
    config,
    engine,
    checkKey: (provider) =>
      checkProviderCredential(provider, { resolveSecret: keys.resolveSecret }),
  });
  providersRef.current = providers;
  const subscriptions = new SubscriptionService(
    createNativeSubscriptions({ env: engineEnv, cwd: app.getPath('home') }),
    (runtime) => providerInventory.invalidate(runtime),
    {
      login: (runtime) =>
        connectionManager.acquireAuthentication(
          Object.values(BUILTIN_CONNECTIONS).find(
            (def) =>
              def.credentialScope.kind === 'native-home' &&
              def.credentialScope.runtimeId === runtime,
          )?.id ?? '',
        ),
      probe: (runtime) =>
        connectionManager.acquireExecution(
          Object.values(BUILTIN_CONNECTIONS).find(
            (def) =>
              def.credentialScope.kind === 'native-home' &&
              def.credentialScope.runtimeId === runtime,
          )?.id ?? '',
        ),
    },
  );
  app.on('before-quit', () => subscriptions.dispose());

  // Operating Sessions (ADR-024): this process is the single writer. If another Nexar process holds
  // the lease, sessions stay unavailable (every session channel answers CONFLICT) instead of racing it.
  traceStartup('engine');
  traceStartup('sessions');
  // Project memory (ADR-030 §7): owner-confirmed knowledge, written only while this process holds the
  // sessions lease (single writer), read into every turn's required context.
  const projectMemory = new FileProjectMemoryStore({
    stateDir: join(userData, '.nexar'),
    isWriter: () => sessionStore.holdsLease(),
  });
  // The Code lane (ADR-025): Desktop reaches the WSL2 engineering plane through `wsl.exe`. Under the
  // test-only `NEXAR_DESKTOP_USER_DATA` override the real WSL is never touched: the lane uses the
  // fake plane named by `NEXAR_DESKTOP_TEST_PLANE`, or is simply unavailable. Neither variable is
  // ever set in production.
  const testPlane = process.env['NEXAR_DESKTOP_TEST_PLANE'];
  let planeLauncher: PlaneLauncher = createWslLauncher();
  if (userDataOverride !== undefined && userDataOverride !== '') {
    planeLauncher =
      testPlane !== undefined && isAbsolute(testPlane)
        ? createScriptLauncher(testPlane)
        : disabledPlaneLauncher;
  }
  const codePlane = new CodePlane({
    settings,
    launcher: planeLauncher,
    logger,
    decider: decider(),
  });
  // Non-blocking: the lane reports "still being checked" until the first probe finishes.
  void codePlane.refresh();

  // The Cowork lane (ADR-030): one private DeepSeek Harness child per turn, bound to the NRC through
  // the Control Model Gateway. Under the test-only `NEXAR_DESKTOP_USER_DATA` override it is never
  // launched unless the entry named by `NEXAR_DESKTOP_TEST_DSH_ENTRY` is given. Neither variable is
  // ever set in production.
  const testDshEntry = process.env['NEXAR_DESKTOP_TEST_DSH_ENTRY'];
  const dshTestEntry =
    underTestOverride && testDshEntry !== undefined && isAbsolute(testDshEntry)
      ? testDshEntry
      : undefined;
  // The packaged E2E names no entry: it opts the app's own bundled runtime in with this flag (only
  // honoured in a packaged app under the override), so the runtime is found as in production.
  const dshPackagedUnderTest =
    underTestOverride &&
    app.isPackaged &&
    process.env['NEXAR_DESKTOP_TEST_DSH_RUNTIME'] === 'packaged';
  const localCoworkFixture =
    underTestOverride &&
    process.env['NEXAR_DESKTOP_TEST_LOCAL_COWORK'] === '1' &&
    process.env['NEXAR_DESKTOP_TEST_WSL_COWORK'] !== '1';
  // The Intelligence Bridge endpoint (ADR-027 §9a): a per-launch local pipe/socket, never a port.
  // Started lazily with the first grant (NXR-059 part b: `ensureStarted()`), so no pipe or socket
  // exists unless delegation is used. Stopped at quit.
  const coworkRef: { current?: CoworkLane } = {};
  const bridgeHostRef: { current?: BridgeHost } = {};
  // The Control Model Gateway (ADR-027 §7A) behind the host's `control` op: pi resources only, over the
  // engine's current registry snapshot and routing policy (read per call, so a config reload is picked up).
  const controlPorts = createControlModelTurnPorts(
    { env: engineEnv, cwd: dirname(config.path) },
    {
      resolveSecret: keys.resolveSecret,
      connections: planConnections,
      validateResource: (descriptor) => connectionManager.validateResource(descriptor),
    },
  );
  const controlGateway = new ControlModelGateway({
    admit: (descriptor) => connectionManager.acquireResource(descriptor),
    validatePin: (id) => connectionRuntime.validatePin(id),
    ports: controlPorts,
    candidates: () => engine.composition().runtime.registry.snapshot(),
    policy: {
      get name() {
        return engine.composition().runtime.policy.name;
      },
      get version() {
        return engine.composition().runtime.policy.version;
      },
      evaluate: (input) => engine.composition().runtime.policy.evaluate(input),
    },
    clock: () => new Date(),
    newId: randomUUID,
    logger,
    // controlFailed of a grant reads these (the host is created right after).
    telemetry: { emit: (event) => engine.composition().runtime.telemetry?.emit(event) },
    onEvent: (event) => bridgeHostRef.current?.noteControlEvent(event),
  });
  const bridgeHost = new BridgeHost({
    gateway: controlGateway,
    allocator: engineAllocator(engine),
    executor: boundedCoworkExecutor(engine),
    clock: () => new Date(),
    newId: randomUUID,
    logger,
    runtimeDir: join(runtimePath, 'bridge'),
    // Delegated units of a Cowork turn are recorded on its result (ids and enums only).
    onEvent: (event) => coworkRef.current?.noteBridgeEvent(event),
  });
  bridgeHostRef.current = bridgeHost;
  // The loopback Chat Completions translator child (ADR-027 section 7A): created here, started on first
  // need (a Cowork turn on the gateway path asks for its `baseUrl()`), ended at quit.
  const controlGatewayChild = new ControlGatewayChild({
    endpoint: () => bridgeHost.ensureStarted(),
    logger,
  });
  const cowork = new DshCoworkService({
    // The host-local path is available only to explicit offline fixture runs.
    ...(!localCoworkFixture
      ? {
          backend: new WslCoworkBackend(settings),
          approvedInputs: (request) => loadCoworkInputs(engine, sessions, request),
        }
      : {}),
    bridgeHost,
    controlGateway,
    controlChild: controlGatewayChild,
    settings,
    engine,
    logger,
    stateDir: join(runtimePath, 'dsh-cowork'),
    disabled: localCoworkFixture && dshTestEntry === undefined && !dshPackagedUnderTest,
    testEntry: dshTestEntry,
    ...(app.isPackaged
      ? { resourcesPath: process.resourcesPath }
      : { devEntry: process.env['NEXAR_DSH_ENTRY'] }),
    createTask: (request, excludedResourceIds) =>
      newTask(
        engine,
        {
          projectId: request.projectId,
          kind: request.kind,
          prompt: request.prompt,
          preferredResourceIds: request.preferredResourceIds,
          maxCostUsd: request.maxCostUsd,
          excludedResourceIds,
        },
        request.turnId,
        { sessionId: request.sessionId, turnId: request.turnId },
      ),
  });
  coworkRef.current = cowork;
  // Quitting ends the lanes' children (a plane run, a running Cowork turn) as soon as it
  // begins, and the exit waits (bounded) for that before the sessions lease is given back (best
  // effort, so the next launch needs no stale recovery). Exiting first left a supervised server
  // running behind the closed app.
  let lanesStopped: Promise<unknown> | undefined;
  app.on('before-quit', () => {
    if (lanesStopped !== undefined) return;
    codePlane.dispose();
    lanesStopped = cowork.dispose();
  });
  holdQuitUntil(
    app,
    async () => {
      await lanesStopped?.catch(() => undefined);
      await providerInventory.flush();
      await controlGatewayChild.stop();
      await bridgeHost.stop();
      if (sessions !== undefined) await sessionStore.releaseLease();
    },
    QUIT_CLEANUP_BOUND_MS,
  );
  void cowork.warm();
  const bridge = createBridge({
    engine,
    config,
    settings,
    providers,
    subscriptions,
    chatgptPlan,
    connectionManager,
    providerInventory,
    localEndpoints: new LocalEndpointService(config, engine),
    logger,
    // Looked up per call, so a test can replace `dialog.showOpenDialog`.
    dialog: { showOpenDialog: (options) => dialog.showOpenDialog(options) },
    shell,
    appInfo: { version: app.getVersion(), platform: process.platform },
    decider: decider(),
    sessions,
    projectMemory,
    codePlane,
    cowork,
    // A turn outlives the call that started it; every live window hears about it.
    broadcastSession: (event) => {
      for (const window of BrowserWindow.getAllWindows()) {
        if (!window.isDestroyed() && !window.webContents.isDestroyed()) {
          window.webContents.send(SESSION_EVENT_CHANNEL, event);
        }
      }
    },
  });

  const paths = bundlePaths(import.meta.url);
  let main: BrowserWindow | undefined;

  for (const channel of Object.keys(bridge.table)) {
    ipcMain.handle(channel, (event, args: unknown) => {
      // Only the app's own page, in the main window, may use the bridge.
      if (
        main === undefined ||
        event.sender !== main.webContents ||
        !isTrustedFrameUrl(event.senderFrame?.url, paths.rendererIndex)
      ) {
        return {
          ok: false,
          error: { code: 'POLICY_REJECTED', message: 'Request not accepted from this sender' },
        };
      }
      return bridge.invoke(channel, args, (taskEvent) => {
        if (!event.sender.isDestroyed()) event.sender.send(TASK_EVENT_CHANNEL, taskEvent);
      });
    });
  }

  main = createMainWindow(paths);
  traceStartup('window');
  main.on('closed', () => {
    main = undefined;
  });
}

app.on('window-all-closed', () => {
  app.quit();
});

start().catch((error: unknown) => {
  // Startup failures (a broken config, say) are reported without paths or stacks; a state
  // guard failure adds only its fixed category, phase, exit code and duration.
  const name = error instanceof Error ? error.name : 'unknown error';
  const detail = error instanceof PrivateStateError ? ` ${JSON.stringify(error.diagnostic)}` : '';
  process.stderr.write(`nexar-desktop: startup failed: ${name}${detail}\n`);
  app.exit(1);
});
