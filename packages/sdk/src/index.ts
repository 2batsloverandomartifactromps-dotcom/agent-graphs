/**
 * @agent-graphs/sdk: a typed fetch client for docs/api.md plus an SSE helper. It runs in Node
 * and browsers and is shared by the CLI, MCP server, simulator, and web app. Request bodies are
 * typed from the zod schemas in @agent-graphs/core; responses use the read-model shapes below
 * (times are ISO-8601 strings).
 */
import type {
  ClaimBody,
  DirectiveBody,
  EvaluateBody,
  ExecutionAnnotation,
  HeartbeatBody,
  MutationBody,
  NextBody,
  NoteBody,
  ResolveBody,
  SubmitBody,
} from '@agent-graphs/core';
import type * as T from './types';

export type * from './types';

export type ClientOptions = {
  /** Server origin, e.g. http://localhost:4747 (the `AGENT_GRAPHS_URL` env var). */
  baseUrl: string;
  /** Bearer token (`AGENT_GRAPHS_TOKEN`). Optional in `AUTH_MODE=local`. */
  token?: string;
  /** Sent as `X-Agent-Session` on every request (orchestrators exercising capabilities). */
  session?: string;
  /** Sent as `X-Actor-Name` (humans in local mode). */
  actorName?: string;
  /** Sent as `X-Client` (for example `ui`, `cli`, `mcp`). */
  client?: string;
  fetch?: typeof fetch;
};

export const DEFAULT_BASE_URL = 'http://localhost:4747';

/** An API error with the server's code and an LLM-friendly hint. */
export class AgentGraphsError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
    readonly hint?: string,
    readonly details?: unknown,
  ) {
    super(message);
    this.name = 'AgentGraphsError';
  }

  /** `message` plus the hint, for tool results and CLI output. */
  describe(): string {
    return this.hint
      ? `${this.code}: ${this.message}\nHint: ${this.hint}`
      : `${this.code}: ${this.message}`;
  }
}

type Query = Record<string, string | number | boolean | undefined>;
type RequestOptions = {
  query?: Query;
  body?: unknown;
  headers?: Record<string, string>;
  idempotencyKey?: string;
  text?: boolean;
};

const enc = encodeURIComponent;

export class AgentGraphsClient {
  readonly baseUrl: string;
  private readonly doFetch: typeof fetch;

  constructor(readonly options: ClientOptions) {
    this.baseUrl = options.baseUrl.replace(/\/+$/, '');
    this.doFetch = options.fetch ?? ((...args) => fetch(...args));
  }

  /** A copy that acts as another session (for example after attaching an orchestrator). */
  withSession(session: string | undefined): AgentGraphsClient {
    return new AgentGraphsClient({ ...this.options, ...(session ? { session } : {}) });
  }

  headers(extra: Record<string, string> = {}): Record<string, string> {
    const h: Record<string, string> = { accept: 'application/json', ...extra };
    if (this.options.token) h.authorization = `Bearer ${this.options.token}`;
    if (this.options.session) h['x-agent-session'] = this.options.session;
    if (this.options.actorName) h['x-actor-name'] = this.options.actorName;
    if (this.options.client) h['x-client'] = this.options.client;
    return h;
  }

