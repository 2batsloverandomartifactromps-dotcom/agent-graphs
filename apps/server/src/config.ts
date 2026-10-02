import { resolve } from 'node:path';
import { durationToSeconds } from '@agent-graphs/core';

export type Config = {
  port: number;
  host: string;
  dataDir: string;
  databasePath: string;
  authMode: 'local' | 'token';
  publicUrl: string;
  logLevel: string;
  corsOrigins: string[];
  leaseSweepIntervalMs: number;
};

const LOOPBACK = new Set(['127.0.0.1', 'localhost', '::1']);

/** Environment configuration (docs/architecture.md §3.5). */
export function loadConfig(
  env: NodeJS.ProcessEnv = process.env,
  overrides: Partial<Config> = {},
): Config {
  const port = overrides.port ?? Number(env.PORT ?? 4747);
  const host = overrides.host ?? env.HOST ?? '127.0.0.1';
  const dataDir = overrides.dataDir ?? resolve(env.DATA_DIR ?? './data');
  const authMode =
    overrides.authMode ?? (env.AUTH_MODE as Config['authMode'] | undefined) ?? 'local';
  if (authMode !== 'local' && authMode !== 'token')
    throw new Error(`AUTH_MODE must be local or token, got ${authMode}`);
  if (!LOOPBACK.has(host) && authMode !== 'token') {
    throw new Error(
      `HOST=${host} is not a loopback address: set AUTH_MODE=token (docs/architecture.md §6).`,
    );
  }
  return {
    port,
    host,
    dataDir,
    databasePath:
      overrides.databasePath ?? env.DATABASE_PATH ?? resolve(dataDir, 'agent-graphs.sqlite'),
    authMode,
    publicUrl: overrides.publicUrl ?? env.PUBLIC_URL ?? `http://${host}:${port}`,
    logLevel: overrides.logLevel ?? env.LOG_LEVEL ?? 'info',
    corsOrigins:
      overrides.corsOrigins ??
      (env.CORS_ORIGINS ? env.CORS_ORIGINS.split(',').map((s) => s.trim()) : []),
    leaseSweepIntervalMs:
      overrides.leaseSweepIntervalMs ??
      durationToSeconds((env.LEASE_SWEEP_INTERVAL ?? '30s') as `${number}s`) * 1000,
  };
}
