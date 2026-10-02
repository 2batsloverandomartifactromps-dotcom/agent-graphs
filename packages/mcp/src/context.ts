/**
 * Per-connection tool context: the API client, the caller's default execution annotation, and
 * the sessions learned from claims and orchestrator attachments (so capability checks work
 * without the agent juggling session ids).
 */
import type { ExecutionAnnotation } from '@agent-graphs/core';
import type { AgentGraphsClient } from '@agent-graphs/sdk';

export type ActorInput = Partial<ExecutionAnnotation>;

export type ToolContextOptions = {
  client: AgentGraphsClient;
  /** Defaults merged into every inline actor (for example from `AGENT_GRAPHS_ACTOR`). */
  actor?: ActorInput;
  /** Resolves the runtime's own session id (Claude Code `session_id`) at call time. */
  clientSessionId?: () => string | undefined;
  /** The caller's Agent Graphs session, if known up front (`AGENT_GRAPHS_SESSION`). */
  session?: string;
};

export class ToolContext {
  readonly client: AgentGraphsClient;
  /** The caller's own session, learned from claims, `next`, or attachments. */
  session: string | undefined;
  /** Attached orchestrator sessions, by graph reference (slug and id) and by role key. */
  readonly orchestrators = new Map<string, { key: string; session: string; graphId: string }>();
  private lastOrchestratorSession: string | undefined;

  constructor(private readonly options: ToolContextOptions) {
    this.client = options.client;
    this.session = options.session;
  }

  clientSessionId(): string | undefined {
    try {
      return this.options.clientSessionId?.();
    } catch {
      return undefined;
    }
  }

  /**
   * The caller's annotation for claims, attachments, and `next`. The runtime session id is
   * attached so hooks (keyed by the Claude `session_id`) renew this session's leases.
   */
  actor(override: ActorInput = {}): ActorInput {
    const clientSessionId = override.clientSessionId ?? this.clientSessionId();
    return {
      kind: 'agent',
      mechanism: 'mcp',
      ...this.options.actor,
      ...strip(override),
      ...(clientSessionId ? { clientSessionId } : {}),
    };
  }

  /** A subagent's annotation for a claim on its behalf (never inherits the runtime id). */
  subagentActor(override: ActorInput = {}): ActorInput {
    const { clientSessionId: _c, sessionId: _s, ...defaults } = this.options.actor ?? {};
    return { kind: 'agent', mechanism: 'mcp', ...defaults, ...strip(override) };
  }

  remember(session: string | undefined): void {
    if (session) this.session = session;
  }

  rememberOrchestrator(graphRefs: string[], key: string, session: string, graphId: string): void {
    for (const ref of graphRefs) this.orchestrators.set(ref, { key, session, graphId });
    this.lastOrchestratorSession = session;
    this.session ??= session;
  }

  forgetOrchestrator(graphRef: string): void {
    const entry = this.orchestrators.get(graphRef);
    if (!entry) return;
    for (const [ref, value] of this.orchestrators)
      if (value.graphId === entry.graphId && value.key === entry.key)
        this.orchestrators.delete(ref);
    if (this.lastOrchestratorSession === entry.session) this.lastOrchestratorSession = undefined;
  }

  /** The session to exercise orchestrator capabilities with on a graph. */
  orchestratorSession(graphRef?: string): string | undefined {
    if (graphRef) {
      const entry = this.orchestrators.get(graphRef);
      if (entry) return entry.session;
    }
    return this.lastOrchestratorSession ?? this.session;
  }

  /** A client that acts as the given session (or the caller's own session, when known). */
  as(session: string | undefined = this.session): AgentGraphsClient {
    return session ? this.client.withSession(session) : this.client;
  }
}

function strip<T extends object>(o: T): T {
  return Object.fromEntries(Object.entries(o).filter(([, v]) => v !== undefined)) as T;
}
