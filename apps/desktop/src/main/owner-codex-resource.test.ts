import { describe, expect, it } from 'vitest';
import {
  BUILTIN_CONNECTIONS,
  connectionOf,
  isOwnerCodexConnectionId,
  type PersistentConnectionRecord,
} from '@nexar/contracts';
import { reviewIdentityOf } from '@nexar/resource-controller';
import { ownerCodexResource } from '@nexar/host';

function record(id: string, label = 'Work', generation = 1): PersistentConnectionRecord {
  return {
    ...BUILTIN_CONNECTIONS['openai.subscription'],
    id,
    label,
    builtIn: false,
    credentialScope: { kind: 'native-home', runtimeId: 'codex', home: 'private' },
    nativeHome: { marker: '11111111-1111-4111-8111-111111111111' },
    credentialGeneration: generation,
    identityAssurance: 'IDENTITY_UNKNOWN',
    lifecycleState: 'ACTIVE',
    createdAt: '2026-11-01T00:00:00.000Z',
    updatedAt: '2026-11-01T00:00:00.000Z',
  };
}

const A = 'openai.subscription.caaaaaaaaaa';
const B = 'openai.subscription.cbbbbbbbbbb';

describe('owner Codex resources', () => {
  it('recognizes only the owner id form', () => {
    expect(isOwnerCodexConnectionId(A)).toBe(true);
    for (const id of [
      'openai.subscription',
      'openai.subscription.chatgpt-plan',
      'openai.subscription.CAAAAAAAAAA',
      'openai.subscription.caaaaaaaaa',
      'openai.api.caaaaaaaaaa',
      `${A}/..`,
    ])
      expect(isOwnerCodexConnectionId(id)).toBe(false);
  });

  it('binds the resource to the connection and sets no home', () => {
    const resource = ownerCodexResource(record(A));
    expect(resource.id).toBe(`codex:${A}`);
    expect(connectionOf(resource)?.id).toBe(A);
    expect(resource.runtime.options).toBeUndefined();
    expect(resource.auth).toMatchObject({ credential: { source: 'runtime-managed' } });
    expect(resource.metadata).toMatchObject({ connectionHost: 'desktop', connectionGeneration: 1 });
  });

  it('gives two connections distinct review identities', () => {
    const a = reviewIdentityOf(ownerCodexResource(record(A)));
    const b = reviewIdentityOf(ownerCodexResource(record(B)));
    expect(a.connectionId).toBe(A);
    expect(b.connectionId).toBe(B);
    expect(a.provider).toBe(b.provider);
  });

  it('keeps the identity across a label change or a new credential generation', () => {
    const before = reviewIdentityOf(ownerCodexResource(record(A)));
    const after = reviewIdentityOf(ownerCodexResource(record(A, 'Renamed', 2)));
    expect(after).toEqual(before);
  });

  it('earns no connection credit when the connection metadata is unknown', () => {
    expect(
      reviewIdentityOf({ ...ownerCodexResource(record(A)), metadata: {} }).connectionId,
    ).toBeUndefined();
  });
});
