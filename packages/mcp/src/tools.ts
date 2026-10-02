/**
 * The MCP tools of docs/agent-protocol.md §7.1. Input schemas reuse the request schemas from
 * @agent-graphs/core; every tool calls the API through the sdk and answers with concise
 * markdown (ids and next-step hints) plus `structuredContent` mirroring the REST response.
 */
import {
  BlockBody,
  ClaimBody,
  DirectiveBody,
  EvaluateBody,
  Evidence,
  HeartbeatBody,
  MutationBody,
  NoteBody,
  ReleaseBody,
  ResolveBody,
  SubmitBody,
} from '@agent-graphs/core';
import type { ClaimResult, GraphSummary, NextResult } from '@agent-graphs/sdk';
import { z } from 'zod';
import type { ToolContext } from './context';
import {
  claimText,
  directiveLines,
  dutyLine,
  graphLine,
  heartbeatText,
  nothingReadyText,
  submitText,
} from './format';

export type ToolGroup = 'any' | 'worker' | 'orchestrator' | 'evolver';
export type ToolResult = { text: string; data?: unknown };

export type ToolDef = {
  name: string;
  group: ToolGroup;
  title: string;
  description: string;
  input: z.ZodRawShape;
  readOnly?: boolean;
  run: (args: Record<string, unknown>, ctx: ToolContext) => Promise<ToolResult>;
};

function tool<S extends z.ZodRawShape>(def: {
  name: string;
  group: ToolGroup;
  title: string;
  description: string;
  input: S;
  readOnly?: boolean;
  run: (args: z.infer<z.ZodObject<S>>, ctx: ToolContext) => Promise<ToolResult>;
}): ToolDef {
  return def as unknown as ToolDef;
}

// ─── Shared input fields ─────────────────────────────────────────────────────
const graph = z.string().min(1).describe('Graph id (gr_…) or slug.');
const nodeKey = z.string().min(1).describe('Node key (kebab-case), as shown in the sitrep.');
const attemptId = z
  .string()
  .min(1)
  .describe('Attempt id (at_…) from your claim. It is the capability for attempt calls.');
const budget = z
  .number()
  .int()
  .min(500)
  .max(100_000)
  .optional()
  .describe('Approximate token budget for the returned packet.');
const actor = (ClaimBody.shape.actor as z.ZodType).describe(
  'Your execution annotation (model, thinking, provider, mechanism, agent). Declared once at claim; everything on the attempt inherits it.',
);
const skills = ClaimBody.shape.skills.describe(
  'Skills you declare (matched against executor.requires).',
);
const spec = z
  .union([z.string(), z.record(z.string(), z.unknown())])
  .describe('A graph spec: YAML text, JSON text, or an object (schema: agent-graphs/v1).');

function specArg(s: string | Record<string, unknown>): string | Record<string, unknown> {
  if (typeof s !== 'string') return s;
  const trimmed = s.trim();
  if (trimmed.startsWith('{')) {
    try {
      return JSON.parse(trimmed) as Record<string, unknown>;
    } catch {
      // treat as YAML
    }
  }
  return s;
}

function defined<T extends object>(o: T): T {
  return Object.fromEntries(Object.entries(o).filter(([, v]) => v !== undefined)) as T;
}

function rememberClaim(ctx: ToolContext, r: { session?: string }, dispatched: boolean): void {
  if (!dispatched) ctx.remember(r.session);
}

// ─── Any profile ─────────────────────────────────────────────────────────────
const graphsList = tool({
  name: 'graphs_list',
  group: 'any',
  title: 'List graphs',
  description:
    'List execution graphs with status, progress, and open requests. Filter by status (comma-separated, e.g. "active,paused") or a text query.',
  input: {
    status: z.string().optional().describe('Comma-separated statuses, e.g. "active".'),
    q: z.string().optional().describe('Text filter on title, slug, and description.'),
  },
  readOnly: true,
  run: async (args, ctx) => {
    const r = await ctx.client.listGraphs(defined({ status: args.status, q: args.q }));
    const text = r.items.length
      ? r.items.map((g: GraphSummary) => graphLine(g)).join('\n')
      : 'No graphs match.';
    return { text, data: r };
  },
});

const graphSitrep = tool({
  name: 'graph_sitrep',
  group: 'any',
  title: 'Situation report',
  description:
    'Graph-wide situation report (markdown, token-budgeted): status, progress, running attempts, your duty queue, loops, recent events, and suggested next actions. Cheap and authoritative: call it whenever you are lost.',
  input: {
    graph,
    budget,
    orchestrator: z
      .string()
      .optional()
      .describe('Orchestrator key, to prepend its role prompt, aims, and latest handoff.'),
  },
  readOnly: true,
  run: async (args, ctx) => {
    const text = await ctx.client.sitrep(
      args.graph,
      defined({ budget: args.budget ?? 3000, orchestrator: args.orchestrator }),
    );
    return { text, data: { graph: args.graph, sitrep: text } };
  },
});

