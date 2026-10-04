import { mkdir, readFile, readdir, stat, symlink, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { TestContext } from 'vitest';
import { parseConfig } from '@nexar/core';
import type { ApprovalRequest } from '@nexar/approvals';
import type {
  ApprovalDto,
  ArtifactDto,
  DesktopSettings,
  FileListing,
  FilePreview,
  ProjectDto,
  ResourceRow,
  TaskResult,
  WorkflowDto,
} from '../shared/api.js';
import { CHANNELS } from '../shared/channels.js';
import { ALL_CHANNELS } from './bridge.js';
import { SettingsStore } from './settings-store.js';
import { createHarness, addProject, seed, type Harness } from './test-harness.js';

async function fileSymlink(target: string, path: string, context: TestContext): Promise<void> {
  try {
    await symlink(target, path, 'file');
  } catch (error) {
    if (process.platform === 'win32' && (error as NodeJS.ErrnoException).code === 'EPERM') {
      context.skip('Windows file symlinks require Developer Mode or symlink privileges');
    }
    throw error;
  }
}

let h: Harness;
beforeEach(async () => {
  h = await createHarness();
});
afterEach(async () => {
  await h.cleanup();
});

describe('schemas', () => {
  it('defines every channel exactly once', () => {
    expect(Object.keys(h.bridge.table).sort()).toEqual([...ALL_CHANNELS].sort());
  });

  it.each(ALL_CHANNELS)('%s rejects unknown keys and non-object arguments', async (channel) => {
    for (const bad of [{ unexpected: 1 }, 'text', 42, null, [1]]) {
      const result = await h.call(channel, bad);
      expect(result.ok).toBe(false);
      if (!result.ok) expect(result.error.code).toBe('VALIDATION_ERROR');
    }
  });

  it('rejects wrong types and malformed fields without echoing them', async () => {
    const secret = '/etc/very-secret-location';
    const cases: [string, unknown][] = [
      [CHANNELS.settingsSet, { theme: 'neon' }],
      [CHANNELS.settingsSet, { density: 3 }],
      [CHANNELS.settingsSet, { mode: 'other' }],
      [CHANNELS.behaviorSet, { code: { permission: 'full-auto' } }],
      [CHANNELS.behaviorSet, { code: { permission: 'ask-before-edits' } }],
      [CHANNELS.behaviorSet, { cowork: { permission: 'plan' } }],
      [CHANNELS.behaviorSet, { cowork: { permission: 'read-only', network: true } }],
      [CHANNELS.behaviorSet, { lockedRules: [] }],
      [CHANNELS.behaviorSet, { unsupported: [] }],
      [CHANNELS.behaviorSet, { code: { preferredResourceId: '../etc' } }],
      [CHANNELS.behaviorSet, { code: { preferredResourceId: 7 } }],
      [CHANNELS.behaviorSet, { sandbox: 'off' }],
      [CHANNELS.projectsRemove, { id: 7 }],
      [CHANNELS.projectsFiles, { projectId: 'p', dir: 5 }],
      [CHANNELS.projectsReadFile, { projectId: 'p', path: '' }],
      [CHANNELS.projectsReadFile, { projectId: 'p', path: `${secret}\0` }],
      [CHANNELS.resourcesList, { refresh: 'yes' }],
      [CHANNELS.routeExplain, { projectId: 'p', kind: 'general', prompt: '' }],
      [CHANNELS.tasksRun, { requestId: 'bad id!', projectId: 'p', kind: 'general', prompt: 'x' }],
      [CHANNELS.tasksRun, { requestId: 'r1', projectId: 'p', kind: 'General', prompt: 'x' }],
      [
        CHANNELS.tasksRun,
        { requestId: 'r1', projectId: 'p', kind: 'general', prompt: 'x', maxCostUsd: -1 },
      ],
      [CHANNELS.tasksCancel, { requestId: '../x' }],
      [CHANNELS.artifactsOpen, { projectId: 'p', path: 3 }],
      [CHANNELS.approvalsApprove, { id: 'nope' }],
      [CHANNELS.approvalsDeny, { id: 'apr_0123456789abcdef', reason: 5 }],
      [CHANNELS.workflowsRun, { requestId: 'r', projectId: 'p', workflowId: 'x', inputs: [] }],
      [
        CHANNELS.workflowsRun,
        { requestId: 'r', projectId: 'p', workflowId: 'x', inputs: { 'bad name': 'v' } },
      ],
    ];
    for (const [channel, args] of cases) {
      const result = await h.call(channel, args);
      expect(result.ok, channel).toBe(false);
      if (!result.ok) {
        expect(result.error.code, channel).toBe('VALIDATION_ERROR');
        expect(result.error.message).not.toContain(secret);
      }
    }
  });

  it('answers an unknown channel with a validation error', async () => {
    const result = await h.bridge.invoke('fs:readAnything', {}, () => undefined);
    expect(result).toEqual({
      ok: false,
      error: { code: 'VALIDATION_ERROR', message: 'Unknown channel' },
    });
    const proto = await h.bridge.invoke('__proto__', {}, () => undefined);
    expect(proto.ok).toBe(false);
  });
});

describe('first run, app and settings', () => {
  it('writes a valid config; the harness declares the echo test double on top of it', async () => {
    const raw = JSON.parse(await h.config.readText()) as Record<string, unknown>;
    const parsed = parseConfig(raw, 'test', { baseDir: h.userData });
    expect(parsed.routing.policy).toBe('resource-intelligence');
    expect(parsed.routing.defaultResourceId).toBe('local-echo');
    expect(parsed.resources.map((r) => r.id)).toEqual(['local-echo']);
    expect(parsed.discovery.enabled).toBe(true);
    expect(parsed.telemetry.jsonlPath).toBe('.nexar/telemetry.jsonl');
    expect(parsed.projects).toEqual([]);
  });

  it('reports app info', async () => {
    expect(await h.call(CHANNELS.appInfo)).toEqual({
      ok: true,
      value: { version: '0.0.0-test', platform: 'test' },
    });
  });

  it('round-trips settings through desktop-settings.json', async () => {
    const initial = await h.call<DesktopSettings>(CHANNELS.settingsGet);
    expect(initial).toEqual({
      ok: true,
      value: { theme: 'light', density: 'comfortable', mode: 'cowork' },
    });
    const set = await h.call<DesktopSettings>(CHANNELS.settingsSet, { theme: 'midnight' });
    expect(set).toEqual({
      ok: true,
      value: { theme: 'midnight', density: 'comfortable', mode: 'cowork' },
    });
    await h.call(CHANNELS.settingsSet, { density: 'compact', mode: 'code' });
    const stored = JSON.parse(
      await readFile(join(h.userData, 'desktop-settings.json'), 'utf8'),
    ) as unknown;
    expect(stored).toEqual({ theme: 'midnight', density: 'compact', mode: 'code' });
    expect(((await stat(join(h.userData, 'desktop-settings.json'))).mode & 0o777).toString(8)).toBe(
      process.platform === 'win32' ? '666' : '600',
    );
  });

  it('falls back to defaults when the settings file is damaged', async () => {
    await writeFile(join(h.userData, 'desktop-settings.json'), '{"theme": "neon"');
    const result = await h.call<DesktopSettings>(CHANNELS.settingsGet);
    expect(result).toEqual({
      ok: true,
      value: { theme: 'light', density: 'comfortable', mode: 'cowork' },
    });
  });
});

describe('projects', () => {
  it('adds a project by dialog with the canonical root, persists and lists it', async () => {
    const link = join(h.userData, 'link-to-project');
    await symlink(h.projectDir, link, process.platform === 'win32' ? 'junction' : 'dir');
    h.pick = link;
    const added = await h.call<ProjectDto | null>(CHANNELS.projectsAdd);
    expect(added).toEqual({
      ok: true,
      value: { id: 'project', name: 'project', root: h.projectDir },
    });

    const config = parseConfig(JSON.parse(await h.config.readText()), 'test', {
      baseDir: h.userData,
    });
    expect(config.projects.map((p) => [p.id, p.roots])).toEqual([['project', [h.projectDir]]]);

    const listed = await h.call<ProjectDto[]>(CHANNELS.projectsList);
    expect(listed).toEqual({
      ok: true,
      value: [{ id: 'project', name: 'project', root: h.projectDir }],
    });
  });

  it('returns null when the dialog is cancelled and the existing project when re-added', async () => {
    h.pick = null;
    expect(await h.call(CHANNELS.projectsAdd)).toEqual({ ok: true, value: null });
    const id = await addProject(h);
    const again = await h.call<ProjectDto>(CHANNELS.projectsAdd);
    expect(again.ok && again.value.id).toBe(id);
    const listed = await h.call<ProjectDto[]>(CHANNELS.projectsList);
    expect(listed.ok && listed.value).toHaveLength(1);
  });

  it('derives unique ids from folder names', async () => {
    const a = join(h.userData, 'x', 'My Docs');
    const b = join(h.userData, 'y', 'My Docs');
    await mkdir(a, { recursive: true });
    await mkdir(b, { recursive: true });
    h.pick = a;
    const first = await h.call<ProjectDto>(CHANNELS.projectsAdd);
    h.pick = b;
    const second = await h.call<ProjectDto>(CHANNELS.projectsAdd);
    expect(first.ok && first.value.id).toBe('my-docs');
    expect(first.ok && first.value.name).toBe('My Docs');
    expect(second.ok && second.value.id).toBe('my-docs-2');
  });

  it('refuses a selection that is not a directory, without naming it', async () => {
    const file = join(h.userData, 'just-a-file');
    await writeFile(file, 'x');
    h.pick = file;
    const result = await h.call(CHANNELS.projectsAdd);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.code).toBe('VALIDATION_ERROR');
      expect(result.error.message).not.toContain('just-a-file');
    }
  });

  it('removes a project from the config only, never its files', async () => {
    await seed(h.projectDir, { 'keep.txt': 'still here' });
    const id = await addProject(h);
    expect(await h.call(CHANNELS.projectsRemove, { id })).toEqual({
      ok: true,
      value: { removed: true },
    });
    expect(await h.call(CHANNELS.projectsRemove, { id })).toEqual({
      ok: true,
      value: { removed: false },
    });
    expect(await readFile(join(h.projectDir, 'keep.txt'), 'utf8')).toBe('still here');
    const listed = await h.call<ProjectDto[]>(CHANNELS.projectsList);
    expect(listed.ok && listed.value).toEqual([]);
  });
});

