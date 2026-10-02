/**
 * The shared simulation environment: API clients for each kind of actor, simulated time, the
 * per-tick graph snapshot, scripted outcomes, and a log. Agents only talk to the server through
 * the sdk, exactly like real agents.
 */
import {
  AgentGraphsClient,
  AgentGraphsError,
  type GraphView,
  type HumanRequest,
} from '@agent-graphs/sdk';
import { Rng } from './rng';

/** Where the API lives and how simulated time moves. */
export type SimHost = {
  baseUrl: string;
  fetch?: typeof fetch;
  /** Token for admin actions (omit in local auth mode). */
  adminToken?: string;
  /** Simulated time (epoch ms). */
  now(): number;
  /** Advance simulated time. Scenario hosts move the server clock and sweep leases; live hosts sleep. */
  advance(ms: number): Promise<void>;
};

export type Outcome = 'pass' | 'fail' | 'error' | 'crash' | 'block' | 'release' | 'question';
export type Verdict = 'met' | 'unmet';
export type GateDecision = 'approve' | 'reject';

export type Scripts = {
  /** Per node: outcomes consumed by successive attempts (then the profile decides). */
  outcomes?: Record<string, Outcome[]>;
  /** Per node: verdicts consumed by successive judge decisions. */
  verdicts?: Record<string, Verdict[]>;
  /** Per gate: decisions consumed by successive approvals. */
  gates?: Record<string, GateDecision[]>;
};

/** Errors that are normal races between independent agents (not simulation failures). */
const EXPECTED = new Set([
  'ALREADY_CLAIMED',
  'INVALID_TRANSITION',
  'ATTEMPT_CLOSED',
  'LEASE_EXPIRED',
  'MAX_PARALLEL_REACHED',
  'CONFLICT',
  'NOT_FOUND',
]);

export class World {
  graph = '';
  view: GraphView | undefined;
  openRequests: HumanRequest[] = [];
  readonly rng: Rng;
  readonly errors: string[] = [];
  readonly lines: string[] = [];
  readonly stats = {
    claims: 0,
    submits: 0,
    passed: 0,
    failed: 0,
    crashes: 0,
    blocks: 0,
    questions: 0,
    errorsReported: 0,
    releases: 0,
    verdicts: 0,
    resolutions: 0,
    dispatches: 0,
    directivesAcked: 0,
  };
  private readonly outcomes = new Map<string, Outcome[]>();
  private readonly verdicts = new Map<string, Verdict[]>();
  private readonly gates = new Map<string, GateDecision[]>();
  agentToken: string | undefined;

  constructor(
    readonly host: SimHost,
    options: { seed?: number; scripts?: Scripts; log?: (line: string) => void } = {},
  ) {
    this.rng = new Rng(options.seed ?? 1);
    for (const [k, v] of Object.entries(options.scripts?.outcomes ?? {}))
      this.outcomes.set(k, [...v]);
    for (const [k, v] of Object.entries(options.scripts?.verdicts ?? {}))
      this.verdicts.set(k, [...v]);
    for (const [k, v] of Object.entries(options.scripts?.gates ?? {})) this.gates.set(k, [...v]);
    this.sink = options.log;
  }

  private readonly sink: ((line: string) => void) | undefined;

  now(): number {
    return this.host.now();
  }

  log(line: string): void {
    const stamp = new Date(this.now()).toISOString().slice(11, 16);
    const text = `[${stamp}] ${line}`;
    this.lines.push(text);
    this.sink?.(text);
  }

  private client(extra: { token?: string; session?: string; actorName?: string; client?: string }) {
    return new AgentGraphsClient({
      baseUrl: this.host.baseUrl,
      ...(this.host.fetch ? { fetch: this.host.fetch } : {}),
      client: extra.client ?? 'simulator',
      ...(extra.token ? { token: extra.token } : {}),
      ...(extra.session ? { session: extra.session } : {}),
      ...(extra.actorName ? { actorName: extra.actorName } : {}),
    });
  }

  /** Admin (or the human behind the UI in local mode). */
  admin(actorName?: string): AgentGraphsClient {
    return this.client({
      ...(this.host.adminToken ? { token: this.host.adminToken } : {}),
      ...(actorName ? { actorName, client: 'ui' } : {}),
    });
  }

  /** An agent-role client (optionally acting as a session). */
  agent(session?: string): AgentGraphsClient {
    return this.client({
      ...(this.agentToken
        ? { token: this.agentToken }
        : this.host.adminToken
          ? { token: this.host.adminToken }
          : {}),
      ...(session ? { session } : {}),
    });
  }

  /** Create an agent token so agents act with the agent role (falls back to the admin token). */
  async setupAgentToken(): Promise<void> {
    try {
      const t = await this.admin().createToken({ name: 'simulated-agents', role: 'agent' });
      this.agentToken = t.token;
    } catch {
      this.agentToken = undefined;
    }
  }

  async refresh(): Promise<void> {
    this.view = await this.admin().getGraph(this.graph);
    this.openRequests = (await this.admin().requests({ graph: this.graph, status: 'open' })).items;
  }

  nextOutcome(nodeKey: string): Outcome | undefined {
    return this.outcomes.get(nodeKey)?.shift();
  }
  nextVerdict(nodeKey: string): Verdict | undefined {
    return this.verdicts.get(nodeKey)?.shift();
  }
  nextGateDecision(nodeKey: string): GateDecision | undefined {
    return this.gates.get(nodeKey)?.shift();
  }

  /** Every skill any node requires (simulated agents are capable of everything by default). */
  requiredSkills(): string[] {
    return [...new Set((this.view?.nodes ?? []).flatMap((n) => n.executor.requires ?? []))];
  }

  nodeKeyOf(nodeId: string | undefined): string | undefined {
    return nodeId ? this.view?.nodes.find((n) => n.id === nodeId)?.key : undefined;
  }

  /**
   * Run an agent action; expected races are logged, anything else is recorded as an error
   * (scenarios fail on recorded errors).
   */
  async attempt<T>(who: string, what: string, fn: () => Promise<T>): Promise<T | undefined> {
    try {
      return await fn();
    } catch (error) {
      if (error instanceof AgentGraphsError && EXPECTED.has(error.code)) {
        this.log(`${who}: ${what} skipped (${error.code})`);
        return undefined;
      }
      const message =
        error instanceof AgentGraphsError
          ? error.describe()
          : ((error as Error).stack ?? String(error));
      this.errors.push(`${who}: ${what}: ${message}`);
      this.log(`${who}: ${what} FAILED: ${message.split('\n')[0]}`);
      return undefined;
    }
  }
}

export const TERMINAL_GRAPH = new Set(['completed', 'failed', 'cancelled']);
