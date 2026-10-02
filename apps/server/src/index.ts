import { serve } from '@hono/node-server';
import pino from 'pino';
import { createApp } from './app';
import { type Config, loadConfig } from './config';
import { createContext } from './context';
import { createDb } from './db/sqlite';
import { startJobs } from './jobs';

export { createApp, VERSION } from './app';
export { loadConfig } from './config';
export { createDb, openDatabase } from './db/sqlite';
export { sweepOnce } from './jobs';

export type StartServerOptions = Partial<Config>;

/** Starts the HTTP server and background jobs. Used by `pnpm dev` and `agraph serve`. */
export function startServer(options: StartServerOptions = {}) {
  const config = loadConfig(process.env, options);
  const log = pino({ level: config.logLevel });
  const ctx = createContext(createDb(config.databasePath), config, log);
  const app = createApp({ context: ctx });
  const stopJobs = startJobs(ctx);
  const server = serve({ fetch: app.fetch, port: config.port, hostname: config.host }, (info) => {
    log.info(
      `Agent Graphs server listening on http://${config.host}:${info.port} (auth: ${config.authMode}, db: ${config.databasePath})`,
    );
  });
  server.on('close', () => {
    stopJobs();
    ctx.db.$client.close();
  });
  return server;
}