// ─── Worker profile ──────────────────────────────────────────────────────────
const nodeBriefing = tool({
  name: 'node_briefing',
  group: 'worker',
  title: 'Briefing',
  description:
    'The context packet for a node: aim, prompt, acceptance aims, directives, feedback from earlier attempts, inputs, and how to report. Pass attemptId to re-read your own briefing (after a resume or compaction), or graph + node to preview.',
  input: {
    attemptId: attemptId.optional(),
    graph: graph.optional(),
    node: nodeKey.optional(),
    budget,
  },
  readOnly: true,
  run: async (args, ctx) => {
    if (args.attemptId) {
      const text = await ctx.client.attemptBriefing(args.attemptId, args.budget);
      return { text, data: { attemptId: args.attemptId, briefing: text } };
    }
    if (!args.graph || !args.node)
      throw new UsageError('Pass attemptId, or graph and node.', 'node_briefing {attemptId}');
    const text = await ctx.client.briefing(
      args.graph,
      args.node,
      defined({ budget: args.budget ?? 6000 }),
    );
    return { text, data: { graph: args.graph, node: args.node, briefing: text } };
  },
});

const workNext = tool({
  name: 'work_next',
  group: 'worker',
  title: 'Get work',
  description:
    'Pick the best ready node for you and claim it (claim defaults to true): returns the attempt id, lease, directives, and the briefing. With role "reviewer" it returns a submitted attempt awaiting an independent verdict instead. When nothing is ready it says what is running and when to poll again.',
  input: {
    graph,
    claim: z.boolean().optional().describe('Claim the picked node (default true).'),
    role: z.enum(['worker', 'reviewer']).optional(),
    actor: actor.optional(),
    skills,
    budget,
  },
  run: async (args, ctx) => {
    const claim = args.claim ?? true;
    const r: NextResult = await ctx.client.next(
      args.graph,
      defined({
        actor: ctx.actor((args.actor ?? {}) as Record<string, string>),
        role: args.role,
        skills: args.skills,
        claim: args.role === 'reviewer' ? undefined : claim,
        briefing: claim ? { budget: args.budget ?? 6000 } : undefined,
      }),
    );
    if (args.role === 'reviewer') {
      const attempt = r.attempt;
      if (!attempt) return { text: `Nothing to review (${r.reason || 'none pending'}).`, data: r };
      const aims = (r.aims ?? []).map((a) => `- ${a.key}: ${a.title}`).join('\n');
      return {
        text: `Review attempt \`${attempt.id}\` on **${r.node?.key}** (${r.node?.title}).\nAims awaiting your verdict:\n${aims}\nRead its notes and evidence, then aim_evaluate {attemptId: "${attempt.id}", aim, verdict, rationale}.`,
        data: r,
      };
    }
    if (!r.node) return { text: nothingReadyText(r), data: r };
    if (!claim || !r.attempt) {
      return {
        text: `Best ready node: **${r.node.key}** · ${r.node.title} · ${r.node.priority} (${r.node.reason}). Claim it with node_claim {graph: "${args.graph}", node: "${r.node.key}"}.`,
        data: r,
      };
    }
    rememberClaim(ctx, r, false);
    return { text: claimText(r as unknown as ClaimResult & { node: NextResult['node'] }), data: r };
  },
});

const nodeClaim = tool({
  name: 'node_claim',
  group: 'worker',
  title: 'Claim a node',
  description:
    "Claim a specific ready node. Returns the attempt id, lease, directives, and briefing. Orchestrators dispatching a subagent pass dispatchedBy (their orchestrator key) and the subagent's intended annotation as actor; the response includes the prompt to hand to the subagent.",
  input: {
    graph,
    node: nodeKey,
    actor: actor.optional(),
    skills,
    dispatchedBy: z
      .string()
      .optional()
      .describe('Your attached orchestrator key, to claim on behalf of a subagent.'),
    budget,
  },
  run: async (args, ctx) => {
    const dispatched = Boolean(args.dispatchedBy);
    const a = (args.actor ?? {}) as Record<string, string>;
    const client = dispatched ? ctx.as(ctx.orchestratorSession(args.graph)) : ctx.client;
    const r = await client.claim(
      args.graph,
      args.node,
      defined({
        actor: dispatched ? ctx.subagentActor(a) : ctx.actor(a),
        skills: args.skills,
        dispatchedBy: args.dispatchedBy,
        briefing: { budget: args.budget ?? 6000 },
      }),
    );
    rememberClaim(ctx, r, dispatched);
    return { text: claimText(r, { nodeKey: args.node, dispatched }), data: r };
  },
});

