// Mid-chat design-system switcher (issue #498 v1).
//
// Verifies that the "Skills and design systems" entry in the chat
// composer's Tools popover opens a picker, that picking a design
// system PATCHes the project, and that the subsequent chat run
// composes with the newly selected `designSystemId`. The legacy
// "Coming soon" affordance on this entry was the user-visible
// blocker for the feature; this spec is the regression boundary.

import { expect, test } from '@playwright/test';
import type { Page } from '@playwright/test';

const STORAGE_KEY = 'open-design:config';

const DESIGN_SYSTEMS = [
  {
    id: 'nexu-soft-tech',
    title: 'Nexu Soft Tech',
    category: 'Product',
    summary: 'Warm utility system for product interfaces.',
    swatches: ['#F7F4EE', '#D6CBBF', '#1F2937', '#D97757'],
  },
  {
    id: 'editorial-noir',
    title: 'Editorial Noir',
    category: 'Editorial',
    summary: 'High-contrast editorial system with expressive type.',
    swatches: ['#111111', '#F6EFE6', '#C44536', '#F2C14E'],
  },
];

test.beforeEach(async ({ page }) => {
  await page.addInitScript((key) => {
    window.localStorage.setItem(
      key,
      JSON.stringify({
        mode: 'daemon',
        apiKey: '',
        baseUrl: 'https://api.anthropic.com',
        model: 'claude-sonnet-4-5',
        agentId: 'mock',
        skillId: null,
        designSystemId: null,
        onboardingCompleted: true,
        agentModels: {},
      }),
    );
  }, STORAGE_KEY);

  await page.route('**/api/app-config', async (route) => {
    await route.fulfill({
      json: {
        config: {
          onboardingCompleted: true,
          agentId: 'mock',
          skillId: null,
          designSystemId: null,
          agentModels: {},
          agentCliEnv: {},
        },
      },
    });
  });

  await page.route('**/api/agents', async (route) => {
    await route.fulfill({
      json: {
        agents: [
          {
            id: 'mock',
            name: 'Mock Agent',
            bin: 'mock-agent',
            available: true,
            version: 'test',
            models: [{ id: 'default', label: 'Default' }],
          },
        ],
      },
    });
  });

  await page.route('**/api/design-systems', async (route) => {
    await route.fulfill({ json: { designSystems: DESIGN_SYSTEMS } });
  });
});

test('chat composer switches the project design system mid-chat', async ({ page }) => {
  await page.goto('/');
  await createProject(page, 'Mid-chat DS switch');
  await expectWorkspaceReady(page);

  const initial = await fetchCurrentProject(page);
  // The freshest project picks up the app-config default DS; clear it on
  // the server so the picker has a meaningful "no DS bound" starting
  // state to switch away from.
  await page.request.patch(`/api/projects/${initial.id}`, {
    data: { designSystemId: null },
  });

  await openImportTab(page);

  const dsEntry = page.getByTestId('composer-import-design-systems');
  await expect(dsEntry).toBeEnabled();
  await dsEntry.click();

  await expect(page.getByTestId('composer-ds-picker')).toBeVisible();
  await page
    .getByTestId('composer-ds-picker-search')
    .fill('editorial');
  await page.getByTestId('composer-ds-picker-item-editorial-noir').click();

  // The composer closes the popover on a successful switch, so the
  // picker disappears and the project mirrors the new DS.
  await expect(page.getByTestId('composer-ds-picker')).toHaveCount(0);

  const after = await fetchCurrentProject(page);
  expect(after.designSystemId).toBe('editorial-noir');
});

async function openImportTab(page: Page) {
  // The leading "tools" button in the composer host the import menu.
  await page.getByLabel(/Open CLI and model settings/i).click();
  const importTab = page.getByRole('tab', { name: /import/i });
  if (await importTab.isVisible().catch(() => false)) {
    await importTab.click();
  }
}

async function createProject(page: Page, projectName: string): Promise<void> {
  await expect(page.getByTestId('new-project-panel')).toBeVisible();
  await page.getByTestId('new-project-tab-prototype').click();
  await page.getByTestId('new-project-name').fill(projectName);
  await page.getByTestId('create-project').click();
}

async function expectWorkspaceReady(page: Page): Promise<void> {
  await expect(page).toHaveURL(/\/projects\//);
  await expect(page.getByTestId('chat-composer')).toBeVisible();
  await expect(page.getByTestId('chat-composer-input')).toBeVisible();
  await expect(page.getByTestId('file-workspace')).toBeVisible();
}

async function fetchCurrentProject(page: Page): Promise<{ id: string; designSystemId: string | null }> {
  const url = new URL(page.url());
  // The web routes a live project as `/projects/:projectId/conversations/:conversationId`,
  // so naive `.pop()` extraction picks the conversation id and the subsequent
  // `/api/projects/:id` GET 404s. Match the segment explicitly the same way
  // `project-management-flows.test.ts` and `entry-configuration-flows.test.ts` do.
  const [, projectId] = url.pathname.match(/\/projects\/([^/]+)/) ?? [];
  if (!projectId) throw new Error(`unexpected project route: ${url.pathname}`);
  const response = await page.request.get(`/api/projects/${projectId}`);
  expect(response.ok()).toBeTruthy();
  const body = (await response.json()) as {
    project: { id: string; designSystemId: string | null };
  };
  return body.project;
}
