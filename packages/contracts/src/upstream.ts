import { NexarError } from './errors.js';

/** Upstream update lifecycle states (ADR-029/ADR-030). Version/artifact scoped. */
export type UpstreamUpdateState =
  'AVAILABLE' | 'EVALUATED' | 'APPROVED' | 'INSTALLED' | 'VERIFIED' | 'ROLLED_BACK';

export type UpstreamRole = 'architecture-reference' | 'runtime-dependency';
export type UpstreamDiscoveryAdapterKind = 'git-tags' | 'npm-registry';
export type UpstreamReleaseChannel = 'stable' | 'prerelease' | 'all';
export type UpstreamCompatibilityState = 'COMPATIBLE' | 'EVALUATED' | 'INCOMPATIBLE' | 'UNKNOWN';

export interface UpstreamApprovedEvidence {
  readonly milestone: string;
  readonly verifier: string;
  readonly verdict: string;
  readonly approvedCommit?: string;
  readonly approvedDate: string;
  readonly notes?: string;
}

export interface UpstreamEntry {
  readonly upstreamId: string;
  readonly projectName: string;
  readonly officialRepository: string;
  readonly role: UpstreamRole;
  readonly discoveryAdapterKind: UpstreamDiscoveryAdapterKind;
  readonly allowedReleaseChannel: UpstreamReleaseChannel;
  readonly approvedSourceReference: string;
  readonly currentRuntimePin: string | null;
  readonly lastEvaluatedReference: string | null;
  readonly compatibilityState: UpstreamCompatibilityState;
  readonly adrs: readonly string[];
  readonly lastApprovedEvidence: UpstreamApprovedEvidence;
}

export interface UpstreamManifest {
  readonly schemaVersion: string;
  readonly generatedAt: string;
  readonly upstreams: readonly UpstreamEntry[];
}

export interface UpstreamTransitionEvent {
  readonly from: UpstreamUpdateState | null;
  readonly to: UpstreamUpdateState;
  readonly at: string;
  readonly evidence?: Readonly<Record<string, unknown>>;
  readonly reason?: string;
}

export interface UpstreamUpdateRecord {
  readonly upstreamId: string;
  readonly version: string;
  readonly releaseChannel: 'stable' | 'prerelease' | 'alpha-nightly';
  readonly state: UpstreamUpdateState;
  readonly observedAt: string;
  readonly artifactIntegrity?: string;
  readonly history: readonly UpstreamTransitionEvent[];
}

export interface UpstreamUpdateObservation {
  readonly upstreamId: string;
  readonly version: string;
  readonly releaseChannel: 'stable' | 'prerelease' | 'alpha-nightly';
  readonly artifactIntegrity?: string;
  readonly observedAt: string;
  readonly commitSha?: string;
}

const SECRET_SUBSTRINGS = ['token', 'secret', 'key', 'password', 'credential', 'auth', 'bearer'];

function isForbiddenSecretKey(key: string): boolean {
  const clean = key.toLowerCase().replace(/[^a-z0-9]/g, '');
  // Ignore standard non-secret fields that might contain substring like 'key' if any
  // Note: upstreamId, projectName, etc. do not contain 'key', 'token', etc.
  return SECRET_SUBSTRINGS.some((sub) => clean.includes(sub));
}

const FLOATING_DIST_TAGS = new Set(['latest', 'next', 'canary', 'beta', 'nightly', 'alpha', 'dev']);

/** Classifies a semantic version into stable, prerelease, or alpha-nightly. */
export function classifyReleaseChannel(version: string): 'stable' | 'prerelease' | 'alpha-nightly' {
  if (typeof version !== 'string' || !version.trim()) {
    throw new NexarError('VALIDATION_ERROR', 'Invalid release version string');
  }
  const clean = version.trim().toLowerCase();
  if (
    clean.includes('alpha') ||
    clean.includes('nightly') ||
    clean.includes('canary') ||
    clean.includes('dev') ||
    clean.includes('snapshot')
  ) {
    return 'alpha-nightly';
  }
  if (
    clean.includes('-') ||
    clean.includes('rc') ||
    clean.includes('beta') ||
    clean.includes('preview')
  ) {
    return 'prerelease';
  }
  if (/^v?\d+\.\d+\.\d+$/.test(clean)) {
    return 'stable';
  }
  return 'prerelease';
}