const attemptHeartbeat = tool({
  name: 'attempt_heartbeat',
  group: 'worker',
  title: 'Heartbeat',
  description:
    'Renew your lease (at least every 5 minutes) and report progress (0-100), the current step, a small checkpoint (what is done, what is next), cumulative usage, and checklist ticks. The reply carries new directives (apply and ack them) and pause/cancel/briefing-changed flags.',
  input: { attemptId, ...HeartbeatBody.shape },
  run: async (args, ctx) => {
    const { attemptId: id, ...body } = args;
    const r = await ctx.client.heartbeat(id, defined(body) as never);
    return { text: heartbeatText(r, id), data: r };
  },
});

const noteAdd = tool({
  name: 'note_add',
  group: 'worker',
  title: 'Add a note',
  description:
    'Record a note. On your attempt (attemptId): deliverable (real output with commit/PR/file evidence), proof (command + exit code a skeptic can re-run), finding (with severity), decision (choice + alternatives), handoff (state for a stranger: done, next, traps), progress. Without attemptId, pass graph (+ node or orchestrator) for node-, orchestrator-, or graph-level notes. Never include secrets.',
  input: {
    attemptId: attemptId.optional(),
    graph: graph.optional(),
    node: nodeKey.optional(),
    orchestrator: z.string().optional().describe('Orchestrator key, for orchestrator notes.'),
    ...NoteBody.shape,
  },
  run: async (args, ctx) => {
    const { attemptId: id, graph: g, node, orchestrator, ...rest } = args;
    const note = defined(rest) as z.infer<typeof NoteBody>;
    let r: { id: string; type: string; title: string };
    if (id) r = await ctx.client.addNote(id, note);
    else if (g && orchestrator)
      r = await ctx.as(ctx.orchestratorSession(g)).orchestratorNote(g, orchestrator, note);
    else if (g && node) r = await ctx.as().addNodeNote(g, node, note);
    else if (g) r = await ctx.as().addGraphNote(g, note);
    else throw new UsageError('Pass attemptId, or graph (with node or orchestrator).');
    return { text: `Recorded ${r.type} note \`${r.id}\`: ${r.title}`, data: r };
  },
});

const metricsReport = tool({
  name: 'metrics_report',
  group: 'worker',
  title: 'Report metrics',
  description:
    'Report metric values as soon as you measure them, e.g. {"test_pass_rate": 1, "coverage": 0.91}. Quantitative aims are judged from these. Pass attemptId for your attempt, or graph for graph-level aims.',
  input: {
    attemptId: attemptId.optional(),
    graph: graph.optional(),
    metrics: z.record(z.string(), z.number()).describe('Metric name → value.'),
  },
  run: async (args, ctx) => {
    if (args.attemptId) {
      const r = await ctx.client.reportMetrics(args.attemptId, args.metrics);
      return { text: `Recorded ${r.recorded} metric(s) on ${args.attemptId}.`, data: r };
    }
    if (!args.graph) throw new UsageError('Pass attemptId or graph.');
    const r = await ctx.as().reportGraphMetrics(args.graph, args.metrics);
    return { text: `Recorded graph metric(s) on ${args.graph}.`, data: r };
  },
});

const attemptSubmit = tool({
  name: 'attempt_submit',
  group: 'worker',
  title: 'Submit',
  description:
    'Finish your attempt with a summary. Include a verdict (met/unmet/partial + rationale + evidence) for every terminating self-evaluated aim, and a value for every terminating reported metric aim. Proof and deliverable notes can be attached inline. The outcome is passed, failed (you will see why), or evaluating (a judge decides; you may stop).',
  input: { attemptId, ...SubmitBody.shape },
  run: async (args, ctx) => {
    const { attemptId: id, ...body } = args;
    const r = await ctx.client.submit(id, defined(body) as z.infer<typeof SubmitBody>);
    return { text: submitText(r), data: r };
  },
});

const attemptFail = tool({
  name: 'attempt_fail',
  group: 'worker',
  title: 'Fail',
  description:
    'Report that you cannot complete the attempt (counts as an attempt). Set retryable: false when the task is impossible as specified, so it escalates immediately.',
  input: {
    attemptId,
    reason: z.string().min(1).max(4000),
    retryable: z.boolean().optional(),
  },
  run: async (args, ctx) => {
    const r = await ctx.client.fail(args.attemptId, args.reason, args.retryable);
    return {
      text: `Attempt ${r.attempt.id} is ${r.attempt.status}; node ${r.node.key} is ${r.node.status}.`,
      data: r,
    };
  },
});

