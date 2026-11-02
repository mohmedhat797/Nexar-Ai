import {
  BUILTIN_CONNECTIONS,
  isOwnerCodexConnectionId,
  type ConnectionDefinition,
  type ConnectionsSettings,
} from '@nexar/contracts';
import { PI_PROVIDER_CREDENTIAL_NAMES } from '@nexar/integration-pi';

export const PLAN_ID = 'openai.chatgpt-plan';
export const OWNER_API_ID = /^([a-z0-9]+)\.api\.c([a-z2-7]{10})$/;
const PLAN_OWNER_ID = /^openai\.chatgpt-plan\.c([a-z2-7]{10})$/;
const timestamp = (s: string): boolean =>
  /^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{3}Z$/.test(s) &&
  Number.isFinite(Date.parse(s)) &&
  new Date(s).toISOString() === s;

export function defaultDefinition(id: string): ConnectionDefinition | undefined {
  const canonical = Object.values(BUILTIN_CONNECTIONS).find((d) => d.id === id);
  if (canonical !== undefined) return canonical;
  // Existing configured/static catalog API routes remain stable, including routes not in the five templates.
  const provider = id.endsWith('.api') ? id.slice(0, -4) : '';
  const name = PI_PROVIDER_CREDENTIAL_NAMES[provider];
  if (name === undefined) return undefined;
  return {
    id,
    provider,
    method: 'api',
    authClass: 'official-api',
    support: 'official',
    machine: 'desktop',
    label: `${provider} (API)`,
    enabled: true,
    builtIn: true,
    credentialScope: { kind: 'keystore', name },
  };
}

export function ownerKeyName(provider: string, id: string): string | undefined {
  const match = OWNER_API_ID.exec(id);
  const base = PI_PROVIDER_CREDENTIAL_NAMES[provider];
  return match?.[1] === provider && base !== undefined
    ? `${base}__C${match[2]!.toUpperCase()}`
    : undefined;
}

export function planScopeName(id: string): string | undefined {
  if (id === PLAN_ID) return 'chatgpt-plan';
  const suffix = PLAN_OWNER_ID.exec(id)?.[1];
  return suffix === undefined ? undefined : `chatgpt-plan:c${suffix}`;
}

/** Semantic authority validation, in addition to the strict storage shape. Never repairs ownership. */
export function validConnections(value: ConnectionsSettings): boolean {
  if (
    Object.keys(value.connections).length > 64 ||
    new Set(value.tombstones).size !== value.tombstones.length
  )
    return false;
  let planCount = 0;
  for (const [id, r] of Object.entries(value.connections)) {
    if (
      id !== r.id ||
      r.machine !== 'desktop' ||
      !r.label.trim() ||
      !timestamp(r.createdAt) ||
      !timestamp(r.updatedAt) ||
      r.updatedAt < r.createdAt ||
      r.credentialGeneration < 1
    )
      return false;
    if (r.enabled !== (r.lifecycleState === 'ACTIVE')) return false;
    if (value.tombstones.includes(id) !== (r.lifecycleState === 'TOMBSTONED')) return false;
    if (
      r.retirement !== undefined &&
      (r.retirement !== 'replaced' || r.lifecycleState !== 'TOMBSTONED')
    )
      return false;
    if (r.identityAssurance === 'VERIFIED_DIFFERENT_ACCOUNT') return false;
    if (
      r.assertion !== undefined &&
      (!timestamp(r.assertion.at) ||
        r.assertion.source !== 'owner' ||
        r.assertion.type !== 'same-account')
    )
      return false;
    if (r.identityAssurance === 'OWNER_ASSERTED_SAME_ACCOUNT' && r.assertion === undefined)
      return false;
    if (isOwnerCodexConnectionId(id) !== (r.nativeHome !== undefined)) return false;
    if (r.nativeHome?.signedInAt !== undefined && !timestamp(r.nativeHome.signedInAt)) return false;
    if (r.nativeHome?.signedInAt !== undefined && r.nativeHome.associated !== true) return false;
    const definition = defaultDefinition(id);
    if (definition !== undefined) {
      for (const key of [
        'provider',
        'method',
        'authClass',
        'support',
        'machine',
        'builtIn',
      ] as const)
        if (r[key] !== definition[key]) return false;
      if (JSON.stringify(r.credentialScope) !== JSON.stringify(definition.credentialScope))
        return false;
      if (r.lifecycleState === 'TOMBSTONED' && (id !== PLAN_ID || r.retirement !== 'replaced'))
        return false;
    } else if (planScopeName(id) !== undefined) {
      if (
        r.builtIn ||
        r.provider !== 'openai' ||
        r.method !== 'subscription' ||
        r.authClass !== 'official-account' ||
        r.support !== 'official' ||
        r.credentialScope.kind !== 'account' ||
        r.credentialScope.name !== planScopeName(id)
      )
        return false;
    } else if (isOwnerCodexConnectionId(id)) {
      if (
        r.builtIn ||
        r.provider !== 'openai' ||
        r.method !== 'subscription' ||
        r.authClass !== 'vendor-native' ||
        r.support !== 'official' ||
        r.credentialScope.kind !== 'native-home' ||
        r.credentialScope.runtimeId !== 'codex' ||
        r.credentialScope.home !== 'private'
      )
        return false;
    } else {
      if (
        r.builtIn ||
        r.method !== 'api' ||
        r.authClass !== 'official-api' ||
        r.support !== 'official' ||
        r.credentialScope.kind !== 'keystore' ||
        r.credentialScope.name !== ownerKeyName(r.provider, id)
      )
        return false;
    }
    const isPlan = planScopeName(id) !== undefined;
    if (r.identityAssurance === 'VERIFIED_SAME_ACCOUNT' && !isPlan) return false;
    if (isPlan && r.lifecycleState !== 'TOMBSTONED') planCount++;
  }
  // The implicit built-in plan exists until explicitly retired.
  if (!Object.hasOwn(value.connections, PLAN_ID)) planCount++;
  if (planCount > 1) return false;
  return value.tombstones.every((id) => value.connections[id]?.lifecycleState === 'TOMBSTONED');
}