  async request<R>(method: string, path: string, options: RequestOptions = {}): Promise<R> {
    const url = new URL(path.startsWith('/health') ? path : `/api/v1${path}`, `${this.baseUrl}/`);
    for (const [k, v] of Object.entries(options.query ?? {}))
      if (v !== undefined) url.searchParams.set(k, String(v));
    const headers = this.headers(options.headers);
    if (options.body !== undefined) headers['content-type'] = 'application/json';
    if (options.idempotencyKey) headers['idempotency-key'] = options.idempotencyKey;
    let res: Response;
    try {
      res = await this.doFetch(url, {
        method,
        headers,
        ...(options.body !== undefined ? { body: JSON.stringify(options.body) } : {}),
      });
    } catch (error) {
      throw new AgentGraphsError(
        0,
        'UNREACHABLE',
        `Cannot reach ${this.baseUrl}: ${(error as Error).message}`,
        'Start the server with `agraph serve` or set AGENT_GRAPHS_URL.',
      );
    }
    const text = await res.text();
    if (!res.ok) {
      let payload: {
        error?: { code?: string; message?: string; hint?: string; details?: unknown };
      } = {};
      try {
        payload = JSON.parse(text);
      } catch {
        // non-JSON error body
      }
      const e = payload.error ?? {};
      throw new AgentGraphsError(
        res.status,
        e.code ?? `HTTP_${res.status}`,
        e.message ?? (text || res.statusText),
        e.hint,
        e.details,
      );
    }
    if (options.text) return text as R;
    return (text ? JSON.parse(text) : undefined) as R;
  }

  // ─── Meta ─────────────────────────────────────────────────────────────────
  health() {
    return this.request<{ ok: boolean; version: string; spec: string }>('GET', '/health');
  }
  me() {
    return this.request<{ role: string; authMode: string; actor: ExecutionAnnotation }>(
      'GET',
      '/me',
    );
  }
  vocab() {
    return this.request<T.Vocab>('GET', '/vocab');
  }
  tokens() {
    return this.request<{ items: T.ApiToken[] }>('GET', '/tokens');
  }
  /** Create an API token (admin). The secret is in `token` and is shown only once. */
  createToken(body: { name: string; role: 'admin' | 'agent' | 'viewer' }) {
    return this.request<T.ApiToken & { token: string }>('POST', '/tokens', { body });
  }
  revokeToken(id: string) {
    return this.request<{ revoked: string }>('DELETE', `/tokens/${enc(id)}`);
  }