describe('project files', () => {
  let id: string;
  let outside: string;
  beforeEach(async () => {
    outside = join(h.userData, 'outside');
    await seed(outside, { 'secret.txt': 'top secret' });
    await seed(h.projectDir, {
      'readme.md': '# Hello\n',
      'src/a.ts': 'export {};\n',
      'zeta.txt': 'z',
      '.git/config': 'hidden',
      'node_modules/pkg/index.js': 'hidden',
      'binary.bin': '',
    });
    await writeFile(join(h.projectDir, 'binary.bin'), Buffer.from([0xff, 0xfe, 0x00, 0x61]));
    await symlink(
      outside,
      join(h.projectDir, 'escape-dir'),
      process.platform === 'win32' ? 'junction' : 'dir',
    );
    id = await addProject(h);
  });

  it('lists one level, directories first, hiding .git, node_modules and escaping links', async () => {
    const result = await h.call<FileListing>(CHANNELS.projectsFiles, { projectId: id });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.dir).toBe('');
    expect(result.value.truncated).toBe(false);
    expect(result.value.entries.map((e) => `${e.kind}:${e.name}`)).toEqual([
      'dir:src',
      'file:binary.bin',
      'file:readme.md',
      'file:zeta.txt',
    ]);
    expect(result.value.entries.find((e) => e.name === 'readme.md')?.size).toBe(8);
    const sub = await h.call<FileListing>(CHANNELS.projectsFiles, { projectId: id, dir: 'src' });
    expect(sub.ok && sub.value).toEqual({
      dir: 'src',
      entries: [{ name: 'a.ts', kind: 'file', size: 11 }],
      truncated: false,
    });
  });

  it(
    'caps a listing at 500 entries',
    async () => {
      const many = join(h.projectDir, 'many');
      await mkdir(many);
      for (let i = 0; i < 520; i += 8) {
        await Promise.all(
          Array.from({ length: 8 }, (_, offset) =>
            writeFile(join(many, `f${String(i + offset).padStart(4, '0')}`), ''),
          ),
        );
      }
      const result = await h.call<FileListing>(CHANNELS.projectsFiles, {
        projectId: id,
        dir: 'many',
      });
      expect(result.ok && result.value.entries).toHaveLength(500);
      expect(result.ok && result.value.truncated).toBe(true);
    },
    // The 520 real fixture files and containment reads encounter Windows antivirus scanning.
    process.platform === 'win32' ? 15_000 : undefined,
  );

  it('previews UTF-8 text files', async () => {
    const result = await h.call<FilePreview>(CHANNELS.projectsReadFile, {
      projectId: id,
      path: 'readme.md',
    });
    expect(result).toEqual({ ok: true, value: { text: '# Hello\n', truncated: false } });
  });

  it('refuses binary and oversized files', async () => {
    const binary = await h.call(CHANNELS.projectsReadFile, { projectId: id, path: 'binary.bin' });
    expect(binary.ok).toBe(false);
    await writeFile(join(h.projectDir, 'big.txt'), 'a'.repeat(256 * 1024 + 1));
    const big = await h.call(CHANNELS.projectsReadFile, { projectId: id, path: 'big.txt' });
    expect(big.ok).toBe(false);
    if (!big.ok) expect(big.error.code).toBe('VALIDATION_ERROR');
    await writeFile(join(h.projectDir, 'exact.txt'), 'a'.repeat(256 * 1024));
    const exact = await h.call(CHANNELS.projectsReadFile, { projectId: id, path: 'exact.txt' });
    expect(exact.ok).toBe(true);
  });

  it.each([
    ['dotdot', '..'],
    ['nested dotdot', 'src/../../outside'],
    ['absolute', '/etc'],
    ['windows drive', 'C:\\Windows'],
    ['backslash root', '\\Windows'],
    ['symlinked directory', 'escape-dir'],
    ['inside a symlinked directory', 'escape-dir/secret.txt'],
    ['missing', 'does-not-exist'],
  ])('refuses %s without echoing the path', async (_name, path) => {
    for (const result of [
      await h.call(CHANNELS.projectsFiles, { projectId: id, dir: path }),
      await h.call(CHANNELS.projectsReadFile, { projectId: id, path }),
    ]) {
      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.error.code).toBe('POLICY_REJECTED');
        expect(JSON.stringify(result)).not.toContain(path);
        expect(JSON.stringify(result)).not.toContain(outside);
      }
    }
  });

  it('lists contained file symlinks and hides escaping file symlinks', async (context) => {
    await fileSymlink(join(h.projectDir, 'readme.md'), join(h.projectDir, 'inside-link'), context);
    await fileSymlink(join(outside, 'secret.txt'), join(h.projectDir, 'escape-file'), context);
    const result = await h.call<FileListing>(CHANNELS.projectsFiles, { projectId: id });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.entries.map((entry) => entry.name)).toContain('inside-link');
    expect(result.value.entries.map((entry) => entry.name)).not.toContain('escape-file');
  });

  it('refuses a symlinked file that leaves the project', async (context) => {
    await fileSymlink(join(outside, 'secret.txt'), join(h.projectDir, 'escape-file'), context);
    const result = await h.call(CHANNELS.projectsReadFile, { projectId: id, path: 'escape-file' });
    expect(result.ok).toBe(false);
    expect(JSON.stringify(result)).not.toContain('top secret');
  });

  it('refuses an unknown project', async () => {
    const result = await h.call(CHANNELS.projectsFiles, { projectId: 'nope' });
    expect(result).toEqual({
      ok: false,
      error: { code: 'POLICY_REJECTED', message: 'Unknown project' },
    });
  });
});

