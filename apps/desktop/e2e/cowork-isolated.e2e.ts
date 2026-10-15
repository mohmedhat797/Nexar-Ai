import { readFile, readdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { startModel, type FakeModel, type ControlScript } from './dsh-model.js';
import {
  addProject,
  createHarness,
  hasText,
  seedE2EConfig,
  POLL,
  type Harness,
} from './harness.js';

const command = process.env['NEXAR_SEC02_WSL_COMMAND'];
const env = { NEXAR_DESKTOP_TEST_WSL_COWORK: '1' };
let h: Harness;
const models: FakeModel[] = [];
beforeAll(async () => {
  h = await createHarness();
});
afterAll(async () => {
  await Promise.all(models.map((m) => m.close()));
  await h.dispose();
});

describe.skipIf(process.platform !== 'win32' || command === undefined)(
  'SEC02 Desktop with actual isolated Cowork',
  () => {
    async function seed(name: string, delegate = false, missing = false, script?: ControlScript) {
      const control = await startModel(
        'isolated-control',
        delegate ? { kind: 'delegate' } : script,
        models,
      );
      const userData = h.newUserData(name);
      await seedE2EConfig(userData, [
        {
          id: 'isolated-control',
          kind: 'openai-compatible',
          baseUrl: control.baseUrl,
          toolCalling: true,
        },
      ]);
      await writeFile(
        join(userData, 'desktop-settings.json'),
        JSON.stringify({
          codePlane: {
            distro: process.env['NEXAR_SEC02_WSL_DISTRO'] ?? 'nexar-plane',
            command: missing ? '/no-such-sec02-helper' : command,
            projects: {},
          },
        }),
      );
      return { userData, control };
    }
    it('creates an artifact through NRC, continues the canonical session, and restores it after restart', async () => {
      const script = {
        kind: 'write' as const,
        file: 'proposal.md',
        content: '# Initial SEC02 proposal',
        final: 'Draft complete.',
        input: '/inputs/cowork/input-1-readme-seed.txt',
      };
      const { userData, control } = await seed('isolated-draft', false, false, script);
      let { app, page } = await h.launch(userData, env);
      await addProject(app, page, h.projectDir);
      await h.close(app);
      const configPath = join(userData, 'nexar.config.json');
      const config = JSON.parse(await readFile(configPath, 'utf8')) as {
        projects: Record<string, unknown>[];
      };
      config.projects[0]!.documentSets = { cowork: [join(h.projectDir, 'readme-seed.txt')] };
      await writeFile(configPath, JSON.stringify(config));
      ({ app, page } = await h.launch(userData, env));
      await page.getByTestId('mode-cowork').click();
      await expect
        .poll(() => page.getByTestId('cowork-banner').getAttribute('data-state'), POLL)
        .toBe('ready');
      await expect
        .poll(() => page.getByTestId('cowork-banner').getAttribute('data-placement'), POLL)
        .toBe('WSL2_BUBBLEWRAP');
      await page.getByTestId('new-conversation').click();
      let expectedTurns = 0;
      for (const prompt of [
        'Write the first proposal. Remember SEC02-CONVERSATION-MARKER.',
        'Revise the prior proposal.',
      ]) {
        await page.getByLabel('Message').fill(prompt);
        await page.getByRole('button', { name: 'Send' }).click();
        expectedTurns += 1;
        await expect.poll(() => page.getByTestId('turn').count(), POLL).toBe(expectedTurns);
        await expect
          .poll(() => page.getByTestId('turn').last().getAttribute('data-state'), POLL)
          .toBe('succeeded');
        script.input = '/inputs/cowork/input-2-proposal.md';
        script.content = '# Revised SEC02 proposal';
      }
      expect(await page.getByTestId('turn').count()).toBe(2);
      await hasText(page.getByTestId('artifact-card').last(), 'proposal.md');
      await hasText(page.getByTestId('lane-effective').last(), 'Lane: cowork');
      expect(control.completions.filter((c) => c.tools).length).toBe(6);
      const artifacts = join(h.projectDir, '.nexar', 'artifacts');
      const contents = await Promise.all(
        (await readdir(artifacts)).map(async (task) =>
          readFile(join(artifacts, task, 'drafts', 'proposal.md'), 'utf8').catch(() => ''),
        ),
      );
      expect(contents.filter((s) => s.includes('seeded file content')).length).toBe(2);
      expect(
        contents.some(
          (s) => s.includes('# Revised SEC02 proposal') && s.includes('# Initial SEC02 proposal'),
        ),
      ).toBe(true);
      await h.close(app);
      ({ app, page } = await h.launch(userData, env));
      await expect.poll(() => page.getByTestId('turn').count(), POLL).toBe(2);
      await hasText(page.getByTestId('artifact-card').last(), 'proposal.md');
      await h.close(app);
    }, 240_000);
    it('delegates through the isolated MCP relay and the existing authorized bridge', async () => {
      const { userData } = await seed('isolated-delegate', true);
      const { app, page } = await h.launch(userData, env);
      await addProject(app, page, h.projectDir);
      await page.getByTestId('mode-cowork').click();
      await expect
        .poll(() => page.getByTestId('cowork-banner').getAttribute('data-state'), POLL)
        .toBe('ready');
      await page.getByTestId('new-conversation').click();
      await page.getByLabel('Message').fill('Delegate a draft and create an artifact.');
      await page.getByRole('button', { name: 'Send' }).click();
      await expect
        .poll(() => page.getByTestId('turn').last().getAttribute('data-state'), POLL)
        .toBe('succeeded');
      await hasText(page.getByTestId('artifact-card').last(), 'draft.md');
      await h.close(app);
    }, 240_000);
    it('blocks a Cowork turn when the isolated helper is unavailable', async () => {
      const { userData, control } = await seed('isolated-unavailable', false, true);
      const { app, page } = await h.launch(userData, env);
      await addProject(app, page, h.projectDir);
      await page.getByTestId('mode-cowork').click();
      await expect
        .poll(() => page.getByTestId('cowork-banner').getAttribute('data-state'), POLL)
        .toBe('startup-failed');
      await page.getByTestId('new-conversation').click();
      await page.getByLabel('Message').fill('Write a draft.');
      await page.getByRole('button', { name: 'Send' }).click();
      await expect
        .poll(() => page.getByTestId('turn').last().getAttribute('data-state'), POLL)
        .toBe('failed');
      expect(control.completions).toHaveLength(0);
      expect(await page.getByTestId('lane-fallback').count()).toBe(0);
      await h.close(app);
    }, 180_000);
  },
);
