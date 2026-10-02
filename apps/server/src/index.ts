import { serve } from '@hono/node-server';
import { createApp } from './app';

export { createApp, VERSION } from './app';
export { openDatabase } from './db/sqlite';

export type StartServerOptions = {
  port?: number;
  hostname?: string;
};

/** Starts the HTTP server. Used by `pnpm dev` and `agraph serve`. */
export function startServer(options: StartServerOptions = {}) {
  const port = options.port ?? Number(process.env.PORT ?? 4747);
  const hostname = options.hostname ?? process.env.HOST ?? '127.0.0.1';
  return serve({ fetch: createApp().fetch, port, hostname }, (info) => {
    console.log(`Agent Graphs server listening on http://${hostname}:${info.port}`);
  });
}
