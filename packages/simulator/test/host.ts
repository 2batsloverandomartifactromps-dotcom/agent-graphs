import { createApp, sweepOnce } from '@agent-graphs/server';
import type { SimHost } from '../src/index';

/** An in-memory server whose clock is the simulation's fake clock. */
export function memoryHost(start = Date.UTC(2026, 9, 2, 9)): SimHost & {
  app: ReturnType<typeof createApp>;
} {
  const clock = { now: start };
  const app = createApp({ now: () => clock.now });
  return {
    app,
    baseUrl: 'http://sim.local',
    fetch: ((input: string | URL | Request, init?: RequestInit) =>
      app.request(input instanceof Request ? input : String(input), init)) as typeof fetch,
    now: () => clock.now,
    advance: async (ms: number) => {
      clock.now += ms;
      sweepOnce(app.ctx);
    },
  };
}