  // ─── Graphs ───────────────────────────────────────────────────────────────
  listGraphs(
    query: {
      status?: string;
      tag?: string;
      q?: string;
      archived?: 'true' | 'false' | 'all';
      stalled?: 'true' | 'false';
      sort?: string;
    } = {},
  ) {
    return this.request<{ items: T.GraphSummary[] }>('GET', '/graphs', { query });
  }
  createGraph(spec: string | Record<string, unknown>, options: { start?: boolean } = {}) {
    const body = typeof spec === 'string' ? { format: 'yaml', spec } : { spec };
    return this.request<T.GraphView & { started: boolean; requestId?: string }>('POST', '/graphs', {
      body,
      query: { start: options.start ? 'true' : undefined },
    });
  }
  validateSpec(spec: string | Record<string, unknown>) {
    const body = typeof spec === 'string' ? { format: 'yaml', spec } : { spec };
    return this.request<T.ValidationOutput>('POST', '/graphs/validate', { body });
  }
  getGraph(graph: string) {
    return this.request<T.GraphView>('GET', `/graphs/${enc(graph)}`);
  }
  patchGraph(graph: string, patch: Record<string, unknown>, version?: number) {
    return this.request<T.GraphView>('PATCH', `/graphs/${enc(graph)}`, {
      body: patch,
      ...(version !== undefined ? { headers: { 'if-match': `"${version}"` } } : {}),
    });
  }
  graphAction(
    graph: string,
    action: 'start' | 'pause' | 'resume' | 'cancel' | 'reopen' | 'archive' | 'unarchive' | 'fail',
    reason?: string,
  ) {
    return this.request<{ graph: T.GraphSummary; result?: unknown }>(
      'POST',
      `/graphs/${enc(graph)}/${action}`,
      { body: reason ? { reason } : {} },
    );
  }
  cloneGraph(graph: string, body: { title?: string; slug?: string } = {}) {
    return this.request<T.GraphView>('POST', `/graphs/${enc(graph)}/clone`, { body });
  }
  deleteGraph(graph: string) {
    return this.request<{ deleted: string }>('DELETE', `/graphs/${enc(graph)}`);
  }
  exportSpec(graph: string, format: 'yaml' | 'json' = 'yaml') {
    return format === 'yaml'
      ? this.request<string>('GET', `/graphs/${enc(graph)}/spec`, { query: { format }, text: true })
      : this.request<Record<string, unknown>>('GET', `/graphs/${enc(graph)}/spec`, {
          query: { format },
        });
  }
  mutate(graph: string, batch: MutationBody) {
    return this.request<{ revision: number; changes: string[]; graph: T.GraphView }>(
      'POST',
      `/graphs/${enc(graph)}/mutations`,
      { body: batch },
    );
  }
  sitrep(graph: string, query: { budget?: number; orchestrator?: string } = {}) {
    return this.request<string>('GET', `/graphs/${enc(graph)}/sitrep`, { query, text: true });
  }
  next(graph: string, body: NextBody = {}) {
    return this.request<T.NextResult>('POST', `/graphs/${enc(graph)}/next`, { body });
  }
  stats(graph: string) {
    return this.request<T.GraphStats>('GET', `/graphs/${enc(graph)}/stats`);
  }
  metrics(graph: string, query: { name?: string; node?: string } = {}) {
    return this.request<{ items: T.MetricReport[] }>('GET', `/graphs/${enc(graph)}/metrics`, {
      query,
    });
  }
  reportGraphMetrics(graph: string, metrics: Record<string, number>) {
    return this.request<{ graph: T.GraphSummary }>('POST', `/graphs/${enc(graph)}/metrics`, {
      body: { metrics },
    });
  }
  events(
    graph: string,
    query: { after?: number; types?: string; entity?: string; limit?: number } = {},
  ) {
    return this.request<{ items: T.StoredEvent[]; nextCursor: number | null }>(
      'GET',
      `/graphs/${enc(graph)}/events`,
      { query },
    );
  }
  verifyAudit(graph: string) {
    return this.request<{ ok: boolean; events: number; firstMismatch?: number }>(
      'GET',
      `/graphs/${enc(graph)}/audit/verify`,
    );
  }
  auditGaps(graph: string) {
    return this.request<T.AuditGaps>('GET', `/graphs/${enc(graph)}/audit/gaps`);
  }
  exportAudit(graph: string) {
    return this.request<string>('GET', `/graphs/${enc(graph)}/audit/export`, { text: true });
  }
  graphNotes(graph: string, type?: string) {
    return this.request<{ items: T.Note[] }>('GET', `/graphs/${enc(graph)}/notes`, {
      query: { type },
    });
  }
  addGraphNote(graph: string, note: NoteBody) {
    return this.request<T.Note>('POST', `/graphs/${enc(graph)}/notes`, { body: note });
  }

