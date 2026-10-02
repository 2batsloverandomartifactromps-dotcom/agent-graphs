/**
 * The command boundary: `run(state, ctx, fn)` executes one engine command against a loaded state,
 * settles it (readiness, verification, guards, stall), and returns the effects to persist.
 * If `fn` throws, the caller must discard `state`: it may be partially mutated.
 */
import { settle } from './transitions';
import { type DomainEvent, type EngineCtx, type EntityKind, type GraphState, Tx } from './types';

export type CommandOutput<R> = {
  result: R;
  effects: Array<{ kind: EntityKind; entity: { id?: string } }>;
  events: DomainEvent[];
};

export function run<R>(
  state: GraphState,
  ctx: EngineCtx,
  fn: (state: GraphState, tx: Tx) => R,
): CommandOutput<R> {
  const tx = new Tx(ctx);
  const result = fn(state, tx);
  if (tx.dirty.size > 0) settle(state, tx);
  return { result, effects: [...tx.dirty.values()], events: tx.events };
}

/** A deterministic context for tests and the simulator. */
export function testCtx(
  start = Date.UTC(2026, 9, 2, 12),
  actor: EngineCtx['actor'] = { kind: 'human', agent: 'tester' },
): EngineCtx & { advance(ms: number): void; as(actor: EngineCtx['actor']): EngineCtx } {
  let seq = 0;
  const ctx = {
    now: start,
    actor,
    id: (prefix: string) => `${prefix}_${String(++seq).padStart(6, '0')}`,
    advance(ms: number) {
      ctx.now += ms;
    },
    as(next: EngineCtx['actor']): EngineCtx {
      return { ...ctx, actor: next, now: ctx.now };
    },
  };
  return ctx;
}
