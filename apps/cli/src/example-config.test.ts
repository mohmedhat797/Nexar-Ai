import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { parseConfig } from '@nexar/core';

const examplePath = fileURLToPath(
  new URL('../../../config/nexar.config.example.json', import.meta.url),
);

describe('config/nexar.config.example.json', () => {
  const config = parseConfig(JSON.parse(readFileSync(examplePath, 'utf8')), examplePath);

  it('parses with core and declares the three documented resources', () => {
    expect(config.resources.map((r) => r.id)).toEqual([
      'claude-code',
      'deepseek-harness',
      'anthropic-sonnet',
    ]);
    expect(config.routing.defaultResourceId).toBe('claude-code');
    expect(config.telemetry.jsonlPath).toBe('.nexar/telemetry.jsonl');
  });

  it('prefers real resources and contains no echo test double', () => {
    const preferred = Object.values(config.routing.taskKinds).flatMap(
      (rule) => rule.preferredResourceIds ?? [],
    );
    expect(preferred).not.toContain('local-echo');
    expect(config.resources.some((r) => r.runtime.adapter === 'echo')).toBe(false);
    expect(config.routing.taskKinds['analysis']?.preferredResourceIds).toEqual([
      'anthropic-sonnet',
      'deepseek-harness',
      'claude-code',
    ]);
  });

  it('holds credential references only', () => {
    const credentials = config.resources.flatMap((r) =>
      'credential' in r.auth ? [r.auth.credential] : [],
    );
    expect(credentials.map((c) => c.source)).toEqual(['runtime-managed', 'env', 'env']);
  });
});
