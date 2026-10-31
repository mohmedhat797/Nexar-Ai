import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { buildBaseEnv, buildDshEnv, credentialVariable } from './env.js';

describe('rc.3 shared agent configuration isolation', () => {
  it.each(['env', 'keystore'] as const)(
    'rejects native credential aliases of the owned home (%s)',
    (source) => {
      for (const name of ['DSH_AGENTS_HOME', 'dsh_agents_home', 'Dsh_Agents_Home']) {
        expect(() =>
          credentialVariable({ auth: { mode: 'api-key', credential: { source, name } } }),
        ).toThrow(expect.objectContaining({ code: 'CONFIGURATION_ERROR' }));
      }
    },
  );
  it('replaces an ambient shared agents home with the managed private home', () => {
    const stateDir = join(process.cwd(), 'synthetic-state');
    const env = buildBaseEnv({ DSH_AGENTS_HOME: 'untrusted-owner-home' }, stateDir);
    expect(env['DSH_AGENTS_HOME']).toBe(join(stateDir, 'home', 'agents'));
  });

  it('refuses credential metadata that could overwrite the private agents home', () => {
    expect(() =>
      buildDshEnv(
        {},
        {
          auth: { mode: 'api-key', credential: { source: 'env', name: 'DSH_AGENTS_HOME' } },
        },
        { stateDir: process.cwd() },
      ),
    ).toThrow();
  });
});
