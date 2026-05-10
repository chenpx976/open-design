import { expect, test } from '@playwright/test';
import type { Page, Response } from '@playwright/test';

const STORAGE_KEY = 'open-design:config';
const GENERATED_FILE = 'index.html';

test.describe.configure({ mode: 'serial' });

test.beforeEach(async ({ page }) => {
  test.setTimeout(60_000);
  await resetDaemonAppConfig(page);
  await page.addInitScript(({ key }) => {
    if (window.localStorage.getItem(key) != null) return;
    window.localStorage.setItem(
      key,
      JSON.stringify({
        mode: 'daemon',
        apiKey: '',
        baseUrl: 'https://api.anthropic.com',
        model: 'claude-sonnet-4-5',
        agentId: 'pi',
        skillId: null,
        designSystemId: null,
        onboardingCompleted: true,
        agentModels: { pi: { model: 'default', reasoning: 'default' } },
      }),
    );
  }, { key: STORAGE_KEY });
});

test.afterEach(async ({ page }) => {
  await resetDaemonAppConfig(page);
});

test('Pi daemon run streams thinking, tools, writes a file, and previews it', async ({ page }) => {
  await page.goto('/');
  await createProject(page, 'Pi E2E smoke');
  await expectWorkspaceReady(page);

  await sendPrompt(page, 'Create a deterministic Pi E2E smoke artifact');

  await expect(page.getByText('Thinking')).toBeVisible({ timeout: 15_000 });
  await expect(page.locator('.op-card').filter({ hasText: GENERATED_FILE })).toBeVisible({ timeout: 15_000 });
  await expect(page.getByTestId('file-workspace').getByText(GENERATED_FILE, { exact: true })).toBeVisible();
  await expect(page.getByTestId('artifact-preview-frame')).toBeVisible();
  const frame = page.frameLocator('[data-testid="artifact-preview-frame"]');
  await expect(frame.getByRole('heading', { name: 'Pi Agent E2E' })).toBeVisible();
  await expect(frame.getByText('Thinking Stream Ready')).toBeVisible();
  await expect(frame.getByText('Tool Call Ready')).toBeVisible();
  await expect(frame.getByText('Tool Result Ready')).toBeVisible();

  const { projectId } = currentProject(page);
  await expectProjectFileToContain(page, projectId, GENERATED_FILE, 'Docker Compose Ready');
});

test('Pi daemon run supports a follow-up turn in the same project', async ({ page }) => {
  await page.goto('/');
  await createProject(page, 'Pi follow-up smoke');
  await expectWorkspaceReady(page);

  await sendPrompt(page, 'Create a deterministic Pi E2E smoke artifact');
  await expect(page.getByTestId('file-workspace').getByText(GENERATED_FILE, { exact: true })).toBeVisible({ timeout: 15_000 });

  await sendPrompt(page, 'Create a follow-up deterministic Pi E2E smoke artifact');
  const frame = page.frameLocator('[data-testid="artifact-preview-frame"]');
  await expect(frame.getByRole('heading', { name: 'Pi Follow-up E2E' })).toBeVisible();

  const { projectId } = currentProject(page);
  await expectProjectFileToContain(page, projectId, GENERATED_FILE, 'Pi Follow-up E2E');
});

test('Pi daemon run persists Pi-style event history through the public runs API', async ({ page }) => {
  const projectId = `pi-api-smoke-${Date.now()}`;
  const { conversationId } = await createProjectViaApi(page, projectId, 'Pi API smoke');
  const runId = await startRunAndWaitForSuccess(page, {
    projectId,
    conversationId,
    message: 'Create a deterministic Pi API smoke artifact',
  });

  const events = await page.request.get(`/api/runs/${runId}/events`);
  expect(events.ok()).toBeTruthy();
  const eventStream = await events.text();
  expect(eventStream).toContain('thinking_delta');
  expect(eventStream).toContain('tool_use');
  expect(eventStream).toContain('tool_result');
  expect(eventStream).toContain('index.html');

  await expectProjectFileToContain(page, projectId, GENERATED_FILE, 'Pi Agent E2E');
});

async function createProject(page: Page, name: string) {
  await expect(page.getByTestId('new-project-panel')).toBeVisible();
  await page.getByTestId('new-project-tab-prototype').click();
  await page.getByTestId('new-project-name').fill(name);
  await page.getByTestId('create-project').click();
}

async function createProjectViaApi(page: Page, projectId: string, name: string) {
  const response = await page.request.post('/api/projects', {
    data: {
      id: projectId,
      name,
      skillId: null,
      designSystemId: null,
      pendingPrompt: null,
      metadata: { kind: 'prototype' },
    },
  });
  expect(response.ok()).toBeTruthy();
  return (await response.json()) as { conversationId: string };
}

async function expectWorkspaceReady(page: Page) {
  await expect(page).toHaveURL(/\/projects\//);
  await expect(page.getByTestId('chat-composer')).toBeVisible();
  await expect(page.getByTestId('file-workspace')).toBeVisible();
  await expect(page.getByText('Start a conversation')).toBeVisible();
}

async function sendPrompt(page: Page, prompt: string) {
  const input = page.getByTestId('chat-composer-input');
  const sendButton = page.getByTestId('chat-send');
  await input.click();
  await input.fill(prompt);
  await expect(input).toHaveValue(prompt);
  await expect(sendButton).toBeEnabled();
  const chatResponse = page.waitForResponse(isCreateRunResponse);
  await sendButton.click();
  const response = await chatResponse;
  expect(response.ok()).toBeTruthy();
}

async function resetDaemonAppConfig(page: Page) {
  const response = await page.request.put('/api/app-config', {
    data: {
      onboardingCompleted: true,
      agentId: 'pi',
      agentModels: { pi: { model: 'default', reasoning: 'default' } },
      skillId: null,
      designSystemId: null,
    },
  });
  expect(response.ok()).toBeTruthy();
}

async function startRunAndWaitForSuccess(
  page: Page,
  options: {
    projectId: string;
    conversationId: string;
    message: string;
  },
) {
  const requestId = `pi-${Date.now()}`;
  const response = await page.request.post('/api/runs', {
    data: {
      agentId: 'pi',
      message: options.message,
      projectId: options.projectId,
      conversationId: options.conversationId,
      assistantMessageId: `assistant-${requestId}`,
      clientRequestId: requestId,
      skillId: null,
      designSystemId: null,
      model: 'default',
      reasoning: 'default',
    },
  });
  expect(response.ok()).toBeTruthy();
  const { runId } = (await response.json()) as { runId: string };

  await expect
    .poll(async () => {
      const status = await page.request.get(`/api/runs/${runId}`);
      if (!status.ok()) return `http-${status.status()}`;
      const body = (await status.json()) as { status: string };
      return body.status;
    }, { timeout: 20_000 })
    .toBe('succeeded');

  return runId;
}

async function expectProjectFileToContain(
  page: Page,
  projectId: string,
  fileName: string,
  expected: string,
) {
  await expect
    .poll(async () => {
      const response = await page.request.get(`/api/projects/${projectId}/files/${fileName}`);
      if (!response.ok()) return '';
      return response.text();
    }, { timeout: 15_000 })
    .toContain(expected);
}

function isCreateRunResponse(response: Response): boolean {
  const url = new URL(response.url());
  return url.pathname === '/api/runs' && response.request().method() === 'POST';
}

function currentProject(page: Page): { projectId: string } {
  const current = new URL(page.url());
  const [, projects, projectId] = current.pathname.split('/');
  if (projects !== 'projects' || !projectId) {
    throw new Error(`unexpected project route: ${current.pathname}`);
  }
  return { projectId };
}