const attemptBlock = tool({
  name: 'attempt_block',
  group: 'worker',
  title: 'Block',
  description:
    'Stop on an external blocker that needs a human (credentials, access, a decision). Not counted. Opens a blocker request in the Inbox; the node returns to ready when it is resolved.',
  input: { attemptId, ...BlockBody.shape },
  run: async (args, ctx) => {
    const r = await ctx.client.block(args.attemptId, args.reason, args.request);
    return {
      text: `Attempt ${r.attempt.id} is blocked; request \`${r.request.id}\` is open for a human. You may stop.`,
      data: r,
    };
  },
});

const attemptRelease = tool({
  name: 'attempt_release',
  group: 'worker',
  title: 'Release',
  description:
    'Release the attempt voluntarily when you must stop early (not counted). Always include a handoff: current state, what is done, what is next, traps.',
  input: { attemptId, ...ReleaseBody.shape },
  run: async (args, ctx) => {
    const r = await ctx.client.release(args.attemptId, args.reason, args.handoff);
    return {
      text: `Released ${r.attempt.id}; node ${r.node.key} is ${r.node.status}.`,
      data: r,
    };
  },
});

const requestCreate = tool({
  name: 'request_create',
  group: 'worker',
  title: 'Ask a question',
  description:
    'Ask a question or request an approval from a human or orchestrator. Non-blocking by default; the answer arrives as an answer directive on your attempt.',
  input: {
    graph,
    kind: z.enum(['question', 'approval']),
    title: z.string().min(1).max(500),
    body: z.string().max(20_000).optional(),
    node: nodeKey.optional(),
    attemptId: attemptId.optional(),
    assignee: z.enum(['human', 'orchestrator', 'any']).optional(),
    blocking: z.boolean().optional(),
  },
  run: async (args, ctx) => {
    const { graph: g, attemptId: attempt, ...rest } = args;
    const r = await ctx.as().raiseRequest(g, defined({ ...rest, attempt }));
    return {
      text: `Opened ${r.kind} request \`${r.id}\` (${r.assignee}). The answer will arrive as a directive.`,
      data: r,
    };
  },
});

const directiveAck = tool({
  name: 'directive_ack',
  group: 'worker',
  title: 'Acknowledge a directive',
  description:
    'Acknowledge a directive after applying it, with a short note on how. Pass attemptId when the directive reached you on an attempt.',
  input: {
    directiveId: z.string().min(1).describe('Directive id (dr_…).'),
    attemptId: attemptId.optional(),
    note: z.string().max(4000).optional(),
  },
  run: async (args, ctx) => {
    const r = await ctx
      .as()
      .ackDirective(args.directiveId, defined({ note: args.note, attemptId: args.attemptId }));
    return { text: `Acknowledged ${args.directiveId}.`, data: r };
  },
});

const evaluationsPending = tool({
  name: 'evaluations_pending',
  group: 'worker',
  title: 'Pending evaluations',
  description:
    'Submitted attempts awaiting an independent (agent) verdict, excluding attempts your session executed.',
  input: { graph: graph.optional() },
  readOnly: true,
  run: async (args, ctx) => {
    const r = await ctx.as().pendingEvaluations(args.graph);
    if (!r.items.length) return { text: 'No evaluations pending.', data: r };
    const text = r.items
      .map(
        (p) =>
          `- \`${p.attempt.id}\` · ${p.graph} · ${p.node.key} · aims: ${p.aims.map((a) => a.key).join(', ')}`,
      )
      .join('\n');
    return {
      text: `${text}\nJudge with aim_evaluate {attemptId, aim, verdict, rationale}.`,
      data: r,
    };
  },
});

const aimEvaluate = tool({
  name: 'aim_evaluate',
  group: 'worker',
  title: 'Judge an aim',
  description:
    "Record a verdict (met/unmet/partial) on an aim of a submitted attempt, with a specific rationale (on unmet it becomes the next iteration's feedback) and evidence. You cannot judge attempts your session executed. Pass actor to judge as a distinct judge identity (for example a judge subagent).",
  input: { attemptId, ...EvaluateBody.shape, actor: actor.optional() },
  run: async (args, ctx) => {
    const { attemptId: id, actor: judge, ...body } = args;
    let session: string | undefined;
    if (judge && Object.keys(judge).length) {
      const reg = await ctx.client.registerSession(
        ctx.subagentActor(judge as Record<string, string>),
      );
      session = reg.session.id;
    } else {
      const info = await ctx.client.getAttempt(id);
      session = ctx.orchestratorSession(info.graph.slug ?? info.graph.id);
    }
    const r = await ctx.as(session).evaluate(id, defined(body) as z.infer<typeof EvaluateBody>);
    return {
      text: `Recorded ${body.verdict} on ${body.aim}; node ${r.node.key} is ${r.node.status}.`,
      data: r,
    };
  },
});

