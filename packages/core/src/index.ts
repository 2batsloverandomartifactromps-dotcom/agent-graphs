/**
 * @agent-graphs/core: zod schemas, spec parse/normalize/validate, graph algorithms, the pure
 * engine (state transitions), aim evaluation, and briefing/sitrep renderers.
 *
 * Must stay pure: no I/O and no Node-only APIs, so the server, web app, and simulator can all
 * use it. Normative semantics: docs/concepts.md. Built in milestone M1 (docs/PLAN.md §7).
 */
export * from './vocabulary';