  // ─── Nodes ────────────────────────────────────────────────────────────────
  listNodes(graph: string, query: { status?: string; tag?: string; kind?: string } = {}) {
    return this.request<{ items: T.NodeSummary[] }>('GET', `/graphs/${enc(graph)}/nodes`, {
      query,
    });
  }
  getNode(graph: string, node: string) {
    return this.request<T.NodeDetail>('GET', `/graphs/${enc(graph)}/nodes/${enc(node)}`);
  }
  patchNode(graph: string, node: string, patch: Record<string, unknown>, version?: number) {
    return this.request<{ node: T.NodeDetail }>(
      'PATCH',
      `/graphs/${enc(graph)}/nodes/${enc(node)}`,
      {
        body: patch,
        ...(version !== undefined ? { headers: { 'if-match': `"${version}"` } } : {}),
      },
    );
  }
  briefing(graph: string, node: string, query: { budget?: number; protocol?: boolean } = {}) {
    return this.request<string>('GET', `/graphs/${enc(graph)}/nodes/${enc(node)}/briefing`, {
      query,
      text: true,
    });
  }
  claim(graph: string, node: string, body: ClaimBody = {}, idempotencyKey?: string) {
    return this.request<T.ClaimResult>('POST', `/graphs/${enc(graph)}/nodes/${enc(node)}/claim`, {
      body,
      ...(idempotencyKey ? { idempotencyKey } : {}),
    });
  }
  nodeAction(
    graph: string,
    node: string,
    action: 'pause' | 'resume' | 'skip' | 'fail' | 'retry' | 'reopen' | 'complete-manually',
    body: Record<string, unknown> = {},
  ) {
    return this.request<{ node: T.NodeSummary; result?: unknown }>(
      'POST',
      `/graphs/${enc(graph)}/nodes/${enc(node)}/${action}`,
      { body },
    );
  }
  nodeNotes(graph: string, node: string, type?: string) {
    return this.request<{ items: T.Note[] }>(
      'GET',
      `/graphs/${enc(graph)}/nodes/${enc(node)}/notes`,
      { query: { type } },
    );
  }
  addNodeNote(graph: string, node: string, note: NoteBody) {
    return this.request<T.Note>('POST', `/graphs/${enc(graph)}/nodes/${enc(node)}/notes`, {
      body: note,
    });
  }
  waiveNodeAim(graph: string, node: string, aim: string, justification: string) {
    return this.request<unknown>(
      'POST',
      `/graphs/${enc(graph)}/nodes/${enc(node)}/aims/${enc(aim)}/waive`,
      { body: { justification } },
    );
  }

  // ─── Attempts (the attempt id is the capability) ─────────────────────────
  getAttempt(attempt: string) {
    return this.request<{
      attempt: T.Attempt;
      node: T.NodeSummary;
      graph: { id: string; slug?: string; title: string; status: string };
    }>('GET', `/attempts/${enc(attempt)}`);
  }
  attemptBriefing(attempt: string, budget?: number) {
    return this.request<string>('GET', `/attempts/${enc(attempt)}/briefing`, {
      query: { budget },
      text: true,
    });
  }
  heartbeat(attempt: string, body: HeartbeatBody = {}) {
    return this.request<T.HeartbeatResult>('POST', `/attempts/${enc(attempt)}/heartbeat`, { body });
  }
  attemptDirectives(attempt: string) {
    return this.request<{ items: T.Directive[] }>('GET', `/attempts/${enc(attempt)}/directives`);
  }
  addNote(attempt: string, note: NoteBody, idempotencyKey?: string) {
    return this.request<T.Note>('POST', `/attempts/${enc(attempt)}/notes`, {
      body: note,
      ...(idempotencyKey ? { idempotencyKey } : {}),
    });
  }
  reportMetrics(attempt: string, metrics: Record<string, number>) {
    return this.request<{ recorded: number }>('POST', `/attempts/${enc(attempt)}/metrics`, {
      body: { metrics },
    });
  }
  checklist(attempt: string, items: Record<string, { done: boolean; evidence?: T.Evidence[] }>) {
    return this.request<{ checklistState: unknown }>(
      'POST',
      `/attempts/${enc(attempt)}/checklist`,
      { body: { items } },
    );
  }
  submit(attempt: string, body: SubmitBody, idempotencyKey?: string) {
    return this.request<T.SubmitResult>('POST', `/attempts/${enc(attempt)}/submit`, {
      body,
      ...(idempotencyKey ? { idempotencyKey } : {}),
    });
  }
  evaluate(attempt: string, body: EvaluateBody) {
    return this.request<{ attempt: T.Attempt; node: T.NodeSummary }>(
      'POST',
      `/attempts/${enc(attempt)}/evaluations`,
      { body },
    );
  }
  fail(attempt: string, reason: string, retryable?: boolean) {
    return this.request<{ attempt: T.Attempt; node: T.NodeSummary }>(
      'POST',
      `/attempts/${enc(attempt)}/fail`,
      { body: { reason, ...(retryable !== undefined ? { retryable } : {}) } },
    );
  }
  block(attempt: string, reason: string, request: { title: string; body?: string }) {
    return this.request<{ attempt: T.Attempt; node: T.NodeSummary; request: T.HumanRequest }>(
      'POST',
      `/attempts/${enc(attempt)}/block`,
      { body: { reason, request } },
    );
  }
  release(attempt: string, reason: string, handoff?: string) {
    return this.request<{ attempt: T.Attempt; node: T.NodeSummary }>(
      'POST',
      `/attempts/${enc(attempt)}/release`,
      { body: { reason, ...(handoff ? { handoff } : {}) } },
    );
  }

