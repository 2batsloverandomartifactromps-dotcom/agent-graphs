/**
 * End-to-end: create a graph from a spec, watch live progress on the canvas, approve a gate
 * from the Inbox, resolve an exhaustion escalation, edit a node prompt (a change directive is
 * created), and see the agent's acknowledgment arrive live. Agents are played over REST.
 */
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { expect, type Page, test } from '@playwright/test';
import {
  ack,
  actors,
  claim,
  completeTask,
  directives,
  evaluate,
  failAttempt,
  heartbeat,
  node,
  submit,
} from './api.ts';
import { seedDemo } from './seed-demo.ts';

const SHOTS = fileURLToPath(new URL('./screenshots/', import.meta.url));
const SPEC = readFileSync(
  fileURLToPath(new URL('../../../examples/graphs/notes-app.yaml', import.meta.url)),
  'utf8',
);
const G = 'notes-mvp';

test.describe.configure({ mode: 'serial' });

async function card(page: Page, key: string) {
  return page.getByTestId(`node-${key}`);
}

async function shot(page: Page, name: string) {
  await page.waitForTimeout(600);
  // JPEG keeps each capture well under 300 KB.
  await page.screenshot({ path: `${SHOTS}${name}.jpg`, type: 'jpeg', quality: 85 });
}

test.beforeEach(async ({ page }) => {
  await page.addInitScript(() => {
    if (!localStorage.getItem('agent-graphs.settings'))
      localStorage.setItem(
        'agent-graphs.settings',
        JSON.stringify({ state: { theme: 'dark', actorName: 'Maintainer' }, version: 0 }),
      );
  });
});

test('create a graph from a spec and start it', async ({ page }) => {
  await page.goto('/graphs/new');
  await expect(page.getByRole('heading', { name: 'New graph' })).toBeVisible();
  const editor = page.locator('.cm-content').first();
  await editor.click();
  await page.keyboard.press('ControlOrMeta+A');
  await page.keyboard.press('Delete');
  await page.keyboard.insertText(SPEC);
  const validation = page.getByTestId('validation');
  await expect(validation.getByText('Valid spec')).toBeVisible();
  await expect(validation).toContainText('16 nodes');
  // The preview canvas renders the spec before it exists on the server.
  await expect(page.getByTestId('node-implement-api')).toBeVisible();
  await page.getByRole('button', { name: 'Create & start' }).click();
  await expect(page).toHaveURL(new RegExp(`/graphs/${G}$`));
  await expect(page.getByRole('heading', { name: 'Notes app — MVP build' })).toBeVisible();
  await expect(page.locator('.gh').getByText('Active', { exact: true })).toBeVisible();
  await expect(await card(page, 'requirements')).toHaveAttribute('data-status', 'ready');
});

test('live progress appears on the canvas', async ({ page }) => {
  await page.goto(`/graphs/${G}`);
  const requirements = await card(page, 'requirements');
  await expect(requirements).toHaveAttribute('data-status', 'ready');
  await expect(page.getByTestId('live-indicator')).toHaveText(/Live/);

  const attempt = await claim(G, 'requirements', actors.ui);
  await expect(requirements).toHaveAttribute('data-status', 'running');
  await heartbeat(attempt, { progress: 40, step: 'Drafting the auth section' });
  await expect(requirements).toContainText('Drafting the auth section');
  await expect(requirements).toContainText('40%');

  await submit(attempt, {
    summary: 'Wrote docs/requirements.md',
    notes: [
      {
        type: 'deliverable',
        title: 'Requirements doc',
        evidence: [{ kind: 'file', value: 'docs/requirements.md' }],
      },
    ],
  });
  await expect(requirements).toHaveAttribute('data-status', 'evaluating');
  const aim = (await node(G, 'requirements')).aims[0];
  await evaluate(
    attempt,
    aim?.key as string,
    'met',
    'Covers everything and each item is testable.',
  );
  await expect(requirements).toHaveAttribute('data-status', 'done');

  await completeTask(G, 'architecture', actors.builder);
  await expect(await card(page, 'architecture')).toHaveAttribute('data-status', 'done');
  // The plan-review gate becomes ready and waits for a human.
  await expect(await card(page, 'plan-review')).toHaveAttribute('data-status', 'needs_input');
  await expect(page.locator('.gh')).toContainText('2 done');
});