/** Determines if a version belongs to an allowed release channel. */
export function isChannelAllowed(version: string, allowedChannel: UpstreamReleaseChannel): boolean {
  if (allowedChannel === 'all') return true;
  const channel = classifyReleaseChannel(version);
  if (allowedChannel === 'stable') return channel === 'stable';
  if (allowedChannel === 'prerelease') {
    return channel === 'stable' || channel === 'prerelease';
  }
  return false;
}

/** Returns true if a tag string represents a mutable floating dist-tag rather than an immutable pin. */
export function isFloatingDistTag(tag: string): boolean {
  if (typeof tag !== 'string' || !tag.trim()) return true;
  const lower = tag.trim().toLowerCase();
  // If package spec like @scope/pkg@1.2.3 or pkg@1.2.3, extract version part
  const atIdx = lower.lastIndexOf('@');
  const versionPart = atIdx > 0 ? lower.slice(atIdx + 1) : lower;
  if (FLOATING_DIST_TAGS.has(versionPart)) return true;
  if (versionPart.startsWith('^') || versionPart.startsWith('~') || versionPart.includes('*')) {
    return true;
  }
  return !/^\d+\.\d+\.\d+/.test(versionPart.replace(/^v/, ''));
}

/** Normalizes a raw observation into a clean UpstreamUpdateObservation. */
export function normalizeObservation(
  raw: unknown,
  fallbackNow: () => string = () => new Date().toISOString(),
): UpstreamUpdateObservation {
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) {
    throw new NexarError('VALIDATION_ERROR', 'Observation must be an object');
  }
  const obj = raw as Record<string, unknown>;

  // Scan for secret or credential leakage
  for (const key of Object.keys(obj)) {
    if (isForbiddenSecretKey(key)) {
      throw new NexarError('VALIDATION_ERROR', `Forbidden secret key in observation: ${key}`);
    }
  }

  const upstreamId = obj['upstreamId'];
  const version = obj['version'];
  if (typeof upstreamId !== 'string' || !upstreamId.trim()) {
    throw new NexarError('VALIDATION_ERROR', 'Missing or invalid upstreamId in observation');
  }
  if (typeof version !== 'string' || !version.trim()) {
    throw new NexarError('VALIDATION_ERROR', 'Missing or invalid version in observation');
  }

  const releaseChannel = classifyReleaseChannel(version);
  const observedAt =
    typeof obj['observedAt'] === 'string' && obj['observedAt'].trim()
      ? obj['observedAt'].trim()
      : fallbackNow();

  const artifactIntegrity =
    typeof obj['artifactIntegrity'] === 'string' && obj['artifactIntegrity'].trim()
      ? obj['artifactIntegrity'].trim()
      : undefined;

  const commitSha =
    typeof obj['commitSha'] === 'string' && obj['commitSha'].trim()
      ? obj['commitSha'].trim()
      : undefined;

  return Object.freeze({
    upstreamId: upstreamId.trim(),
    version: version.trim(),
    releaseChannel,
    ...(artifactIntegrity ? { artifactIntegrity } : {}),
    observedAt,
    ...(commitSha ? { commitSha } : {}),
  });
}

/** Detects if the artifact integrity has changed under the exact same version string (retagging attack/drift). */
export function detectIntegrityDrift(
  existing: UpstreamUpdateRecord,
  observation: UpstreamUpdateObservation,
): boolean {
  if (existing.upstreamId !== observation.upstreamId || existing.version !== observation.version) {
    return false;
  }
  if (existing.artifactIntegrity && observation.artifactIntegrity) {
    return existing.artifactIntegrity !== observation.artifactIntegrity;
  }
  return false;
}

/** Creates a fresh update record in AVAILABLE state with initial event history. */
export function createUpdateRecord(
  observation: UpstreamUpdateObservation,
  initialState: UpstreamUpdateState = 'AVAILABLE',
): UpstreamUpdateRecord {
  const initialEvent: UpstreamTransitionEvent = {
    from: null,
    to: initialState,
    at: observation.observedAt,
    reason: 'Initial release observation',
  };

  return Object.freeze({
    upstreamId: observation.upstreamId,
    version: observation.version,
    releaseChannel: observation.releaseChannel,
    state: initialState,
    observedAt: observation.observedAt,
    ...(observation.artifactIntegrity ? { artifactIntegrity: observation.artifactIntegrity } : {}),
    history: Object.freeze([initialEvent]),
  });
}