const lessonAdd = tool({
  name: 'lesson_add',
  group: 'worker',
  title: 'Record a lesson',
  description:
    'Learn mode: record what made the difference after a pass that followed failures. One or two imperative sentences plus the condition under which they apply, e.g. "When auth tests fail on refresh, check token rotation first." Pass dutyId to fulfil a lesson duty.',
  input: {
    scope: z
      .record(z.string(), z.unknown())
      .describe('Where it applies, e.g. {"graph": "notes-mvp", "node": "implement-api"}.'),
    kind: z.enum(['guidance', 'pitfall', 'check']),
    condition: z.string().max(2000).optional(),
    content: z.string().min(1).max(4000),
    evidence: z.unknown().optional(),
    dutyId: z.string().optional(),
  },
  run: async (args, ctx) => {
    const r = await ctx.as().addLesson(defined(args) as never);
    return { text: `Recorded lesson \`${r.id}\`.`, data: r };
  },
});

const lessonsSearch = tool({
  name: 'lessons_search',
  group: 'worker',
  title: 'Search lessons',
  description: 'Look up learned lessons and pitfalls for a graph or node (learn mode).',
  input: {
    graph: graph.optional(),
    node: nodeKey.optional(),
    q: z.string().optional(),
    status: z.string().optional(),
  },
  readOnly: true,
  run: async (args, ctx) => {
    const r = await ctx.client.lessons(defined(args));
    const text = r.items.length
      ? r.items.map((l) => `- \`${l.id}\` · ${l.kind} · ${l.content}`).join('\n')
      : 'No lessons match.';
    return { text, data: r };
  },
});

// ─── Orchestrator profile ────────────────────────────────────────────────────
const graphValidate = tool({
  name: 'graph_validate',
  group: 'orchestrator',
  title: 'Validate a spec',
  description:
    'Validate a graph spec (YAML or JSON). Returns errors and warnings with hints and stats. Fix every error before graph_create.',
  input: { spec },
  readOnly: true,
  run: async (args, ctx) => {
    const r = await ctx.client.validateSpec(specArg(args.spec));
    const lines = [r.ok ? 'Valid spec.' : `Invalid spec: ${r.errors.length} error(s).`];
    for (const e of r.errors)
      lines.push(`- error ${e.path}: ${e.message}${e.hint ? ` (hint: ${e.hint})` : ''}`);
    for (const w of r.warnings) lines.push(`- warning ${w.path}: ${w.message}`);
    if (r.stats)
      lines.push(
        `Stats: ${Object.entries(r.stats)
          .map(([k, v]) => `${k} ${v}`)
          .join(', ')}`,
      );
    const { normalized: _n, ...rest } = r;
    return { text: lines.join('\n'), data: rest };
  },
});

const graphCreate = tool({
  name: 'graph_create',
  group: 'orchestrator',
  title: 'Create a graph',
  description:
    'Create a graph from a spec. With start: true it starts immediately, or opens a plan-approval request when the policy requires one.',
  input: { spec, start: z.boolean().optional() },
  run: async (args, ctx) => {
    const r = await ctx.as().createGraph(specArg(args.spec), { start: args.start ?? false });
    const ref = r.graph.slug ?? r.graph.id;
    const status = r.requestId
      ? `awaiting plan approval (request \`${r.requestId}\`)`
      : r.graph.status;
    return {
      text: `Created graph **${ref}** (${r.graph.id}) · ${r.nodes.length} nodes · ${status}. Next: graph_sitrep {graph: "${ref}"}.`,
      data: { graph: r.graph, started: r.started, requestId: r.requestId },
    };
  },
});

const graphMutate = tool({
  name: 'graph_mutate',
  group: 'orchestrator',
  title: 'Change the plan',
  description:
    "Apply a batch of structural changes atomically (addNodes, updateNodes, removeNodes, addEdges, removeEdges, addLoops, …). Requires an attached orchestrator with mutate, within the graph's mutation policy. Record a decision note explaining why.",
  input: {
    ...MutationBody.shape,
    graph,
    graphPatch: MutationBody.shape.graph.describe(
      'Graph-level fields to change (title, context, constraints, defaults, …).',
    ),
  },
  run: async (args, ctx) => {
    const { graph: g, graphPatch, ...batch } = args;
    const r = await ctx
      .as(ctx.orchestratorSession(g))
      .mutate(g, defined({ ...batch, graph: graphPatch }) as never);
    return {
      text: `Applied revision ${r.revision}: ${r.changes.join('; ') || 'no changes'}.`,
      data: { revision: r.revision, changes: r.changes },
    };
  },
});

