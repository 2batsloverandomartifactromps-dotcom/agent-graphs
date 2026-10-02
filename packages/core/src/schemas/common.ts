import { z } from 'zod';
import { ANNOTATION_KINDS, EVIDENCE_KINDS } from '../vocabulary';

/** Author-facing key: kebab-case, unique within its scope. */
export const KEY_PATTERN = /^[a-z0-9][a-z0-9-]{0,63}$/;
export const Key = z.string().regex(KEY_PATTERN, 'must be kebab-case: ^[a-z0-9][a-z0-9-]{0,63}$');

/** `90s`, `30m`, `2h`, `1d`, or integer seconds. */
export const DURATION_PATTERN = /^(\d+)(s|m|h|d)$/;
export const Duration = z.union([z.number().int().positive(), z.string().regex(DURATION_PATTERN)]);
export type Duration = z.infer<typeof Duration>;

const UNIT_SECONDS: Record<string, number> = { s: 1, m: 60, h: 3600, d: 86400 };

/** Convert a duration to seconds. Throws on malformed input (validate first). */
export function durationToSeconds(value: Duration): number {
  if (typeof value === 'number') return value;
  const match = DURATION_PATTERN.exec(value);
  if (!match) throw new Error(`Invalid duration: ${value}`);
  return Number(match[1]) * (UNIT_SECONDS[match[2] as string] as number);
}

export const ExecutionAnnotation = z.object({
  kind: z.enum(ANNOTATION_KINDS).default('agent'),
  agent: z.string().max(200).optional(),
  role: z.string().max(100).optional(),
  model: z.string().max(200).optional(),
  thinking: z.string().max(50).optional(),
  thinkingBudget: z.number().int().nonnegative().optional(),
  provider: z.string().max(100).optional(),
  mechanism: z.string().max(100).optional(),
  sessionId: z.string().max(100).optional(),
  clientSessionId: z.string().max(200).optional(),
  parentSessionId: z.string().max(100).optional(),
  version: z.string().max(100).optional(),
});
export type ExecutionAnnotation = z.infer<typeof ExecutionAnnotation>;

export const Usage = z.object({
  inputTokens: z.number().nonnegative().optional(),
  outputTokens: z.number().nonnegative().optional(),
  cacheReadTokens: z.number().nonnegative().optional(),
  cacheWriteTokens: z.number().nonnegative().optional(),
  costUsd: z.number().nonnegative().optional(),
  durationMs: z.number().nonnegative().optional(),
});
export type Usage = z.infer<typeof Usage>;

export const Evidence = z.object({
  kind: z.enum(EVIDENCE_KINDS),
  label: z.string().max(200).optional(),
  value: z.string().max(10_000),
  meta: z.record(z.string(), z.unknown()).optional(),
});
export type Evidence = z.infer<typeof Evidence>;

/** Shape of every validation issue (spec-format.md §8). */
export type Issue = {
  path: string;
  code: string;
  message: string;
  hint?: string;
};