  // ─── Structure ────────────────────────────────────────────────────────────
  extendLoop(graph: string, loop: string, extraIterations: number, reason?: string) {
    return this.request<{ loop: T.Loop }>(
      'POST',
      `/graphs/${enc(graph)}/loops/${enc(loop)}/extend`,
      { body: { extraIterations, ...(reason ? { reason } : {}) } },
    );
  }
  aims(graph: string) {
    return this.request<{ graph: T.Aim[]; nodes: Array<{ key: string; aims: T.Aim[] }> }>(
      'GET',
      `/graphs/${enc(graph)}/aims`,
    );
  }
  evaluateGraphAim(
    graph: string,
    aim: string,
    body: { verdict: 'met' | 'unmet' | 'partial'; rationale?: string; evidence?: T.Evidence[] },
  ) {
    return this.request<unknown>('POST', `/graphs/${enc(graph)}/aims/${enc(aim)}/evaluations`, {
      body,
    });
  }
  waiveGraphAim(graph: string, aim: string, justification: string) {
    return this.request<unknown>('POST', `/graphs/${enc(graph)}/aims/${enc(aim)}/waive`, {
      body: { justification },
    });
  }
  pendingEvaluations(graph?: string) {
    return this.request<{
      items: Array<{
        graph: string;
        attempt: T.Attempt;
        node: { key: string; title: string };
        aims: T.Aim[];
      }>;
    }>('GET', '/evaluations/pending', { query: { graph } });
  }
  patchEdge(graph: string, edgeId: string, attrs: Record<string, string | null>) {
    return this.request<unknown>('PATCH', `/graphs/${enc(graph)}/edges/${enc(edgeId)}`, {
      body: attrs,
    });
  }

  // ─── Orchestrators ────────────────────────────────────────────────────────
  orchestrators(graph: string) {
    return this.request<{ items: T.Orchestrator[] }>('GET', `/graphs/${enc(graph)}/orchestrators`);
  }
  attach(graph: string, orchestrator: string, actor?: Partial<ExecutionAnnotation>) {
    return this.request<T.AttachResult>(
      'POST',
      `/graphs/${enc(graph)}/orchestrators/${enc(orchestrator)}/attach`,
      { body: actor ? { actor } : {} },
    );
  }
  orchestratorHeartbeat(graph: string, orchestrator: string) {
    return this.request<T.HeartbeatResult>(
      'POST',
      `/graphs/${enc(graph)}/orchestrators/${enc(orchestrator)}/heartbeat`,
      { body: {} },
    );
  }
  queue(graph: string, orchestrator: string) {
    return this.request<{ items: T.DutyItem[] }>(
      'GET',
      `/graphs/${enc(graph)}/orchestrators/${enc(orchestrator)}/queue`,
    );
  }
  detach(graph: string, orchestrator: string, handoff?: string) {
    return this.request<unknown>(
      'POST',
      `/graphs/${enc(graph)}/orchestrators/${enc(orchestrator)}/detach`,
      { body: handoff ? { handoff } : {} },
    );
  }
  orchestratorNote(graph: string, orchestrator: string, note: NoteBody) {
    return this.request<T.Note>(
      'POST',
      `/graphs/${enc(graph)}/orchestrators/${enc(orchestrator)}/notes`,
      { body: note },
    );
  }
  orchestratorControl(graph: string, orchestrator: string, action: 'pause' | 'resume' | 'stop') {
    return this.request<unknown>(
      'POST',
      `/graphs/${enc(graph)}/orchestrators/${enc(orchestrator)}/${action}`,
    );
  }

