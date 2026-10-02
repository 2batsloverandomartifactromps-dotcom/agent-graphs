/**
 * @agent-graphs/simulator: configurable fake workers, judges, a lead orchestrator, and a human
 * approver that drive graphs through the real API; a YAML scenario runner (fake clock) for
 * server tests; and live demos (`agraph simulate`).
 */
export { type HumanOptions, SimHuman } from './agents/human';
export { type JudgeOptions, SimJudge } from './agents/judge';
export { type LeadOptions, SimLead } from './agents/lead';
export { type ResolutionPolicy, Resolver } from './agents/policy';
export { SimWorker, type WorkerOptions } from './agents/worker';
export { checkInvariants } from './invariants';
export { type LiveOptions, type LiveResult, runLive } from './live';
export { satisfying, violating } from './metrics';
export {
  annotationOf,
  DEFAULT_PROFILES,
  profileByName,
  type SimulatedAgentProfile,
} from './profiles';
export { Rng } from './rng';
export {
  loadScenario,
  parseScenario,
  runScenario,
  type Scenario,
  type ScenarioResult,
  ScenarioSchema,
} from './scenario';
export {
  type SimAgent,
  type SimulationOptions,
  type SimulationResult,
  simulate,
} from './simulation';
export {
  type GateDecision,
  type Outcome,
  type Scripts,
  type SimHost,
  TERMINAL_GRAPH,
  type Verdict,
  World,
} from './world';