const nodeUpdate = tool({
  name: 'node_update',
  group: 'orchestrator',
  title: 'Edit a node',
  description:
    "Edit a node's configuration (prompt, executor, limits, priority, tags, checklist, …). Running attempts receive a change directive. Aims are protected (admin only). Requires mutate.",
  input: {
    graph,
    node: nodeKey,
    patch: z.record(z.string(), z.unknown()).describe('Fields to change.'),
    version: z.number().int().optional().describe('Expected node version (optimistic locking).'),
  },
  run: async (args, ctx) => {
    const r = await ctx
      .as(ctx.orchestratorSession(args.graph))
      .patchNode(args.graph, args.node, args.patch, args.version);
    return {
      text: `Updated ${r.node.key} (version ${r.node.version}).`,
      data: { node: { key: r.node.key, version: r.node.version, status: r.node.status } },
    };
  },
});

const nodeControl = tool({
  name: 'node_control',
  group: 'orchestrator',
  title: 'Control a node',
  description:
    'Pause, resume, skip (reason), fail (reason), or retry (extraAttempts) a node. Requires an attached orchestrator with resolve. Reopen needs an admin token.',
  input: {
    graph,
    node: nodeKey,
    action: z.enum(['pause', 'resume', 'skip', 'fail', 'retry', 'reopen']),
    reason: z.string().max(4000).optional(),
    extraAttempts: z.number().int().min(1).max(50).optional(),
  },
  run: async (args, ctx) => {
    const body: Record<string, unknown> = {};
    if (args.action === 'retry') body.extraAttempts = args.extraAttempts ?? 1;
    else if (args.reason) body.reason = args.reason;
    if ((args.action === 'skip' || args.action === 'fail') && !args.reason)
      throw new UsageError(`${args.action} needs a reason.`);
    const r = await ctx
      .as(ctx.orchestratorSession(args.graph))
      .nodeAction(args.graph, args.node, args.action, body);
    return { text: `${args.action}: ${r.node.key} is now ${r.node.status}.`, data: r };
  },
});

const orchestratorAttach = tool({
  name: 'orchestrator_attach',
  group: 'orchestrator',
  title: 'Attach as orchestrator',
  description:
    "Take an orchestrator role (lead, reviewer, …) on a graph. Returns the lease, your duty queue, and a sitrep with the role prompt and the previous holder's handoff. Heartbeat the role and write a handoff note before your context gets tight.",
  input: {
    graph,
    orchestrator: z.string().min(1).describe('Orchestrator key from the spec, e.g. "lead".'),
    actor: actor.optional(),
    budget,
  },
  run: async (args, ctx) => {
    const r = await ctx.client.attach(
      args.graph,
      args.orchestrator,
      ctx.actor((args.actor ?? {}) as Record<string, string>),
    );
    ctx.rememberOrchestrator(
      [args.graph, r.orchestrator.graphId],
      args.orchestrator,
      r.session,
      r.orchestrator.graphId,
    );
    const sitrep = await ctx.client.sitrep(args.graph, {
      orchestrator: args.orchestrator,
      budget: args.budget ?? 3000,
    });
    const queue = r.queue.length ? r.queue.map(dutyLine).join('\n') : '- (empty)';
    return {
      text: `Attached as **${args.orchestrator}** · session \`${r.session}\` · lease until ${r.lease.expiresAt}.\n\n**Duty queue**\n${queue}\n\n${sitrep}`,
      data: r,
    };
  },
});

const orchestratorHeartbeat = tool({
  name: 'orchestrator_heartbeat',
  group: 'orchestrator',
  title: 'Orchestrator heartbeat',
  description: 'Renew your orchestrator lease. The reply carries directives addressed to the role.',
  input: { graph, orchestrator: z.string().min(1) },
  run: async (args, ctx) => {
    const r = await ctx
      .as(ctx.orchestratorSession(args.graph))
      .orchestratorHeartbeat(args.graph, args.orchestrator);
    const lines = [`Lease renewed until ${r.leaseExpiresAt}.`];
    if (r.directives.length) lines.push(...directiveLines(r.directives));
    if (r.pauseRequested) lines.push('The graph is paused.');
    return { text: lines.join('\n'), data: r };
  },
});

const orchestratorDetach = tool({
  name: 'orchestrator_detach',
  group: 'orchestrator',
  title: 'Detach',
  description:
    'Release an orchestrator role, with a handoff for the next holder (state, open threads, next steps).',
  input: { graph, orchestrator: z.string().min(1), handoff: z.string().max(20_000).optional() },
  run: async (args, ctx) => {
    const r = await ctx
      .as(ctx.orchestratorSession(args.graph))
      .detach(args.graph, args.orchestrator, args.handoff);
    ctx.forgetOrchestrator(args.graph);
    return { text: `Detached from ${args.orchestrator}.`, data: r };
  },
});

const orchestratorQueue = tool({
  name: 'orchestrator_queue',
  group: 'orchestrator',
  title: 'Duty queue',
  description:
    'Your duty queue: ready nodes to dispatch, attempts awaiting your verdict, requests to resolve or approve, stale leases, lesson duties.',
  input: { graph, orchestrator: z.string().min(1) },
  readOnly: true,
  run: async (args, ctx) => {
    const r = await ctx.client.queue(args.graph, args.orchestrator);
    return { text: r.items.length ? r.items.map(dutyLine).join('\n') : 'Queue empty.', data: r };
  },
});