  // ─── Sessions ─────────────────────────────────────────────────────────────
  registerSession(
    body: Partial<ExecutionAnnotation> & { skills?: string[]; meta?: Record<string, unknown> },
  ) {
    return this.request<{ session: T.Session }>('POST', '/sessions', { body });
  }
  sessions(query: { status?: string; graph?: string } = {}) {
    return this.request<{ items: T.Session[] }>('GET', '/sessions', { query });
  }
  sessionHeartbeat(session: string) {
    return this.request<T.SessionHeartbeat>('POST', `/sessions/${enc(session)}/heartbeat`, {
      body: {},
    });
  }
  clientHeartbeat(clientSessionId: string) {
    return this.request<T.SessionHeartbeat & { session: string | null }>(
      'POST',
      `/sessions/by-client/${enc(clientSessionId)}/heartbeat`,
      { body: {} },
    );
  }
  sessionEvent(session: string, type: 'compacted' | 'resumed' | 'started', detail?: string) {
    return this.request<{ ok: boolean }>('POST', `/sessions/${enc(session)}/events`, {
      body: { type, ...(detail ? { detail } : {}) },
    });
  }
  endSession(session: string) {
    return this.request<{ ok: boolean }>('POST', `/sessions/${enc(session)}/end`, { body: {} });
  }

  // ─── Inbox and directives ─────────────────────────────────────────────────
  requests(query: { status?: string; graph?: string; kind?: string; assignee?: string } = {}) {
    return this.request<{ items: T.HumanRequest[] }>('GET', '/requests', { query });
  }
  raiseRequest(
    graph: string,
    body: {
      kind: 'question' | 'approval';
      title: string;
      body?: string;
      node?: string;
      attempt?: string;
      assignee?: 'human' | 'orchestrator' | 'any';
      blocking?: boolean;
    },
  ) {
    return this.request<T.HumanRequest>('POST', `/graphs/${enc(graph)}/requests`, { body });
  }
  resolveRequest(id: string, body: ResolveBody) {
    return this.request<{ request: T.HumanRequest; graph: { id: string; status: string } }>(
      'POST',
      `/requests/${enc(id)}/resolve`,
      { body },
    );
  }
  dismissRequest(id: string, reason: string) {
    return this.request<unknown>('POST', `/requests/${enc(id)}/dismiss`, { body: { reason } });
  }
  directives(graph: string, query: { status?: string; target?: string } = {}) {
    return this.request<{ items: T.Directive[] }>('GET', `/graphs/${enc(graph)}/directives`, {
      query,
    });
  }
  sendDirective(graph: string, body: DirectiveBody) {
    return this.request<T.Directive>('POST', `/graphs/${enc(graph)}/directives`, { body });
  }
  ackDirective(id: string, body: { note?: string; attemptId?: string } = {}) {
    return this.request<unknown>('POST', `/directives/${enc(id)}/ack`, { body });
  }

  // ─── Notes ────────────────────────────────────────────────────────────────
  notes(
    query: {
      graph?: string;
      type?: string;
      severity?: string;
      model?: string;
      provider?: string;
      mechanism?: string;
      node?: string;
      q?: string;
      since?: string;
      limit?: number;
    } = {},
  ) {
    return this.request<{ items: T.Note[] }>('GET', '/notes', { query });
  }
  retractNote(id: string, reason: string) {
    return this.request<T.Note>('POST', `/notes/${enc(id)}/retract`, { body: { reason } });
  }
  resolveFinding(id: string, comment: string) {
    return this.request<{ finding: T.Note; reply: T.Note }>('POST', `/notes/${enc(id)}/resolve`, {
      body: { comment },
    });
  }

