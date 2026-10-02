/**
 * Closed vocabularies from docs/concepts.md. The zod schemas built in M1 derive their enums
 * from these lists, so keep them in sync with the docs (the docs are normative).
 */

export const SPEC_SCHEMA = 'agent-graphs/v1' as const;

export const GRAPH_STATUSES = [
  'draft',
  'active',
  'paused',
  'verifying',
  'completed',
  'failed',
  'cancelled',
] as const;
export type GraphStatus = (typeof GRAPH_STATUSES)[number];

export const NODE_KINDS = ['task', 'gate', 'milestone', 'group'] as const;
export type NodeKind = (typeof NODE_KINDS)[number];

export const NODE_STATUSES = [
  'pending',
  'ready',
  'running',
  'evaluating',
  'needs_input',
  'blocked',
  'paused',
  'done',
  'failed',
  'skipped',
  'cancelled',
] as const;
export type NodeStatus = (typeof NODE_STATUSES)[number];

/** Terminal statuses that satisfy downstream `requires` edges (`skipped` only per policy). */
export const NODE_TERMINAL_SUCCESS = ['done', 'skipped'] as const satisfies readonly NodeStatus[];
export const NODE_TERMINAL_FAILURE = [
  'failed',
  'cancelled',
] as const satisfies readonly NodeStatus[];

export const ATTEMPT_STATUSES = [
  'running',
  'submitted',
  'passed',
  'failed',
  'errored',
  'blocked',
  'abandoned',
  'superseded',
  'cancelled',
] as const;
export type AttemptStatus = (typeof ATTEMPT_STATUSES)[number];

export const EDGE_KINDS = ['requires', 'informs'] as const;
export type EdgeKind = (typeof EDGE_KINDS)[number];

export const AIM_KINDS = ['qualitative', 'quantitative'] as const;
export type AimKind = (typeof AIM_KINDS)[number];

export const AIM_STATUSES = ['pending', 'met', 'unmet', 'partial', 'waived'] as const;
export type AimStatus = (typeof AIM_STATUSES)[number];

export const EVALUATORS = ['self', 'agent', 'orchestrator', 'human'] as const;
export type Evaluator = (typeof EVALUATORS)[number];

export const COMPARATORS = ['gte', 'gt', 'lte', 'lt', 'eq', 'neq', 'between'] as const;
export type Comparator = (typeof COMPARATORS)[number];

export const LOOP_STATUSES = ['idle', 'active', 'satisfied', 'exhausted'] as const;
export type LoopStatus = (typeof LOOP_STATUSES)[number];

export const EXHAUSTION_POLICIES = ['escalate', 'fail', 'skip', 'accept'] as const;
export type ExhaustionPolicy = (typeof EXHAUSTION_POLICIES)[number];

export const NOTE_TYPES = [
  'proof',
  'deliverable',
  'finding',
  'decision',
  'handoff',
  'progress',
  'question',
  'blocker',
  'comment',
] as const;
export type NoteType = (typeof NOTE_TYPES)[number];

export const FINDING_SEVERITIES = ['info', 'low', 'medium', 'high', 'critical'] as const;
export type FindingSeverity = (typeof FINDING_SEVERITIES)[number];

export const ORCHESTRATOR_ROLES = [
  'lead',
  'reviewer',
  'integrator',
  'monitor',
  'evolver',
  'custom',
] as const;
export type OrchestratorRole = (typeof ORCHESTRATOR_ROLES)[number];

export const ORCHESTRATOR_CAPABILITIES = [
  'dispatch',
  'evaluate',
  'mutate',
  'resolve',
  'approve',
  'evolve',
] as const;
export type OrchestratorCapability = (typeof ORCHESTRATOR_CAPABILITIES)[number];

/** Procedural Graphs relation vocabulary (docs/self-evolution.md §6). Never affects scheduling. */
export const EDGE_RELATIONS = [
  'leads_to',
  'triggers',
  'provides_input_for',
  'converges_to',
] as const;
export type EdgeRelation = (typeof EDGE_RELATIONS)[number];

/** Optional self-evolution (docs/self-evolution.md). */
export const EVOLUTION_MODES = ['off', 'learn', 'propose', 'auto'] as const;
export type EvolutionMode = (typeof EVOLUTION_MODES)[number];

export const EVOLUTION_SCOPES = [
  'guidance',
  'checklists',
  'prompts',
  'executor',
  'topology',
] as const;
export type EvolutionScope = (typeof EVOLUTION_SCOPES)[number];

/**
 * Never edited automatically; any proposal touching these needs human approval.
 * `evolutionGate` is the evolution gate's configuration, not node `gate:` blocks (topology scope).
 */
export const EVOLUTION_PROTECTED = [
  'aims',
  'guards',
  'policy',
  'validationSuites',
  'evolutionGate',
  'evolution',
] as const;

export const LESSON_KINDS = ['guidance', 'pitfall', 'check'] as const;
export type LessonKind = (typeof LESSON_KINDS)[number];

export const PROPOSAL_STATUSES = [
  'proposed',
  'checking',
  'validating',
  'awaiting_approval',
  'committed',
  'rejected',
  'refused',
  'reverted',
] as const;
export type ProposalStatus = (typeof PROPOSAL_STATUSES)[number];

