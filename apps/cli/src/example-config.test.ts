import { readFileSync } from 'node:fs';
import { realpath } from 'node:fs/promises';
import { dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { parseConfig } from '@nexar/core';
import { ProjectRegistry } from '@nexar/projects';

const examplePath = fileURLToPath(
  new URL('../../../config/nexar.config.example.json', import.meta.url),
);

describe('config/nexar.config.example.json', () => {
  const config = parseConfig(JSON.parse(readFileSync(examplePath, 'utf8')), examplePath);

  it('parses with core and declares the documented resources', () => {
    expect(config.resources.map((r) => r.id)).toEqual([
      'claude-code',
      'codex',
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
    expect(preferred).not.toContain('codex');
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
    expect(credentials.map((c) => c.source)).toEqual([
      'runtime-managed',
      'runtime-managed',
      'env',
      'env',
    ]);
  });

  it('declares a demo project that canonicalizes inside the repo and resolves its document set', async () => {
    const withBase = parseConfig(JSON.parse(readFileSync(examplePath, 'utf8')), examplePath, {
      baseDir: dirname(examplePath),
    });
    const registry = await ProjectRegistry.create(withBase.projects);
    const project = registry.require(withBase.projects[0]?.id ?? ('' as never));
    expect(project.id).toBe('demo-project');
    const demo = fileURLToPath(new URL('../../../examples/demo-project', import.meta.url));
    expect(project.realRoots).toEqual([await realpath(demo)]);
    const refs = await registry.resolveDocumentSet(project, 'overview');
    expect(refs.map((r) => r.label)).toEqual(['README.md', 'docs/overview.md']);
    expect(withBase.projects[0]?.defaults?.preferredResourceIds).toEqual(['claude-code']);
  });
});
