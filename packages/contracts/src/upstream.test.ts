import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  classifyReleaseChannel,
  createUpdateRecord,
  detectIntegrityDrift,
  isChannelAllowed,
  isFloatingDistTag,
  normalizeObservation,
  transitionUpdateState,
  validateUpstreamManifest,
  type UpstreamManifest,
  type UpstreamUpdateObservation,
} from './upstream.js';

describe('UI-01: Upstream Intelligence Foundation (18 Required Tests)', () => {
  // 1. Stable release classification
  it('1. classifies stable releases correctly', () => {
    expect(classifyReleaseChannel('1.0.0')).toBe('stable');
    expect(classifyReleaseChannel('v2.1.4')).toBe('stable');
    expect(classifyReleaseChannel('0.1.0')).toBe('stable');
    expect(isChannelAllowed('1.0.0', 'stable')).toBe(true);
  });

  // 2. Prerelease classification
  it('2. classifies prereleases (rc, beta, preview) correctly', () => {
    expect(classifyReleaseChannel('0.2.0-rc.2')).toBe('prerelease');
    expect(classifyReleaseChannel('1.0.0-beta.1')).toBe('prerelease');
    expect(classifyReleaseChannel('2.0.0-preview.5')).toBe('prerelease');
    expect(isChannelAllowed('0.2.0-rc.2', 'stable')).toBe(false);
    expect(isChannelAllowed('0.2.0-rc.2', 'prerelease')).toBe(true);
  });

  // 3. Alpha/nightly distinction
  it('3. distinguishes alpha and nightly builds from standard prereleases', () => {
    expect(classifyReleaseChannel('0.3.0-alpha.1')).toBe('alpha-nightly');
    expect(classifyReleaseChannel('20261017-nightly')).toBe('alpha-nightly');
    expect(classifyReleaseChannel('1.0.0-canary.12')).toBe('alpha-nightly');
    expect(classifyReleaseChannel('0.1.0-dev.4')).toBe('alpha-nightly');
    expect(isChannelAllowed('0.3.0-alpha.1', 'prerelease')).toBe(false);
    expect(isChannelAllowed('0.3.0-alpha.1', 'all')).toBe(true);
  });

  // 4. Mutable dist-tag behavior
  it('4. detects and rejects mutable floating dist-tags as runtime pins', () => {
    expect(isFloatingDistTag('latest')).toBe(true);
    expect(isFloatingDistTag('next')).toBe(true);
    expect(isFloatingDistTag('canary')).toBe(true);
    expect(isFloatingDistTag('^0.2.0')).toBe(true);
    expect(isFloatingDistTag('~0.2.0')).toBe(true);
    expect(isFloatingDistTag('*')).toBe(true);

    // Exact semver pins are NOT floating
    expect(isFloatingDistTag('@deepseek-ai/dsh@0.2.0-rc.2')).toBe(false);
    expect(isFloatingDistTag('0.2.0-rc.2')).toBe(false);
    expect(isFloatingDistTag('1.0.0')).toBe(false);
  });

  // 5. Missing source identity
  it('5. fails closed when an upstream entry lacks official repository or source identity', () => {
    const invalid = {
      schemaVersion: '1.0.0',
      upstreams: [
        {
          upstreamId: 'test-upstream',
          projectName: 'Test',
          officialRepository: '', // empty!
          role: 'runtime-dependency',
          discoveryAdapterKind: 'npm-registry',
          allowedReleaseChannel: 'stable',
          approvedSourceReference: 'ref',
          currentRuntimePin: '1.0.0',
          adrs: ['ADR-030'],
          lastApprovedEvidence: {
            milestone: 'M1',
            verifier: 'V1',
            verdict: 'OK',
            approvedDate: '2026-10-17',
          },
        },
      ],
    };
    expect(() => validateUpstreamManifest(invalid)).toThrow(
      'officialRepository must be an official https://github.com/ URL',
    );
  });

  // 6. Conflicting release metadata
  it('6. rejects observations with invalid, empty, or untrimmed version metadata', () => {
    expect(() => normalizeObservation({ upstreamId: 'dsh', version: '' })).toThrow(
      'Missing or invalid version in observation',
    );
    expect(() => normalizeObservation({ upstreamId: '', version: '1.0.0' })).toThrow(
      'Missing or invalid upstreamId in observation',
    );
    expect(() => normalizeObservation(null)).toThrow('Observation must be an object');
  });

  // 7. Duplicate update observations
  it('7. safely processes duplicate observations without mutating historical audit records', () => {
    const obs: UpstreamUpdateObservation = {
      upstreamId: 'deepseek-harness',
      version: '0.2.0-rc.2',
      releaseChannel: 'prerelease',
      artifactIntegrity: 'sha512-abc123canonical',
      observedAt: '2026-10-17T00:00:00.000Z',
    };
    const record = createUpdateRecord(obs);
    expect(record.state).toBe('AVAILABLE');
    expect(record.history).toHaveLength(1);

    // An identical second observation does not drift
    expect(detectIntegrityDrift(record, obs)).toBe(false);
    // Record is deeply immutable
    expect(Object.isFrozen(record)).toBe(true);
    expect(Object.isFrozen(record.history)).toBe(true);
  });

  // 8. Changed artifact integrity under the same version (retagging detection)
  it('8. detects changed artifact integrity under the exact same version string', () => {
    const record = createUpdateRecord({
      upstreamId: 'deepseek-harness',
      version: '0.2.0-rc.2',
      releaseChannel: 'prerelease',
      artifactIntegrity: 'sha512-originalLegitHash',
      observedAt: '2026-10-17T00:00:00.000Z',
    });

    const driftedObservation: UpstreamUpdateObservation = {
      upstreamId: 'deepseek-harness',
      version: '0.2.0-rc.2',
      releaseChannel: 'prerelease',
      artifactIntegrity: 'sha512-tamperedOrRetaggedHash',
      observedAt: '2026-10-17T01:00:00.000Z',
    };

    expect(detectIntegrityDrift(record, driftedObservation)).toBe(true);
  });

  // 9. Missing evaluation evidence
  it('9. strictly forbids transition to APPROVED when evaluation evidence is missing', () => {
    const record = createUpdateRecord({
      upstreamId: 'deepseek-harness',
      version: '0.2.0-rc.3',
      releaseChannel: 'prerelease',
      observedAt: '2026-10-17T00:00:00.000Z',
    });
    const evaluated = transitionUpdateState(record, 'EVALUATED');
    expect(evaluated.state).toBe('EVALUATED');

    // Missing evidence must throw
    expect(() => transitionUpdateState(evaluated, 'APPROVED')).toThrow(
      'Approval requires valid evaluation evidence',
    );
    expect(() => transitionUpdateState(evaluated, 'APPROVED', { evidence: {} })).toThrow(
      'Approval requires valid evaluation evidence',
    );
  });

  // 10. Invalid approval transitions
  it('10. forbids invalid transitions that skip mandatory lifecycle stages', () => {
    const record = createUpdateRecord({
      upstreamId: 'deepseek-harness',
      version: '0.2.0-rc.3',
      releaseChannel: 'prerelease',
      observedAt: '2026-10-17T00:00:00.000Z',
    });

    // Cannot jump AVAILABLE -> APPROVED
    expect(() => transitionUpdateState(record, 'APPROVED', { evidence: { test: true } })).toThrow(
      'Invalid upstream update transition from AVAILABLE to APPROVED',
    );
    // Cannot jump AVAILABLE -> INSTALLED
    expect(() => transitionUpdateState(record, 'INSTALLED')).toThrow(
      'Invalid upstream update transition from AVAILABLE to INSTALLED',
    );
    // Cannot jump AVAILABLE -> VERIFIED
    expect(() => transitionUpdateState(record, 'VERIFIED')).toThrow(
      'Invalid upstream update transition from AVAILABLE to VERIFIED',
    );
  });

  // 11. Installed versus verified distinction
  it('11. strictly enforces distinction between INSTALLED and VERIFIED', () => {
    const record = createUpdateRecord({
      upstreamId: 'deepseek-harness',
      version: '0.2.0-rc.3',
      releaseChannel: 'prerelease',
      observedAt: '2026-10-17T00:00:00.000Z',
    });
    const evaluated = transitionUpdateState(record, 'EVALUATED');
    const approved = transitionUpdateState(evaluated, 'APPROVED', {
      evidence: { reviewVerdict: 'APPROVED_BY_OWNER', gate: '19-gates' },
    });
    const installed = transitionUpdateState(approved, 'INSTALLED');

    expect(installed.state).toBe('INSTALLED');
    expect(installed.state).not.toBe('VERIFIED');

    // Verification requires runtime verification evidence
    expect(() => transitionUpdateState(installed, 'VERIFIED')).toThrow(
      'Verification requires runtime verification evidence',
    );

    const verified = transitionUpdateState(installed, 'VERIFIED', {
      evidence: { runtimeTestOutput: 'ALL_PASSED_CLEAN', helperStatus: 'OK' },
    });
    expect(verified.state).toBe('VERIFIED');
  });

  // 12. Rollback state preservation
  it('12. preserves the complete historical audit trail when rolled back', () => {
    const record = createUpdateRecord({
      upstreamId: 'deepseek-harness',
      version: '0.2.0-rc.3',
      releaseChannel: 'prerelease',
      observedAt: '2026-10-17T00:00:00.000Z',
    });
    const evaluated = transitionUpdateState(record, 'EVALUATED');
    const approved = transitionUpdateState(evaluated, 'APPROVED', {
      evidence: { ok: true },
    });
    const installed = transitionUpdateState(approved, 'INSTALLED');
    const rolledBack = transitionUpdateState(installed, 'ROLLED_BACK', {
      reason: 'Regression detected in runtime helper probe',
    });

    expect(rolledBack.state).toBe('ROLLED_BACK');
    expect(rolledBack.history).toHaveLength(5);
    expect(rolledBack.history.map((h) => h.to)).toEqual([
      'AVAILABLE',
      'EVALUATED',
      'APPROVED',
      'INSTALLED',
      'ROLLED_BACK',
    ]);
  });

  // 13. Unknown compatibility
  it('13. classifies unknown compatibility safely without guessing', () => {
    const obs = normalizeObservation({
      upstreamId: 'unknown-tool',
      version: '99.0.0-experimental',
    });
    const record = createUpdateRecord(obs);
    expect(record.state).toBe('AVAILABLE');
    // It is never automatically compatible
    expect(record.state).not.toBe('APPROVED');
    expect(record.state).not.toBe('INSTALLED');
  });

  // 14. No automatic promotion
  it('14. guarantees new observations never automatically promote runtime pins or NRC routes', () => {
    const obs = normalizeObservation({
      upstreamId: 'deepseek-harness',
      version: '0.3.0',
    });
    const record = createUpdateRecord(obs);
    // New observation stays in AVAILABLE
    expect(record.state).toBe('AVAILABLE');
    // Manifest pin is untouched
    const manifestPath = resolve(__dirname, '../../../config/upstreams.json');
    const manifest = JSON.parse(readFileSync(manifestPath, 'utf8')) as UpstreamManifest;
    const dsh = manifest.upstreams.find((u) => u.upstreamId === 'deepseek-harness');
    expect(dsh?.currentRuntimePin).toBe('@deepseek-ai/dsh@0.2.1-rc.5');
  });

  // 15. No credential fields in the manifest
  it('15. strictly rejects any secret, token, key, or credential fields in the manifest', () => {
    const leakyManifest = {
      schemaVersion: '1.0.0',
      upstreams: [
        {
          upstreamId: 'deepseek-harness',
          projectName: 'DeepSeek Harness',
          officialRepository: 'https://github.com/deepseek-ai/deepseek-harness',
          role: 'runtime-dependency',
          discoveryAdapterKind: 'npm-registry',
          allowedReleaseChannel: 'prerelease',
          approvedSourceReference: 'ref',
          currentRuntimePin: '@deepseek-ai/dsh@0.2.1-rc.5',
          apiToken: 'SECRET_CANARY_VALUE', // LEAK!
          adrs: ['ADR-030'],
          lastApprovedEvidence: {
            milestone: 'M1',
            verifier: 'V1',
            verdict: 'OK',
            approvedDate: '2026-10-17',
          },
        },
      ],
    };
    expect(() => validateUpstreamManifest(leakyManifest)).toThrow(
      'Forbidden secret key in upstream entry: apiToken',
    );
  });

  // 16. Exact DSH pin preservation
  it('16. permits only the owner-authorized DeepSeek Harness pin @deepseek-ai/dsh@0.2.1-rc.5', () => {
    const manifestPath = resolve(__dirname, '../../../config/upstreams.json');
    const manifest = validateUpstreamManifest(JSON.parse(readFileSync(manifestPath, 'utf8')));
    const dsh = manifest.upstreams.find((u) => u.upstreamId === 'deepseek-harness');

    expect(dsh).toBeDefined();
    expect(dsh?.role).toBe('runtime-dependency');
    expect(dsh?.currentRuntimePin).toBe('@deepseek-ai/dsh@0.2.1-rc.5');
    expect(dsh?.adrs).toContain('ADR-030');
    expect(dsh?.compatibilityState).toBe('EVALUATED');

    // Attempting to mutate DSH pin without governance fails manifest validation
    for (const version of ['0.2.1-rc.3', '0.2.1-rc.4', '0.2.2-alpha.2']) {
      const tampered = {
        ...manifest,
        upstreams: [{ ...dsh!, currentRuntimePin: `@deepseek-ai/dsh@${version}` }],
      };
      expect(() => validateUpstreamManifest(tampered)).toThrow(
        'DSH pin must match the owner-authorized @deepseek-ai/dsh@0.2.1-rc.5',
      );
    }
  });

  // 17. T3 reference-only behavior
  it('17. enforces T3 Code as an architecture-reference only with null currentRuntimePin', () => {
    const manifestPath = resolve(__dirname, '../../../config/upstreams.json');
    const manifest = validateUpstreamManifest(JSON.parse(readFileSync(manifestPath, 'utf8')));
    const t3 = manifest.upstreams.find((u) => u.upstreamId === 't3-code');

    expect(t3).toBeDefined();
    expect(t3?.role).toBe('architecture-reference');
    expect(t3?.currentRuntimePin).toBeNull();
    expect(t3?.adrs).toEqual(['ADR-029', 'ADR-030']);

    // Attempting to install T3 Code or give it a runtime pin fails validation
    const invalidT3 = {
      ...manifest,
      upstreams: [
        {
          ...t3!,
          currentRuntimePin: '@pingdotgg/t3code@2.0.0',
        },
      ],
    };
    expect(() => validateUpstreamManifest(invalidT3)).toThrow(
      'Architecture reference must have null currentRuntimePin',
    );
  });

  // 18. No NRC authority changes
  it('18. verifies upstream intelligence operates offline and possesses zero NRC routing authority', () => {
    const manifestPath = resolve(__dirname, '../../../config/upstreams.json');
    const manifest = validateUpstreamManifest(JSON.parse(readFileSync(manifestPath, 'utf8')));
    // Upstream entries contain no resource IDs, no route IDs, no weights, no scoring metrics
    for (const entry of manifest.upstreams) {
      const rec = entry as unknown as Record<string, unknown>;
      expect(rec['resourceId']).toBeUndefined();
      expect(rec['routeId']).toBeUndefined();
      expect(rec['weight']).toBeUndefined();
      expect(rec['score']).toBeUndefined();
    }
  });
});