  // ─── Lessons (learn mode) ─────────────────────────────────────────────────
  lessons(query: { graph?: string; node?: string; status?: string; q?: string } = {}) {
    return this.request<{ items: T.Lesson[] }>('GET', '/lessons', { query });
  }
  addLesson(body: {
    scope: unknown;
    kind: 'guidance' | 'pitfall' | 'check';
    condition?: string;
    content: string;
    evidence?: unknown;
    dutyId?: string;
  }) {
    return this.request<T.Lesson>('POST', '/lessons', { body });
  }

  // ─── Events ───────────────────────────────────────────────────────────────
  /**
   * Subscribe to live events over SSE (works in Node and browsers via fetch streaming).
   * Returns a function that stops the stream. Reconnects with Last-Event-ID.
   */
  subscribe(options: {
    graph?: string;
    graphs?: string[];
    onEvent: (e: T.LiveEvent) => void;
    onResync?: () => void;
    onError?: (error: unknown) => void;
  }): () => void {
    const controller = new AbortController();
    let lastId = 0;
    let stopped = false;
    const path = options.graph
      ? `/api/v1/graphs/${enc(options.graph)}/events/stream`
      : `/api/v1/events/stream${options.graphs ? `?graphs=${options.graphs.map(enc).join(',')}` : ''}`;
    const loop = async () => {
      while (!stopped) {
        try {
          const res = await this.doFetch(new URL(path, `${this.baseUrl}/`), {
            headers: {
              ...this.headers({ accept: 'text/event-stream' }),
              ...(lastId ? { 'last-event-id': String(lastId) } : {}),
            },
            signal: controller.signal,
          });
          if (!res.ok || !res.body)
            throw new AgentGraphsError(res.status, `HTTP_${res.status}`, 'event stream failed');
          const reader = res.body.getReader();
          const decoder = new TextDecoder();
          let buffer = '';
          while (!stopped) {
            const { value, done } = await reader.read();
            if (done) break;
            buffer += decoder.decode(value, { stream: true });
            let index = buffer.indexOf('\n\n');
            while (index >= 0) {
              const chunk = buffer.slice(0, index);
              buffer = buffer.slice(index + 2);
              const fields: Record<string, string> = {};
              for (const line of chunk.split('\n')) {
                if (!line || line.startsWith(':')) continue;
                const colon = line.indexOf(':');
                const key = colon < 0 ? line : line.slice(0, colon);
                const val = colon < 0 ? '' : line.slice(colon + 1).replace(/^ /, '');
                fields[key] = fields[key] ? `${fields[key]}\n${val}` : val;
              }
              if (fields.id) lastId = Number(fields.id);
              if (fields.event === 'resync') options.onResync?.();
              else if (fields.data && fields.event !== 'ready')
                options.onEvent(JSON.parse(fields.data) as T.LiveEvent);
              index = buffer.indexOf('\n\n');
            }
          }
        } catch (error) {
          if (stopped) return;
          options.onError?.(error);
        }
        if (!stopped) await new Promise((r) => setTimeout(r, 2000));
      }
    };
    void loop();
    return () => {
      stopped = true;
      controller.abort();
    };
  }
}

/** Minimal health probe (kept for the CLI's `health` command). */
export async function getHealth(options: ClientOptions): Promise<{ ok: boolean; version: string }> {
  return new AgentGraphsClient(options).health();
}

/** A client configured from AGENT_GRAPHS_URL / AGENT_GRAPHS_TOKEN (Node). */
export function clientFromEnv(
  env: Record<string, string | undefined> = (
    globalThis as { process?: { env: Record<string, string | undefined> } }
  ).process?.env ?? {},
  extra: Partial<ClientOptions> = {},
): AgentGraphsClient {
  return new AgentGraphsClient({
    baseUrl: env.AGENT_GRAPHS_URL ?? DEFAULT_BASE_URL,
    ...(env.AGENT_GRAPHS_TOKEN ? { token: env.AGENT_GRAPHS_TOKEN } : {}),
    ...(env.AGENT_GRAPHS_SESSION ? { session: env.AGENT_GRAPHS_SESSION } : {}),
    ...extra,
  });
}
