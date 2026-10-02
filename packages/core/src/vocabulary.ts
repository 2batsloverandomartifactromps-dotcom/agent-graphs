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

/** Never edited automatically; any proposal touching these needs human approval. */
export const EVOLUTION_PROTECTED = [
  'aims',
  'guards',
  'policy',
  'validationSuites',
  'gate',
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

export const DIRECTIVE_KINDS = [
  'guidance',
  'change',
  'answer',
  'pause',
  'resume',
  'cancel',
] as const;
export type DirectiveKind = (typeof DIRECTIVE_KINDS)[number];

/** Suggested (open) vocabularies for execution annotations. Any string is accepted. */
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