const ALLOWED_TRANSITIONS: Readonly<Record<UpstreamUpdateState, readonly UpstreamUpdateState[]>> = {
  AVAILABLE: ['EVALUATED'],
  EVALUATED: ['APPROVED'],
  APPROVED: ['INSTALLED'],
  INSTALLED: ['VERIFIED', 'ROLLED_BACK'],
  VERIFIED: ['ROLLED_BACK'],
  ROLLED_BACK: [],
};

/** Executes a deterministic, valid transition on an UpstreamUpdateRecord. Never mutates historical records. */
export function transitionUpdateState(
  current: UpstreamUpdateRecord,
  nextState: UpstreamUpdateState,
  options: {
    readonly at?: string;
    readonly evidence?: Readonly<Record<string, unknown>>;
    readonly reason?: string;
  } = {},
): UpstreamUpdateRecord {
  const allowed = ALLOWED_TRANSITIONS[current.state];
  if (!allowed.includes(nextState)) {
    throw new NexarError(
      'VALIDATION_ERROR',
      `Invalid upstream update transition from ${current.state} to ${nextState}`,
      { details: { from: current.state, to: nextState } },
    );
  }

  // Transitions to APPROVED must provide non-empty evaluation evidence
  if (nextState === 'APPROVED') {
    if (!options.evidence || Object.keys(options.evidence).length === 0) {
      throw new NexarError('VALIDATION_ERROR', 'Approval requires valid evaluation evidence');
    }
  }

  // Transitions to VERIFIED must provide runtime verification evidence
  if (nextState === 'VERIFIED') {
    if (!options.evidence || Object.keys(options.evidence).length === 0) {
      throw new NexarError(
        'VALIDATION_ERROR',
        'Verification requires runtime verification evidence',
      );
    }
  }

  const at = options.at ?? new Date().toISOString();
  const transitionEvent: UpstreamTransitionEvent = {
    from: current.state,
    to: nextState,
    at,
    ...(options.evidence ? { evidence: Object.freeze({ ...options.evidence }) } : {}),
    ...(options.reason ? { reason: options.reason } : {}),
  };

  return Object.freeze({
    ...current,
    state: nextState,
    history: Object.freeze([...current.history, Object.freeze(transitionEvent)]),
  });
}