test('approve a gate from the Inbox', async ({ page }) => {
  await page.goto('/inbox');
  const request = page.locator('[data-subject="gate"]').filter({ hasText: 'Approve: Plan review' });
  await expect(request).toBeVisible();
  await shot(page, 'inbox');
  await request.getByRole('button', { name: 'Approve' }).click();
  await expect(request).toHaveCount(0);
  await expect.poll(async () => (await node(G, 'plan-review')).status).toBe('done');
  await page.goto(`/graphs/${G}`);
  await expect(await card(page, 'plan-review')).toHaveAttribute('data-status', 'done');
  await expect(await card(page, 'docs')).toHaveAttribute('data-status', 'ready');
});

test('resolve an exhaustion escalation', async ({ page }) => {
  await page.goto('/inbox');
  const attempt = await claim(G, 'docs', actors.writer);
  await failAttempt(attempt, 'The docs toolchain is missing in this environment.', false);
  const request = page
    .locator('[data-subject="exhaustion"]')
    .filter({ hasText: 'User documentation' });
  await expect(request).toBeVisible();
  await expect(request.getByRole('button', { name: /Retry/ })).toHaveAttribute(
    'aria-pressed',
    'true',
  );
  await request.getByLabel('Extra attempts').fill('2');
  await request.getByRole('button', { name: 'Apply decision' }).click();
  await expect(request).toHaveCount(0);
  await expect.poll(async () => (await node(G, 'docs')).status).toBe('ready');
  await page.getByRole('button', { name: 'Resolved' }).click();
  await expect(
    page.getByTestId(/^resolved-/).filter({ hasText: 'User documentation' }),
  ).toContainText('retry');
});

test('edit a node prompt, then see the change directive acknowledged', async ({ page }) => {
  const attempt = await claim(G, 'docs', actors.writer);
  await page.goto(`/graphs/${G}/nodes/docs?tab=config`);
  await expect(
    page.getByText('An agent is working on this node. Saving sends a change directive.'),
  ).toBeVisible();
  const prompt = page.getByLabel('Prompt');
  await prompt.fill(
    'Write README.md (setup, deploy) and docs/user-guide.md. Include a troubleshooting section.',
  );
  await page.getByRole('button', { name: 'Review & save' }).click();
  await page.getByRole('button', { name: 'Save changes' }).click();
  const change = page.getByTestId('change-directive');
  await expect(change).toBeVisible();
  await expect(change.getByTestId('directive-status')).toHaveText(/pending|delivered/);

  // The agent sees it on its next heartbeat and acknowledges it.
  await heartbeat(attempt, { progress: 10, step: 'Reading the updated prompt' });
  const directive = (await directives(G)).find((d) => d.kind === 'change');
  expect(directive).toBeDefined();
  await expect(change.getByTestId('directive-status')).toHaveText(/delivered/);
  await ack(directive?.id as string, attempt, 'Added a troubleshooting section to the plan.');
  await expect(change.getByTestId('directive-status')).toHaveText(/acknowledged/);
  await expect(change).toContainText('Added a troubleshooting section to the plan.');
  await shot(page, 'node-config-directive');
});

test('screenshots of key screens', async ({ page }) => {
  // A richer, mockup-like state in a second graph.
  const demo = await seedDemo('notes-demo');
  await page.goto('/');
  await expect(page.getByText('Active graphs').first()).toBeVisible();
  await shot(page, 'overview');
  await page.goto(`/graphs/${demo}/nodes/implement-api`);
  await expect(page.getByTestId('node-implement-api')).toBeVisible();
  await shot(page, 'graph-canvas');
  await page.goto(`/graphs/${demo}/nodes/search-ui?tab=aims`);
  await expect(page.getByTestId('aim-search-p95-ms-200')).toBeVisible();
  await shot(page, 'node-aims');
  await page.goto(`/graphs/${demo}/activity`);
  await expect(page.getByTestId('audit-status')).toContainText('verified');
  await shot(page, 'graph-activity');
  await page.goto('/graphs/new');
  await expect(page.getByTestId('validation').getByText('Valid spec')).toBeVisible();
  await shot(page, 'new-graph');
  await page.evaluate(() => {
    const raw = JSON.parse(localStorage.getItem('agent-graphs.settings') ?? '{}');
    raw.state = { ...(raw.state ?? {}), theme: 'light' };
    localStorage.setItem('agent-graphs.settings', JSON.stringify(raw));
  });
  await page.goto(`/graphs/${demo}/nodes/implement-api`);
  await expect(page.getByTestId('node-implement-api')).toBeVisible();
  await shot(page, 'graph-canvas-light');
});