const requestResolve = tool({
  name: 'request_resolve',
  group: 'orchestrator',
  title: 'Resolve a request',
  description:
    'Resolve an Inbox request with one of its option ids (e.g. approve/reject, answer {text}, retry {extraAttempts}, extend {extraIterations}, unblock {info}). Requires resolve (or approve for gates). Rejections need a comment.',
  input: {
    requestId: z.string().min(1).describe('Request id (rq_…).'),
    graph: graph.optional().describe("The request's graph (selects your orchestrator session)."),
    ...ResolveBody.shape,
  },
  run: async (args, ctx) => {
    const { requestId, graph: g, ...body } = args;
    const r = await ctx
      .as(ctx.orchestratorSession(g))
      .resolveRequest(requestId, defined(body) as z.infer<typeof ResolveBody>);
    return {
      text: `Resolved ${requestId} with ${body.choice}; graph ${r.graph.id} is ${r.graph.status}.`,
      data: r,
    };
  },
});

const directiveSend = tool({
  name: 'directive_send',
  group: 'orchestrator',
  title: 'Send a directive',
  description:
    'Send guidance, a change notice, an answer, or a pause/resume/cancel to a graph, node, attempt, orchestrator, or session. Directives override prompts where they conflict. Requires resolve.',
  input: { graph, ...DirectiveBody.shape },
  run: async (args, ctx) => {
    const { graph: g, ...body } = args;
    const r = await ctx
      .as(ctx.orchestratorSession(g))
      .sendDirective(g, defined(body) as z.infer<typeof DirectiveBody>);
    return { text: `Sent directive \`${r.id}\` (${r.kind}): ${r.title}`, data: r };
  },
});

const aimWaive = tool({
  name: 'aim_waive',
  group: 'orchestrator',
  title: 'Waive an aim',
  description:
    'Waive a node aim (graph + node + aim) or a graph aim (graph + aim) with a justification. Waivers are prominent in the audit view. Requires resolve.',
  input: {
    graph,
    node: nodeKey.optional(),
    aim: z.string().min(1),
    justification: z.string().min(1).max(4000),
  },
  run: async (args, ctx) => {
    const c = ctx.as(ctx.orchestratorSession(args.graph));
    const r = args.node
      ? await c.waiveNodeAim(args.graph, args.node, args.aim, args.justification)
      : await c.waiveGraphAim(args.graph, args.aim, args.justification);
    return { text: `Waived ${args.node ? `${args.node}/` : ''}${args.aim}.`, data: r };
  },
});

const auditGaps = tool({
  name: 'audit_gaps',
  group: 'orchestrator',
  title: 'Audit gaps',
  description:
    'Proof and deviation gaps: done nodes without proof, nodes accepted with deviation, waived aims, manual completions, open high-severity findings.',
  input: { graph },
  readOnly: true,
  run: async (args, ctx) => {
    const r = await ctx.client.auditGaps(args.graph);
    const lines = [
      `Done without proof: ${r.doneWithoutProof.join(', ') || 'none'}`,
      `Accepted with deviation: ${r.acceptedWithDeviation.join(', ') || 'none'}${r.graphAcceptedWithDeviation ? ' (graph too)' : ''}`,
      `Waived aims: ${r.waivedAims.map((w) => w.key ?? w.aimId).join(', ') || 'none'}`,
      `Manual completions: ${r.manualCompletions.join(', ') || 'none'}`,
      `Open high findings: ${r.openHighFindings.map((f) => `${f.id} ${f.title}`).join('; ') || 'none'}`,
    ];
    return { text: lines.join('\n'), data: r };
  },
});

// ─── Evolver profile (optional self-evolution; endpoints per docs/api.md) ───
const evolutionQueue = tool({
  name: 'evolution_queue',
  group: 'evolver',
  title: 'Evolution duties',
  description:
    'Self-evolution status for a graph: mode, scores, open lesson duties, proposals, and the rejection memory.',
  input: { graph },
  readOnly: true,
  run: async (args, ctx) => {
    const r = await ctx.client.request<Record<string, unknown>>(
      'GET',
      `/graphs/${encodeURIComponent(args.graph)}/evolution`,
    );
    return { text: `\`\`\`json\n${JSON.stringify(r, null, 2)}\n\`\`\``, data: r };
  },
});

