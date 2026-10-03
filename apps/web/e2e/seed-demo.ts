/**
 * Seeds a demo state close to the design mockup (for screenshots and manual review):
 *   node apps/web/e2e/seed-demo.ts            (server on E2E_API_URL, default :4747)
 */
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import {
  actors,
  approveGateViaApi,
  block,
  call,
  claim,
  completeTask,
  createGraph,
  heartbeat,
  note,
  submit,
} from './api.ts';

export async function seedDemo(slug = 'notes-mvp', title?: string): Promise<string> {
  const path = fileURLToPath(new URL('../../../examples/graphs/notes-app.yaml', import.meta.url));
  let yaml = readFileSync(path, 'utf8').replace('slug: notes-mvp', `slug: ${slug}`);
  if (title) yaml = yaml.replace(/^title: .*$/m, `title: ${title}`);
  await createGraph(yaml, true);
  const g = slug;
  // Orchestrators attach with their own sessions.
  await call('POST', `/graphs/${g}/orchestrators/lead/attach`, {
    actor: {
      kind: 'agent',
      agent: 'Lead',
      model: 'claude-opus-5-5',
      thinking: 'high',
      provider: 'anthropic',
      mechanism: 'claude-code',
    },
  });
  await call('POST', `/graphs/${g}/orchestrators/reviewer/attach`, {
    actor: {
      kind: 'agent',
      agent: 'Reviewer',
      model: 'claude-sonnet-5-5',
      thinking: 'medium',
      provider: 'anthropic',
      mechanism: 'claude-agent-sdk',
    },
  });
  await completeTask(g, 'requirements', actors.ui);
  await completeTask(g, 'architecture', actors.builder);
  await approveGateViaApi(g, 'plan-review');
  await completeTask(g, 'db-schema', actors.ui);
  await completeTask(g, 'ui-shell', actors.ui);
  // implement-api: running with progress and notes
  const api = await claim(g, 'implement-api', actors.builder);
  await heartbeat(api, {
    progress: 64,
    step: 'Fixing auth middleware per test feedback',
    usage: { inputTokens: 1_800_000, outputTokens: 90_000, costUsd: 2.1 },
  });
  await note(api, {
    type: 'decision',
    title: 'Use argon2id for password hashing',
    body: 'bcrypt was the alternative; argon2id is memory-hard.',
  });
  await note(api, {
    type: 'finding',
    severity: 'medium',
    title: 'Refresh tokens are not rotated',
    body: 'Rotation lands in this attempt.',
  });
  await call('POST', `/graphs/${g}/requests`, {
    kind: 'question',
    title: 'Should deleted notes be soft-deleted (30-day trash)?',
    body: 'The contract has `DELETE /notes/:id` but no trash routes. Soft delete adds a `deleted_at` column and a purge job.',
    node: 'implement-api',
    attempt: api,
    blocking: false,
  });
  // notes-editor-ui: running
  const editor = await claim(g, 'notes-editor-ui', actors.ui);
  await heartbeat(editor, { progress: 30, step: 'Building the editor with optimistic updates' });
  // search-ui: submitted, awaiting the human and the reviewer
  const search = await claim(g, 'search-ui', {
    ...actors.ui,
    agent: 'search-builder',
    thinking: 'high',
    mechanism: 'claude-code',
  });
  await submit(search, {
    summary: 'Search with debounced queries and tag filters.',
    metrics: { search_p95_ms: 140 },
    notes: [
      {
        type: 'deliverable',
        title: 'Search UI',
        evidence: [{ kind: 'pr', value: 'https://example.com/acme/notes/pull/7' }],
      },
    ],
  });
  // security-audit: blocked on staging credentials (claimed with the required skill)
  const sec = await call<{ attempt: { id: string } }>(
    'POST',
    `/graphs/${g}/nodes/security-audit/claim`,
    {
      actor: { ...actors.builder, agent: 'sec-auditor' },
      skills: ['staging-access'],
    },
  );
  await block(
    sec.attempt.id,
    'Missing staging credentials',
    'security-audit blocked: missing staging credentials',
    'Cannot reach the staging database: STAGING_DB_URL is not provisioned for this graph.',
  );
  // docs: the only attempt failed for good, so the policy escalates to a human.
  const docs = await claim(g, 'docs', actors.writer);
  await heartbeat(docs, { progress: 20, step: 'Setting up the docs toolchain' });
  await call('POST', `/attempts/${docs}/fail`, {
    reason: 'The docs toolchain is missing in this environment.',
    retryable: false,
  });
  return g;
}

if (import.meta.url === `file://${process.argv[1]}`) {
  seedDemo(process.argv[2]).then(
    (g) => console.log(`seeded ${g}`),
    (e) => {
      console.error(e);
      process.exit(1);
    },
  );
}
