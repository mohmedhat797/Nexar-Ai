import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { Page } from 'playwright-core';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { NexarApi } from '../src/shared/api.js';
import { createHarness, hasText, isVisible, POLL, type Harness } from './harness.js';

let harness: Harness;
beforeAll(async () => {
  harness = await createHarness();
});
afterAll(async () => {
  await harness.dispose();
});
const A = 'synthetic-gui-account-A-123456',
  B = 'synthetic-gui-account-B-123456',
  C = 'synthetic-gui-rotated-B-123456';
async function providers(page: Page): Promise<void> {
  await page.getByTestId('nav-settings').click();
  await page.getByRole('tab', { name: 'Providers', exact: true }).click();
  await isVisible(page.getByRole('region', { name: 'Connections', exact: true }));
}
async function resourceIds(page: Page): Promise<string[]> {
  return page.evaluate(async () => {
    const api = (globalThis as unknown as { nexar: NexarApi }).nexar;
    const result = await api.listResources({ refresh: true });
    if (!result.ok) throw Error('Resource listing failed');
    return result.value
      .map((r) => r.id)
      .filter((id) => id.startsWith('catalog:'))
      .sort();
  });
}
const row = (page: Page, label: string) => page.getByRole('article', { name: label, exact: true });
async function add(page: Page, label: string, key: string): Promise<void> {
  await page.getByLabel('Connection provider', { exact: true }).selectOption('openai');
  await page.getByLabel('Connection label', { exact: true }).fill(label);
  await page.getByLabel('Connection API key', { exact: true }).fill(key);
  await page.getByRole('button', { name: 'Add connection', exact: true }).click();
  await hasText(row(page, label), 'ACTIVE');
  await hasText(row(page, label), 'Credential: present');
}
async function confirm(page: Page, action: 'remove' | 'forget', label: string): Promise<void> {
  await row(page, label)
    .getByRole('button', {
      name: action === 'remove' ? 'Remove connection' : 'Forget credentials',
      exact: true,
    })
    .click();
  await isVisible(page.getByRole('dialog', { name: 'Confirm connection action' }));
  if (action === 'forget') await page.getByLabel('Connection name confirmation').fill(label);
  await page.getByRole('button', { name: 'Confirm connection action', exact: true }).click();
}
async function rotate(page: Page, label: string, key: string): Promise<void> {
  await row(page, label)
    .getByRole('button', { name: 'Rotate / re-enter key', exact: true })
    .click();
  await page.getByLabel('Connection API key', { exact: true }).fill(key);
  expect(
    await page.getByRole('button', { name: 'Confirm rotation', exact: true }).isDisabled(),
  ).toBe(true);
  await page
    .getByRole('checkbox', {
      name: 'I confirm this key belongs to the same account',
      exact: true,
    })
    .check();
  await page.getByRole('button', { name: 'Confirm rotation', exact: true }).click();
  await hasText(row(page, label), 'Owner asserted same account');
  await expect
    .poll(() => page.getByRole('form', { name: 'Add API connection' }).isVisible(), POLL)
    .toBe(true);
}

