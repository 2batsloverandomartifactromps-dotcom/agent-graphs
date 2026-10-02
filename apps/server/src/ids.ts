import { monotonicFactory } from 'ulid';

const ulid = monotonicFactory();

/** Prefixed, time-sortable ids (docs/data-model.md § Conventions). */
export function newId(prefix: string, now?: number): string {
  return `${prefix}_${ulid(now)}`;
}