const lessonsCurate = tool({
  name: 'lessons_curate',
  group: 'evolver',
  title: 'Curate lessons',
  description:
    'Merge, revise, retire, or tag (helpful/harmful) a lesson. Requires an orchestrator with evolve.',
  input: {
    lessonId: z.string().min(1),
    action: z.enum(['merge', 'revise', 'retire', 'tag']),
    data: z.record(z.string(), z.unknown()).optional().describe('Action payload.'),
    graph: graph.optional(),
  },
  run: async (args, ctx) => {
    const r = await ctx
      .as(ctx.orchestratorSession(args.graph))
      .request<Record<string, unknown>>(
        'POST',
        `/lessons/${encodeURIComponent(args.lessonId)}/${args.action}`,
        { body: args.data ?? {} },
      );
    return { text: `${args.action}: lesson ${args.lessonId}.`, data: r };
  },
});

const proposalCreate = tool({
  name: 'proposal_create',
  group: 'evolver',
  title: 'Propose an edit',
  description:
    'Submit a small, gated edit proposal (edit-DSL ops) with a rationale and evidence naming high- and low-scoring attempts. Never re-submit something in the rejection memory. Requires evolve.',
  input: {
    graph,
    ops: z.array(z.record(z.string(), z.unknown())).min(1).max(20),
    rationale: z.string().min(1).max(10_000),
    evidence: z.array(Evidence).optional(),
    expectedEffect: z.string().max(4000).optional(),
  },
  run: async (args, ctx) => {
    const { graph: g, ...body } = args;
    const r = await ctx
      .as(ctx.orchestratorSession(g))
      .request<{ id?: string }>('POST', `/graphs/${encodeURIComponent(g)}/evolution/proposals`, {
        body: defined(body),
      });
    return { text: `Submitted proposal ${r.id ?? ''}.`.trim(), data: r };
  },
});

const proposalValidate = tool({
  name: 'proposal_validate',
  group: 'evolver',
  title: 'Record a validation stage',
  description:
    "Record the result of a validation-ladder stage (structural, counterfactual, replay, ab, human) for a proposal. You never judge your own proposal's counterfactual or replay stage.",
  input: {
    proposalId: z.string().min(1),
    stage: z.enum(['structural', 'counterfactual', 'replay', 'ab', 'human']),
    passed: z.boolean(),
    score: z.number().optional(),
    notes: z.string().max(10_000).optional(),
  },
  run: async (args, ctx) => {
    const { proposalId, ...body } = args;
    const r = await ctx
      .as()
      .request<Record<string, unknown>>(
        'POST',
        `/evolution/proposals/${encodeURIComponent(proposalId)}/validate`,
        { body: defined(body) },
      );
    return { text: `Recorded ${args.stage} for ${proposalId}.`, data: r };
  },
});

const evalReport = tool({
  name: 'eval_report',
  group: 'evolver',
  title: 'Report an evaluation run',
  description: 'Report replay or A/B evaluation run results (from a runner or CI).',
  input: {
    suite: z.string().min(1),
    results: z.record(z.string(), z.unknown()),
  },
  run: async (args, ctx) => {
    const r = await ctx.as().request<Record<string, unknown>>('POST', '/eval-runs', { body: args });
    return { text: `Reported evaluation run for ${args.suite}.`, data: r };
  },
});

/** A tool-level usage error (bad combination of arguments), reported with a hint. */
export class UsageError extends Error {
  constructor(
    message: string,
    readonly hint?: string,
  ) {
    super(message);
    this.name = 'UsageError';
  }
}

export const TOOLS: readonly ToolDef[] = [
  graphsList,
  graphSitrep,
  nodeBriefing,
  workNext,
  nodeClaim,
  attemptHeartbeat,
  noteAdd,
  metricsReport,
  attemptSubmit,
  attemptFail,
  attemptBlock,
  attemptRelease,
  requestCreate,
  directiveAck,
  evaluationsPending,
  aimEvaluate,
  lessonAdd,
  lessonsSearch,
  graphValidate,
  graphCreate,
  graphMutate,
  nodeUpdate,
  nodeControl,
  orchestratorAttach,
  orchestratorHeartbeat,
  orchestratorDetach,
  orchestratorQueue,
  requestResolve,
  directiveSend,
  aimWaive,
  auditGaps,
  evolutionQueue,
  lessonsCurate,
  proposalCreate,
  proposalValidate,
  evalReport,
];

export const PROFILE_GROUPS = {
  worker: ['any', 'worker'],
  orchestrator: ['any', 'worker', 'orchestrator'],
  evolver: ['any', 'worker', 'evolver'],
  all: ['any', 'worker', 'orchestrator', 'evolver'],
} as const satisfies Record<string, readonly ToolGroup[]>;

export function toolsFor(profile: keyof typeof PROFILE_GROUPS): ToolDef[] {
  const groups: readonly ToolGroup[] = PROFILE_GROUPS[profile];
  return TOOLS.filter((t) => groups.includes(t.group));
}