describe('Desktop connection authority', () => {
  it('manages two persisted accounts through real IPC and production resource publication', async () => {
    const userData = harness.newUserData('multi-connections');
    let launched = await harness.launch(userData);
    let page = launched.page;
    try {
      expect(
        await launched.app.evaluate(({ safeStorage }) => safeStorage.isEncryptionAvailable()),
      ).toBe(true);
      await providers(page);
      const original = await resourceIds(page);
      await add(page, 'GUI account A', A);
      const withA = await resourceIds(page),
        idsA = withA.filter((id) => !original.includes(id));
      expect(idsA.length).toBeGreaterThan(0);
      await add(page, 'GUI account B', B);
      const both = await resourceIds(page),
        idsB = both.filter((id) => !withA.includes(id));
      expect(idsB.length).toBe(idsA.length);
      expect(idsB.some((id) => idsA.includes(id))).toBe(false);
      await hasText(row(page, 'GUI account A'), 'Identity: Unknown');
      // Real saved preference produces host-derived consequence evidence before Remove.
      await page.getByRole('tab', { name: 'AI behavior', exact: true }).click();
      await page.getByTestId('orch-cowork-control').selectOption(idsA[0]!);
      await expect
        .poll(() => page.getByTestId('orch-cowork-control').inputValue(), POLL)
        .toBe(idsA[0]);
      await providers(page);
      await row(page, 'GUI account A')
        .getByRole('button', { name: 'Remove connection', exact: true })
        .click();
      await hasText(page.getByRole('dialog', { name: 'Confirm connection action' }), 'Cowork');
      await page.getByRole('button', { name: 'Cancel connection action', exact: true }).click();
      await hasText(row(page, 'GUI account A'), 'ACTIVE');
      expect(await resourceIds(page)).toEqual(both);
      await harness.close(launched.app);
      launched = await harness.launch(userData);
      page = launched.page;
      await providers(page);
      await hasText(row(page, 'GUI account A'), 'Credential: present');
      await hasText(row(page, 'GUI account B'), 'Credential: present');
      expect(await resourceIds(page)).toEqual(both);
      await row(page, 'GUI account A')
        .getByRole('button', { name: 'Disable connection', exact: true })
        .click();
      await hasText(row(page, 'GUI account A'), 'DISABLED');
      const disabledIds = await resourceIds(page);
      expect(disabledIds.some((id) => idsA.includes(id))).toBe(false);
      expect(idsB.every((id) => disabledIds.includes(id))).toBe(true);
      await row(page, 'GUI account A')
        .getByRole('button', { name: 'Enable connection', exact: true })
        .click();
      await hasText(row(page, 'GUI account A'), 'ACTIVE');
      await rotate(page, 'GUI account B', C);
      expect(await resourceIds(page)).toEqual(both);
      // A cancelled named Forget changes nothing, and its secret never appears as page text.
      await row(page, 'GUI account B')
        .getByRole('button', { name: 'Forget credentials', exact: true })
        .click();
      expect(
        await page
          .getByRole('button', {
            name: 'Confirm connection action',
            exact: true,
          })
          .isDisabled(),
      ).toBe(true);
      await page.getByRole('button', { name: 'Cancel connection action', exact: true }).click();
      await hasText(row(page, 'GUI account B'), 'Credential: present');
      await confirm(page, 'forget', 'GUI account B');
      await hasText(row(page, 'GUI account B'), 'Credential: absent');
      expect((await resourceIds(page)).some((id) => idsB.includes(id))).toBe(false);
      await row(page, 'GUI account B')
        .getByRole('button', { name: 'Disable connection', exact: true })
        .click();
      await hasText(row(page, 'GUI account B'), 'DISABLED');
      expect(
        await row(page, 'GUI account B')
          .getByRole('button', { name: 'Enable connection', exact: true })
          .isDisabled(),
      ).toBe(true);
      await rotate(page, 'GUI account B', B);
      await row(page, 'GUI account B')
        .getByRole('button', { name: 'Enable connection', exact: true })
        .click();
      await hasText(row(page, 'GUI account B'), 'ACTIVE');
      expect(await resourceIds(page)).toEqual(both);
      await confirm(page, 'remove', 'GUI account A');
      await hasText(row(page, 'GUI account A'), 'TOMBSTONED');
      expect((await resourceIds(page)).some((id) => idsA.includes(id))).toBe(false);
      await confirm(page, 'forget', 'GUI account A');
      await hasText(row(page, 'GUI account A'), 'Credential: absent');
      expect(
        await row(page, 'GUI account A')
          .getByRole('button', { name: 'Restore connection', exact: true })
          .isDisabled(),
      ).toBe(true);
      await rotate(page, 'GUI account A', A);
      await row(page, 'GUI account A')
        .getByRole('button', { name: 'Restore connection', exact: true })
        .click();
      await hasText(row(page, 'GUI account A'), 'ACTIVE');
      expect(await resourceIds(page)).toEqual(both);
      const body = await page.locator('body').innerText();
      const settings = await readFile(join(userData, 'desktop-settings.json'), 'utf8');
      for (const secret of [A, B, C]) {
        expect(body).not.toContain(secret);
        expect(settings).not.toContain(secret);
      }
    } finally {
      await harness.close(launched.app);
    }
  });
  it('requires explicit Plan replacement and permanently preserves the old identity', async () => {
    const userData = harness.newUserData('plan-replacement');
    let launched = await harness.launch(userData);
    try {
      let page = launched.page;
      await providers(page);
      const plan = row(page, 'ChatGPT Plan');
      await hasText(plan, 'Identity: Unknown');
      await plan.getByRole('button', { name: 'Replace Plan account', exact: true }).click();
      await hasText(
        page.getByRole('dialog', { name: 'Confirm connection action' }),
        'Permanently retire',
      );
      await page.getByRole('button', { name: 'Cancel connection action', exact: true }).click();
      expect(
        await page.getByRole('article', { name: 'ChatGPT Plan retired', exact: true }).count(),
      ).toBe(0);
      await plan.getByRole('button', { name: 'Replace Plan account', exact: true }).click();
      await page.getByRole('button', { name: 'Confirm connection action', exact: true }).click();
      await hasText(row(page, 'ChatGPT Plan retired'), 'Permanently retired');
      expect(await row(page, 'ChatGPT Plan retired').getByRole('button').count()).toBe(0);
      await hasText(row(page, 'ChatGPT Plan'), 'Credential: absent');
      const first = JSON.parse(await readFile(join(userData, 'desktop-settings.json'), 'utf8')) as {
        connections: {
          connections: Record<string, { id: string; retirement?: string; lifecycleState: string }>;
        };
      };
      const ids = Object.keys(first.connections.connections).filter((id) =>
        id.startsWith('openai.chatgpt-plan'),
      );
      expect(ids).toHaveLength(2);
      expect(ids).toContain('openai.chatgpt-plan');
      expect(first.connections.connections['openai.chatgpt-plan']?.retirement).toBe('replaced');
      await harness.close(launched.app);
      launched = await harness.launch(userData);
      page = launched.page;
      await providers(page);
      await hasText(row(page, 'ChatGPT Plan retired'), 'Permanently retired');
      await hasText(row(page, 'ChatGPT Plan'), 'Identity: Unknown');
    } finally {
      await harness.close(launched.app);
    }
  });
});