/** Validates and parses a reviewed upstream manifest (config/upstreams.json). */
export function validateUpstreamManifest(raw: unknown): UpstreamManifest {
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) {
    throw new NexarError('VALIDATION_ERROR', 'Upstream manifest must be an object');
  }
  const m = raw as Record<string, unknown>;

  if (typeof m['schemaVersion'] !== 'string' || !m['schemaVersion'].trim()) {
    throw new NexarError('VALIDATION_ERROR', 'Missing schemaVersion in upstream manifest');
  }
  if (!Array.isArray(m['upstreams'])) {
    throw new NexarError('VALIDATION_ERROR', 'Manifest upstreams must be an array');
  }

  const validatedUpstreams: UpstreamEntry[] = [];

  for (const entry of m['upstreams']) {
    if (typeof entry !== 'object' || entry === null || Array.isArray(entry)) {
      throw new NexarError('VALIDATION_ERROR', 'Each upstream entry must be an object');
    }
    const e = entry as Record<string, unknown>;

    // Scan for secrets in manifest
    for (const k of Object.keys(e)) {
      if (isForbiddenSecretKey(k)) {
        throw new NexarError('VALIDATION_ERROR', `Forbidden secret key in upstream entry: ${k}`);
      }
    }

    const upstreamId = e['upstreamId'];
    const projectName = e['projectName'];
    const officialRepository = e['officialRepository'];
    const role = e['role'];
    const discoveryAdapterKind = e['discoveryAdapterKind'];
    const allowedReleaseChannel = e['allowedReleaseChannel'];
    const approvedSourceReference = e['approvedSourceReference'];
    const currentRuntimePin = e['currentRuntimePin'];
    const lastEvaluatedReference = e['lastEvaluatedReference'];
    const compatibilityState = e['compatibilityState'];
    const adrs = e['adrs'];
    const lastApprovedEvidence = e['lastApprovedEvidence'];

    if (typeof upstreamId !== 'string' || !upstreamId.trim()) {
      throw new NexarError('VALIDATION_ERROR', 'Missing upstreamId in manifest entry');
    }
    if (typeof projectName !== 'string' || !projectName.trim()) {
      throw new NexarError('VALIDATION_ERROR', 'Missing projectName in manifest entry');
    }
    if (
      typeof officialRepository !== 'string' ||
      !officialRepository.startsWith('https://github.com/')
    ) {
      throw new NexarError(
        'VALIDATION_ERROR',
        'officialRepository must be an official https://github.com/ URL',
      );
    }
    if (role !== 'architecture-reference' && role !== 'runtime-dependency') {
      throw new NexarError('VALIDATION_ERROR', `Invalid upstream role: ${String(role)}`);
    }
    if (discoveryAdapterKind !== 'git-tags' && discoveryAdapterKind !== 'npm-registry') {
      throw new NexarError(
        'VALIDATION_ERROR',
        `Invalid discoveryAdapterKind: ${String(discoveryAdapterKind)}`,
      );
    }
    if (
      allowedReleaseChannel !== 'stable' &&
      allowedReleaseChannel !== 'prerelease' &&
      allowedReleaseChannel !== 'all'
    ) {
      throw new NexarError(
        'VALIDATION_ERROR',
        `Invalid allowedReleaseChannel: ${String(allowedReleaseChannel)}`,
      );
    }
    if (typeof approvedSourceReference !== 'string' || !approvedSourceReference.trim()) {
      throw new NexarError('VALIDATION_ERROR', 'Missing approvedSourceReference');
    }
    if (!Array.isArray(adrs) || adrs.length === 0) {
      throw new NexarError('VALIDATION_ERROR', 'Upstream entry must link to at least one ADR');
    }

    // Role-specific enforcement:
    if (role === 'architecture-reference') {
      if (currentRuntimePin !== null) {
        throw new NexarError(
          'VALIDATION_ERROR',
          'Architecture reference must have null currentRuntimePin',
        );
      }
    } else if (role === 'runtime-dependency') {
      if (typeof currentRuntimePin !== 'string' || !currentRuntimePin.trim()) {
        throw new NexarError(
          'VALIDATION_ERROR',
          'Runtime dependency requires an exact currentRuntimePin',
        );
      }
      if (isFloatingDistTag(currentRuntimePin)) {
        throw new NexarError(
          'VALIDATION_ERROR',
          `Floating dist-tag forbidden as runtime pin: ${currentRuntimePin}`,
        );
      }
      if (
        upstreamId === 'deepseek-harness' &&
        currentRuntimePin !== '@deepseek-ai/dsh@0.2.1-rc.3'
      ) {
        throw new NexarError(
          'VALIDATION_ERROR',
          'DSH pin must match the owner-authorized @deepseek-ai/dsh@0.2.1-rc.3',
        );
      }
    }

    if (typeof lastApprovedEvidence !== 'object' || lastApprovedEvidence === null) {
      throw new NexarError('VALIDATION_ERROR', 'Missing lastApprovedEvidence object');
    }

    validatedUpstreams.push(
      Object.freeze({
        upstreamId,
        projectName,
        officialRepository,
        role,
        discoveryAdapterKind,
        allowedReleaseChannel,
        approvedSourceReference,
        currentRuntimePin: currentRuntimePin === null ? null : (currentRuntimePin as string),
        lastEvaluatedReference:
          typeof lastEvaluatedReference === 'string' ? lastEvaluatedReference : null,
        compatibilityState: compatibilityState as UpstreamCompatibilityState,
        adrs: Object.freeze([...(adrs as string[])]),
        lastApprovedEvidence: Object.freeze({
          ...(lastApprovedEvidence as UpstreamApprovedEvidence),
        }),
      }),
    );
  }

  return Object.freeze({
    schemaVersion: m['schemaVersion'],
    generatedAt: typeof m['generatedAt'] === 'string' ? m['generatedAt'] : new Date().toISOString(),
    upstreams: Object.freeze(validatedUpstreams),
  });
}
