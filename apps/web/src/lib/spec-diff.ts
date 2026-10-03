/**
 * Spec tab "Edit as YAML" (docs/ui.md §4.3): diff the canonical exported spec against the
 * edited text and express the difference as one mutation batch for POST /graphs/{g}/mutations.
 */
import { deriveKey, type MutationBody } from '@agent-graphs/core';
import { parse } from 'yaml';

type Obj = Record<string, unknown>;
type Keyed = Obj & { key: string };

export type SpecDiff = {
  batch: MutationBody;
  /** Human-readable change lines for the diff preview (`+`, `~`, `-`). */
  changes: string[];
  /** Edits a mutation batch cannot express (for example deleting a graph field). */
  warnings: string[];
};

const LIST_KEYS = new Set(['schema', 'nodes', 'loops', 'orchestrators', 'aims']);
const EDGE_FIELDS = { needs: 'requires', informedBy: 'informs' } as const;

export function parseSpecObject(text: string): Obj {
  const value = parse(text);
  if (!value || typeof value !== 'object' || Array.isArray(value))
    throw new Error('The spec must be a YAML mapping.');
  return value as Obj;
}

export function canonical(value: unknown): string {
  return JSON.stringify(sortKeys(value));
}

function sortKeys(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sortKeys);
  if (value && typeof value === 'object') {
    return Object.fromEntries(
      Object.keys(value as Obj)
        .sort()
        .map((k) => [k, sortKeys((value as Obj)[k])]),
    );
  }
  return value;
}

const same = (a: unknown, b: unknown) => canonical(a) === canonical(b);

function keyedAims(list: unknown): Keyed[] {
  if (!Array.isArray(list)) return [];
  return list.map((a) =>
    typeof a === 'string'
      ? { key: deriveKey(a), title: a }
      : ({
          ...(a as Obj),
          key: ((a as Obj).key as string) ?? deriveKey(String((a as Obj).title ?? '')),
        } as Keyed),
  );
}

function keyed(list: unknown): Keyed[] {
  return Array.isArray(list) ? (list.filter((x) => x && typeof x === 'object') as Keyed[]) : [];
}

function refs(list: unknown): Keyed[] {
  if (!Array.isArray(list)) return [];
  return list.map((r) => (typeof r === 'string' ? { key: r } : (r as Keyed)));
}

function byKey<T extends Keyed>(list: T[]): Map<string, T> {
  return new Map(list.map((x) => [x.key, x]));
}

/** Field-level differences of two keyed objects (excluding `skip`). */
function changedFields(
  before: Obj,
  after: Obj,
  skip: string[] = [],
): { patch: Obj; removed: string[] } {
  const patch: Obj = {};
  const removed: string[] = [];
  for (const k of new Set([...Object.keys(before), ...Object.keys(after)])) {
    if (k === 'key' || skip.includes(k)) continue;
    if (!(k in after)) {
      if (before[k] !== undefined) removed.push(k);
      continue;
    }
    if (!same(before[k], after[k])) patch[k] = after[k];
  }
  return { patch, removed };
}

function diffKeyed(
  label: string,
  before: Keyed[],
  after: Keyed[],
  out: SpecDiff,
  add: (x: Keyed) => void,
  update: (x: Keyed) => void,
  remove: (key: string) => void,
  skip: string[] = [],
): Set<string> {
  const b = byKey(before);
  const a = byKey(after);
  const added = new Set<string>();
  for (const [key, item] of a) {
    const prev = b.get(key);
    if (!prev) {
      add(item);
      added.add(key);
      out.changes.push(`+ ${label} ${key}`);
      continue;
    }
    const { patch, removed } = changedFields(prev, item, skip);
    if (Object.keys(patch).length) {
      update({ key, ...patch });
      out.changes.push(`~ ${label} ${key}: ${Object.keys(patch).join(', ')}`);
    }
    for (const f of removed)
      out.warnings.push(`Removing ${label} ${key}.${f} is not supported; set a new value instead.`);
  }
  for (const key of b.keys()) {
    if (!a.has(key)) {
      remove(key);
      out.changes.push(`- ${label} ${key}`);
    }
  }
  return added;
}

export function diffSpecs(before: Obj, after: Obj): SpecDiff {
  const out: SpecDiff = { batch: {}, changes: [], warnings: [] };
  const batch = out.batch;
  const lists = batch as Record<string, unknown[] | undefined>;
  const push = (k: Exclude<keyof MutationBody, 'graph'>, v: unknown) => {
    lists[k] ??= [];
    lists[k]?.push(v);
  };

  // Graph-level fields.
  for (const k of new Set([...Object.keys(before), ...Object.keys(after)])) {
    if (LIST_KEYS.has(k)) continue;
    if (!(k in after)) {
      out.warnings.push(
        `Removing the graph field '${k}' is not supported; set a new value instead.`,
      );
      continue;
    }
    if (!same(before[k], after[k])) {
      batch.graph = { ...(batch.graph ?? {}), [k]: after[k] };
      out.changes.push(`~ graph ${k}`);
    }
  }

  // Graph aims.
  diffKeyed(
    'graph aim',
    keyedAims(before.aims),
    keyedAims(after.aims),
    out,
    (x) => push('addGraphAims', x),
    (x) => push('updateGraphAims', x),
    (k) => push('removeGraphAims', k),
  );

  // Nodes (edges are diffed separately from needs / informedBy).
  const nodesBefore = keyed(before.nodes);
  const nodesAfter = keyed(after.nodes);
  const removedNodes = new Set<string>();
  const addedNodes = diffKeyed(
    'node',
    nodesBefore,
    nodesAfter,
    out,
    (x) => push('addNodes', x),
    (x) => push('updateNodes', x),
    (k) => {
      removedNodes.add(k);
      push('removeNodes', k);
    },
    ['needs', 'informedBy'],
  );

  const afterByKey = byKey(nodesAfter);
  for (const prev of nodesBefore) {
    const next = afterByKey.get(prev.key);
    if (!next) continue;
    for (const [field, kind] of Object.entries(EDGE_FIELDS)) {
      const b = byKey(refs(prev[field]));
      const a = byKey(refs(next[field]));
      for (const [from, ref] of a) {
        const { key: _k, ...attrs } = ref;
        const old = b.get(from);
        if (!old) {
          push('addEdges', { from, to: prev.key, kind, ...attrs });
          out.changes.push(`+ edge ${from} → ${prev.key} (${kind})`);
        } else if (!same(old, ref)) {
          push('updateEdges', { from, to: prev.key, kind, ...attrs });
          out.changes.push(`~ edge ${from} → ${prev.key} (${kind})`);
        }
      }
      for (const from of b.keys()) {
        if (a.has(from) || removedNodes.has(from)) continue;
        push('removeEdges', { from, to: prev.key, kind });
        out.changes.push(`- edge ${from} → ${prev.key} (${kind})`);
      }
    }
  }
  void addedNodes;

  diffKeyed(
    'loop',
    keyed(before.loops),
    keyed(after.loops),
    out,
    (x) => push('addLoops', x),
    (x) => push('updateLoops', x),
    (k) => push('removeLoops', k),
  );
  diffKeyed(
    'orchestrator',
    keyed(before.orchestrators),
    keyed(after.orchestrators),
    out,
    (x) => push('addOrchestrators', x),
    (x) => push('updateOrchestrators', x),
    (k) => push('removeOrchestrators', k),
  );
  return out;
}

export function isEmptyBatch(batch: MutationBody): boolean {
  return Object.values(batch).every((v) => v === undefined || (Array.isArray(v) && v.length === 0));
}
