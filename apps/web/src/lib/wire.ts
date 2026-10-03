/**
 * SSE snapshots carry engine entities with epoch-ms `…At` fields, while REST responses use ISO
 * strings (docs/api.md §1). `toWire` converts a snapshot to the REST shape so it can patch the
 * Query cache directly.
 */
const TIME_KEY = /At$/;

export function toWire<T>(value: T): T {
  if (Array.isArray(value)) return value.map((v) => toWire(v)) as T;
  if (value && typeof value === 'object') {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
      out[k] = typeof v === 'number' && TIME_KEY.test(k) ? new Date(v).toISOString() : toWire(v);
    }
    return out as T;
  }
  return value;
}