describe('resources, routing and tasks', () => {
  let id: string;
  beforeEach(async () => {
    id = await addProject(h);
  });

  it('lists the echo resource with probed state and an unknown quota', async () => {
    const result = await h.call<ResourceRow[]>(CHANNELS.resourcesList, { refresh: true });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const echo = result.value.find((r) => r.id === 'local-echo');
    expect(echo).toMatchObject({
      id: 'local-echo',
      adapter: 'echo',
      provenance: 'configured',
      availability: 'available',
      costModel: 'free',
    });
    expect(echo?.quota.freshness).toBe('unknown');
    expect(JSON.stringify(result)).not.toContain('apiKey');
  });

  it('explains a route without running anything', async () => {
    const result = await h.call<{ outcome: string; selected: { resourceId: string } }>(
      CHANNELS.routeExplain,
      { projectId: id, kind: 'general', prompt: 'hello' },
    );
    expect(result.ok && result.value.outcome).toBe('selected');
    expect(result.ok && result.value.selected.resourceId).toBe('local-echo');
    expect(await readdir(h.projectDir)).toEqual([]);
  });

  it('runs a task on the echo resource, stores a draft inside the project and emits events', async () => {
    const result = await h.call<TaskResult>(CHANNELS.tasksRun, {
      requestId: 'req-1',
      projectId: id,
      kind: 'general',
      prompt: 'say hello',
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const run = result.value;
    expect(run.text).toContain('say hello');
    expect(run.decision.selected.resourceId).toBe('local-echo');
    expect(run.record).toMatchObject({ resourceId: 'local-echo', outcome: 'succeeded' });
    expect(['measured', 'estimated', 'unavailable']).toContain(run.record.costUsd.status);

    const artifact = run.artifact;
    expect(artifact).not.toBeNull();
    expect(artifact).toMatchObject({
      mediaType: 'text/markdown',
      draft: true,
      name: 'result.md',
      taskId: run.taskId,
    });
    expect(artifact?.path).toBe(`.nexar/artifacts/${run.taskId}/drafts/result.md`);
    expect(await readFile(join(h.projectDir, artifact?.path ?? ''), 'utf8')).toBe(run.text);

    expect(h.events.length).toBeGreaterThan(0);
    expect(h.events.every((e) => e.requestId === 'req-1')).toBe(true);
    expect(h.events.every((e) => e.type === 'status' || e.type === 'progress')).toBe(true);

    const listed = await h.call<ArtifactDto[]>(CHANNELS.artifactsList, { projectId: id });
    expect(listed.ok && listed.value.map((a) => a.path)).toEqual([artifact?.path]);

    // Telemetry carries refs and hashes, never the prompt or the content.
    const telemetry = await readFile(join(h.userData, '.nexar', 'telemetry.jsonl'), 'utf8');
    expect(telemetry).toContain('artifacts.stored');
    expect(telemetry).not.toContain('say hello');
  });

  it('rejects an unknown project, a reused request id and cancels nothing that is not running', async () => {
    const unknown = await h.call(CHANNELS.tasksRun, {
      requestId: 'req-2',
      projectId: 'ghost',
      kind: 'general',
      prompt: 'x',
    });
    expect(unknown).toEqual({
      ok: false,
      error: { code: 'POLICY_REJECTED', message: 'Unknown project' },
    });
    expect(await h.call(CHANNELS.tasksCancel, { requestId: 'req-2' })).toEqual({
      ok: true,
      value: { cancelled: false },
    });
    expect(h.bridge.jobs.begin('busy')).toBeInstanceOf(AbortController);
    const reused = await h.call(CHANNELS.tasksRun, {
      requestId: 'busy',
      projectId: id,
      kind: 'general',
      prompt: 'x',
    });
    expect(reused.ok).toBe(false);
    expect(await h.call(CHANNELS.tasksCancel, { requestId: 'busy' })).toEqual({
      ok: true,
      value: { cancelled: true },
    });
  });

  it('maps an engine refusal to its error code and explains it without running', async () => {
    await h.config.update((raw) => {
      const projects = raw['projects'] as { defaults?: unknown }[];
      projects[0]!.defaults = { excludedResourceIds: ['local-echo'] };
    });
    await h.engine.reload();
    const run = await h.call(CHANNELS.tasksRun, {
      requestId: 'req-3',
      projectId: id,
      kind: 'general',
      prompt: 'x',
    });
    expect(run.ok).toBe(false);
    if (!run.ok) expect(run.error.code).toBe('NO_ELIGIBLE_RESOURCE');
    const explained = await h.call<{ outcome: string; rejected: unknown[] }>(
      CHANNELS.routeExplain,
      { projectId: id, kind: 'general', prompt: 'x' },
    );
    expect(explained.ok && explained.value.outcome).toBe('no-eligible-resource');
    expect(explained.ok && explained.value.rejected).toHaveLength(1);
  });

  it('opens and reveals stored artifacts only', async () => {
    const run = await h.call<TaskResult>(CHANNELS.tasksRun, {
      requestId: 'req-4',
      projectId: id,
      kind: 'general',
      prompt: 'artifact please',
    });
    const path = run.ok ? (run.value.artifact?.path ?? '') : '';
    expect(await h.call(CHANNELS.artifactsOpen, { projectId: id, path })).toEqual({
      ok: true,
      value: null,
    });
    expect(await h.call(CHANNELS.artifactsReveal, { projectId: id, path })).toEqual({
      ok: true,
      value: null,
    });
    expect(h.opened).toEqual([join(h.projectDir, path)]);
    expect(h.revealed).toEqual([join(h.projectDir, path)]);

    await seed(h.projectDir, {
      'run-me.sh': 'echo hi',
      '.nexar/artifacts/planted/evil.exe': 'MZ',
      '.nexar/artifacts/planted/page.html': '<script></script>',
    });
    for (const target of [
      'run-me.sh',
      '../outside',
      '/etc/passwd',
      '.nexar',
      '.nexar/artifacts/planted/evil.exe',
      '.nexar/artifacts/planted/page.html',
    ]) {
      const refused = await h.call(CHANNELS.artifactsOpen, { projectId: id, path: target });
      expect(refused.ok, target).toBe(false);
    }
    expect(h.opened).toHaveLength(1);
  });
});

describe('approvals', () => {
  const pending = (id: string): ApprovalRequest => ({
    id,
    createdAt: new Date().toISOString(),
    expiresAt: new Date(Date.now() + 600_000).toISOString(),
    instanceId: 'gate_test',
    actionType: 'engineering.commit',
    summary: 'Commit the change\u001b[31m',
    risk: 'high',
    fingerprint: 'a'.repeat(64),
    metadata: { hidden: 'value' },
    status: 'pending',
  });
  const first = `apr_${'0123456789abcdef'.repeat(2)}`;
  const second = `apr_${'fedcba9876543210'.repeat(2)}`;

  it('is empty at first', async () => {
    expect(await h.call(CHANNELS.approvalsList)).toEqual({ ok: true, value: [] });
  });

  it('lists, approves and denies pending requests with a sanitized allowlist of fields', async () => {
    await h.engine.approvals().create(pending(first));
    await h.engine.approvals().create(pending(second));
    const listed = await h.call<ApprovalDto[]>(CHANNELS.approvalsList);
    expect(listed.ok && listed.value.map((a) => a.id).sort()).toEqual([first, second].sort());
    const dto = listed.ok ? listed.value[0] : undefined;
    expect(dto?.summary).not.toContain('\u001b');
    expect(dto?.fingerprint).toBe('a'.repeat(12));
    expect(JSON.stringify(listed)).not.toContain('hidden');

    const approved = await h.call<ApprovalDto>(CHANNELS.approvalsApprove, {
      id: first,
      reason: 'looks right',
    });
    expect(approved.ok && approved.value).toMatchObject({
      id: first,
      status: 'approved',
      decidedBy: 'desktop:test',
    });
    const denied = await h.call<ApprovalDto>(CHANNELS.approvalsDeny, { id: second });
    expect(denied.ok && denied.value.status).toBe('denied');

    expect(await h.call(CHANNELS.approvalsList)).toEqual({ ok: true, value: [] });
    const all = await h.call<ApprovalDto[]>(CHANNELS.approvalsList, { all: true });
    expect(all.ok && all.value).toHaveLength(2);
  });

  it('refuses to decide twice or on an unknown request', async () => {
    await h.engine.approvals().create(pending(first));
    await h.call(CHANNELS.approvalsDeny, { id: first });
    const again = await h.call(CHANNELS.approvalsApprove, { id: first });
    expect(again.ok).toBe(false);
    if (!again.ok) expect(again.error.code).toBe('APPROVAL_DENIED');
    const unknown = await h.call(CHANNELS.approvalsApprove, { id: second });
    expect(unknown.ok).toBe(false);
  });
});

describe('workflows', () => {
  it('lists the built-in workflows', async () => {
    const result = await h.call<WorkflowDto[]>(CHANNELS.workflowsList);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.map((w) => w.id)).toContain('meeting-brief');
    const brief = result.value.find((w) => w.id === 'meeting-brief');
    expect(brief?.inputs.find((i) => i.name === 'meetingTitle')?.required).toBe(true);
  });

  it('runs a workflow and returns its draft artifacts, and reports invalid input', async () => {
    const id = await addProject(h);
    const invalid = await h.call(CHANNELS.workflowsRun, {
      requestId: 'wf-0',
      projectId: id,
      workflowId: 'meeting-brief',
      inputs: {},
    });
    expect(invalid.ok).toBe(false);
    if (!invalid.ok) expect(invalid.error.code).toBe('VALIDATION_ERROR');

    const ran = await h.call<TaskResult>(CHANNELS.workflowsRun, {
      requestId: 'wf-1',
      projectId: id,
      workflowId: 'meeting-brief',
      inputs: { meetingTitle: 'Quarterly review', attendees: ['Ada', 'Grace'] },
    });
    expect(ran.ok).toBe(true);
    if (!ran.ok) return;
    expect(ran.value.artifacts.length).toBeGreaterThan(0);
    const draft = ran.value.artifacts.find((a) => a.draft);
    expect(draft).toBeDefined();
    expect(await readFile(join(h.projectDir, draft?.path ?? ''), 'utf8')).toContain('DRAFT');
    expect(h.events.some((e) => e.requestId === 'wf-1')).toBe(true);
  });
});

describe('error mapping', () => {
  it('maps unexpected errors to a generic INTERNAL_ERROR without leaking details', async () => {
    const broken = await createHarness({
      settings: {
        get: () => Promise.reject(new Error('ENOENT /home/alice/.secret/stack trace')),
        set: () => Promise.reject(new Error('nope')),
      } as never,
    });
    try {
      const result = await broken.call(CHANNELS.settingsGet);
      expect(result).toEqual({
        ok: false,
        error: { code: 'INTERNAL_ERROR', message: 'Internal error' },
      });
    } finally {
      await broken.cleanup();
    }
  });
});

describe('AI behavior channels (NXR-053)', () => {
  interface View {
    settings: unknown;
    lockedRules: string[];
    unsupported: { mode: string; id: string; reason: string }[];
    reasoningEffort: string;
  }

  it('returns the defaults, the locked rules and the unsupported options with reasons', async () => {
    const result = await h.call<View>(CHANNELS.behaviorGet);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.settings).toEqual({
      cowork: { permission: 'drafts-only' },
      code: { permission: 'auto-edit' },
    });
    expect(result.value.lockedRules.join(' ')).toMatch(/sandbox/);
    expect(result.value.lockedRules.join(' ')).toMatch(/never commit or push/);
    expect(result.value.unsupported.map((o) => `${o.mode}:${o.id}`)).toEqual([
      'code:ask-before-edits',
      'code:full-auto',
    ]);
    expect(result.value.unsupported.every((o) => /Not supported yet/.test(o.reason))).toBe(true);
    expect(result.value.reasoningEffort).toMatch(/not supported yet/);
  });

  it('applies a patch, persists it and never changes the locked rules or unsupported list', async () => {
    const before = await h.call<View>(CHANNELS.behaviorGet);
    const set = await h.call<View>(CHANNELS.behaviorSet, {
      cowork: { permission: 'read-only', preferredResourceId: 'local-echo' },
      code: { permission: 'plan' },
    });
    expect(set.ok && set.value.settings).toEqual({
      cowork: { permission: 'read-only', preferredResourceId: 'local-echo' },
      code: { permission: 'plan' },
    });
    if (before.ok && set.ok) {
      expect(set.value.lockedRules).toEqual(before.value.lockedRules);
      expect(set.value.unsupported).toEqual(before.value.unsupported);
    }
    const file = JSON.parse(
      await readFile(join(h.userData, 'desktop-settings.json'), 'utf8'),
    ) as Record<string, unknown>;
    expect(file['behavior']).toEqual({
      cowork: { permission: 'read-only', preferredResourceId: 'local-echo' },
      code: { permission: 'plan' },
    });
    const cleared = await h.call<View>(CHANNELS.behaviorSet, {
      cowork: { preferredResourceId: null },
    });
    expect(cleared.ok && cleared.value.settings).toEqual({
      cowork: { permission: 'read-only' },
      code: { permission: 'plan' },
    });
  });

  it('accepts an empty patch and rejects a resource that is not in the registry', async () => {
    expect((await h.call(CHANNELS.behaviorSet, {})).ok).toBe(true);
    const unknown = await h.call(CHANNELS.behaviorSet, {
      code: { preferredResourceId: 'not-a-resource' },
    });
    expect(unknown).toEqual({
      ok: false,
      error: { code: 'VALIDATION_ERROR', message: 'Unknown resource' },
    });
    const state = await h.call<View>(CHANNELS.behaviorGet);
    expect(state.ok && state.value.settings).toEqual({
      cowork: { permission: 'drafts-only' },
      code: { permission: 'auto-edit' },
    });
  });

  it('fails closed on a damaged behavior section without rewriting it', async () => {
    const path = join(h.userData, 'desktop-settings.json');
    await writeFile(
      path,
      JSON.stringify({
        theme: 'light',
        density: 'comfortable',
        mode: 'cowork',
        behavior: { code: { permission: 'full-auto' } },
      }),
    );
    const damaged = await createHarness({ settings: new SettingsStore(path) });
    try {
      for (const result of [
        await damaged.call(CHANNELS.behaviorGet),
        await damaged.call(CHANNELS.behaviorSet, { code: { permission: 'plan' } }),
      ]) {
        expect(result).toEqual({
          ok: false,
          error: { code: 'CONFIGURATION_ERROR', message: 'The AI behavior settings are not valid' },
        });
      }
      expect((JSON.parse(await readFile(path, 'utf8')) as { behavior?: unknown }).behavior).toEqual(
        {
          code: { permission: 'full-auto' },
        },
      );
    } finally {
      await damaged.cleanup();
    }
  });
});
