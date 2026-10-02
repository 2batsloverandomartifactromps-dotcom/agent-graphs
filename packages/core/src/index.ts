/**
 * @agent-graphs/core: zod schemas, spec parse/normalize/validate, graph algorithms, the pure
 * engine (state transitions), aim evaluation, and briefing/sitrep renderers.
 *
 * Must stay pure: no I/O and no Node-only APIs, so the server, web app, and simulator can all
 * use it. Normative semantics: docs/concepts.md.
 */

export * from './briefing/index';
export * as engine from './engine/index';
export type {
  Aim,
  Attempt,
  Directive,
  DirectiveDelivery,
  DomainEvent,
  Edge,
  Effect,
  EngineCtx,
  EntityKind,
  Evaluation,
  FeedbackPacket,
  Graph,
  GraphState,
  HumanRequest,
  LessonDuty,
  Loop,
  MetricReport,
  Node,
  Note,
  Orchestrator,
  RequestOption,
} from './engine/types';
export { EngineError, SYSTEM_ACTOR, Tx } from './engine/types';
export * from './evolution/index';
export * from './graph/algorithms';
export * from './schemas/api';
export * from './schemas/common';
export * from './spec/export';
export * from './spec/json-schema';
export * from './spec/normalize';
export * from './spec/schema';
export * from './spec/validate';
export * from './util/hash';
export * from './vocab-display';
export * from './vocabulary';
