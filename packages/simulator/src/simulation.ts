/** The tick loop shared by scenario runs (fake clock) and live demos (real time, compressed). */
import { SimHuman } from './agents/human';
import { SimJudge } from './agents/judge';
import { SimLead } from './agents/lead';
import { SimWorker } from './agents/worker';
import { TERMINAL_GRAPH, type World } from './world';

export type SimAgent = { readonly name: string; step(): Promise<void> };

export type TickHook = (world: World, tick: number) => Promise<void>;

export type SimulationOptions = {
  world: World;
  agents: SimAgent[];
  tickMs?: number;
  maxTicks?: number;
  /** Stop condition (default: the graph reached a terminal status). */
  until?: (world: World) => boolean;
  /** Runs before the agents on every tick (scripted actions). */
  beforeAgents?: TickHook;
  /** Wall-clock stop for live runs. */
  deadline?: number;
};

export type SimulationResult = { ticks: number; status: string };

export async function simulate(options: SimulationOptions): Promise<SimulationResult> {
  const { world } = options;
  const tickMs = options.tickMs ?? 60_000;
  const maxTicks = options.maxTicks ?? 720;
  const until =
    options.until ?? ((w: World) => TERMINAL_GRAPH.has(w.view?.graph.status ?? 'draft'));
  let tick = 0;
  for (; tick < maxTicks; tick++) {
    await world.refresh();
    if (options.beforeAgents) {
      await options.beforeAgents(world, tick);
      await world.refresh();
    }
    if (until(world)) break;
    for (const agent of options.agents) {
      await agent.step();
    }
    await world.refresh();
    if (until(world)) break;
    if (options.deadline && Date.now() > options.deadline) break;
    await world.host.advance(tickMs);
  }
  return { ticks: tick, status: world.view?.graph.status ?? 'unknown' };
}

export { SimHuman, SimJudge, SimLead, SimWorker };