export const VALIDATION_STAGES = ['structural', 'counterfactual', 'replay', 'ab', 'human'] as const;
export type ValidationStage = (typeof VALIDATION_STAGES)[number];

export const REQUEST_KINDS = ['approval', 'question', 'escalation', 'blocker'] as const;
export type RequestKind = (typeof REQUEST_KINDS)[number];

/** Option catalog per subject: docs/concepts.md §11.1. */
export const REQUEST_SUBJECTS = [
  'gate',
  'aim',
  'plan',
  'proposal',
  'exhaustion',
  'loop',
  'guard',
  'stall',
  'verification',
  'milestone',
  'timeout',
  'question',
  'blocker',
] as const;
export type RequestSubject = (typeof REQUEST_SUBJECTS)[number];

export const REQUEST_STATUSES = ['open', 'resolved', 'dismissed', 'expired'] as const;
export type RequestStatus = (typeof REQUEST_STATUSES)[number];

export const REQUEST_ASSIGNEES = ['human', 'orchestrator', 'any'] as const;
export type RequestAssignee = (typeof REQUEST_ASSIGNEES)[number];

export const DIRECTIVE_KINDS = [
  'guidance',
  'change',
  'answer',
  'pause',
  'resume',
  'cancel',
] as const;
export type DirectiveKind = (typeof DIRECTIVE_KINDS)[number];

export const DIRECTIVE_TARGETS = ['graph', 'node', 'attempt', 'orchestrator', 'session'] as const;
export type DirectiveTarget = (typeof DIRECTIVE_TARGETS)[number];

export const DIRECTIVE_STATUSES = [
  'pending',
  'delivered',
  'acknowledged',
  'superseded',
  'expired',
] as const;
export type DirectiveStatus = (typeof DIRECTIVE_STATUSES)[number];

export const AIM_MODES = ['all', 'any'] as const;
export type AimMode = (typeof AIM_MODES)[number];

export const AIM_SOURCES = ['reported', 'derived'] as const;
export type AimSource = (typeof AIM_SOURCES)[number];

export const AGGREGATIONS = ['latest', 'min', 'max', 'avg', 'sum'] as const;
export type Aggregation = (typeof AGGREGATIONS)[number];

export const VERDICTS = ['met', 'unmet', 'partial', 'waived'] as const;
export type Verdict = (typeof VERDICTS)[number];

/** Server-computed metrics usable with `source: derived` (docs/concepts.md §6.3). */
export const DERIVED_METRICS = [
  'nodes_done_ratio',
  'cost_usd',
  'tokens_total',
  'elapsed_hours',
  'failed_attempts',
  'open_findings_high',
  'children_done_ratio',
] as const;
export type DerivedMetric = (typeof DERIVED_METRICS)[number];

export const PRIORITIES = ['p0', 'p1', 'p2', 'p3'] as const;
export type Priority = (typeof PRIORITIES)[number];

export const GATE_APPROVERS = ['human', 'orchestrator'] as const;
export type GateApprover = (typeof GATE_APPROVERS)[number];

/** Loops accept every exhaustion policy except `skip`. */
export const LOOP_EXHAUSTION_POLICIES = ['escalate', 'fail', 'accept'] as const;
export type LoopExhaustionPolicy = (typeof LOOP_EXHAUSTION_POLICIES)[number];

export const MUTATION_POLICIES = ['locked', 'append', 'open'] as const;
export type MutationPolicy = (typeof MUTATION_POLICIES)[number];

export const ORCHESTRATOR_STATUSES = ['idle', 'active', 'paused', 'stopped'] as const;
export type OrchestratorStatus = (typeof ORCHESTRATOR_STATUSES)[number];

export const SESSION_STATUSES = ['active', 'idle', 'ended', 'lost'] as const;
export type SessionStatus = (typeof SESSION_STATUSES)[number];

export const ANNOTATION_KINDS = ['agent', 'human', 'system'] as const;
export type AnnotationKind = (typeof ANNOTATION_KINDS)[number];

export const EVIDENCE_KINDS = [
  'url',
  'file',
  'commit',
  'pr',
  'command',
  'metric',
  'image',
  'text',
  'artifact',
] as const;
export type EvidenceKind = (typeof EVIDENCE_KINDS)[number];

export const TOKEN_ROLES = ['admin', 'agent', 'viewer'] as const;
export type TokenRole = (typeof TOKEN_ROLES)[number];

/** Suggested (open) vocabularies for execution annotations. Any string is accepted. */
export const KNOWN_MODELS = [
  'claude-fable-5-1',
  'claude-opus-5-5',
  'claude-sonnet-5-5',
  'claude-haiku-4-5',
  'gpt-5',
  'gemini-2.5-pro',
] as const;
export const THINKING_LEVELS = ['off', 'low', 'medium', 'high', 'xhigh', 'max'] as const;
export const PROVIDERS = [
  'anthropic',
  'openai',
  'google',
  'aws-bedrock',
  'gcp-vertex',
  'azure',
  'local',
  'human',
] as const;
export const MECHANISMS = [
  'claude-code',
  'claude-code-web',
  'claude-agent-sdk',
  'claude-api',
  'codex',
  'gemini-cli',
  'cursor',
  'github-action',
  'mcp',
  'cli',
  'api',
  'ui',
] as const;
