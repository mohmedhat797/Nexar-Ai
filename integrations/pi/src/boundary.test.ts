import { readFileSync, readdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import * as mod from './index.js';

const srcDir = fileURLToPath(new URL('.', import.meta.url));

describe('upstream isolation (ADR-008)', () => {
  it('exports only the Nexar-owned public surface', () => {
    expect(Object.keys(mod).sort()).toEqual(
      [
        'DEFAULT_ALLOWED_PROVIDERS',
        'LOCAL_ENDPOINTS_SOURCE_ID',
        'PI_ADAPTER_ID',
        'PI_AI_VERSION',
        'PI_CATALOG_SOURCE_ID',
        'PiExecutionAdapter',
        'localEndpointDiscoverySource',
        'piCatalogDiscoverySource',
        'piModelResource',
        'toExecutionResult',
      ].sort(),
    );
  });

  it('does not re-export anything from pi-ai in the package entry point', () => {
    const index = readFileSync(`${srcDir}index.ts`, 'utf8');
    expect(index).not.toMatch(/earendil-works|pi-ai['"]/);
    expect(index).not.toMatch(/export\s+\*/);
  });

  it('imports pi-ai only from pi-models.ts (and tests)', () => {
    const offenders = readdirSync(srcDir)
      .filter((file) => file.endsWith('.ts') && !file.endsWith('.test.ts'))
      .filter((file) => file !== 'pi-models.ts')
      .filter((file) => readFileSync(`${srcDir}${file}`, 'utf8').includes('@earendil-works'));
    expect(offenders).toEqual([]);
  });
});
