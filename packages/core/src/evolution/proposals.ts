/**
 * Proposal checks (docs/self-evolution.md §8.4, §9 structural stage): canonical hashing of edit
 * sets, scope and protected-field rules, rejection memory, and whether approval is required.
 */
import type { NormalizedSpec, ResolvedEvolution } from '../spec/normalize';
import { canonicalJson, sha256 } from '../util/hash';
import { applyOps, type Classification, classifyOps, type EditOp, EditOps } from './dsl';

type Change = { path: string; before?: unknown; after?: unknown };

function byKey<T extends { key: string }>(items: T[]): Map<string, T> {
  return new Map(items.map((i) => [i.key, i]));
}

function diffRecords(
  path: string,
  a: Record<string, unknown>,
  b: Record<string, unknown>,
  out: Change[],
) {
  for (const field of new Set([...Object.keys(a), ...Object.keys(b)])) {
    const before = canonicalJson(a[field]);
    const after = canonicalJson(b[field]);
    if (before !== after) out.push({ path: `${path}.${field}`, before: a[field], after: b[field] });
  }
}

/**
 * The structural difference between two normalized specs, as a sorted list of changes. Edit sets
 * with the same effect (a revision as delete + add, ops in a different order) yield equal diffs.
 */
export function specDiff(a: NormalizedSpec, b: NormalizedSpec): Change[] {
  const out: Change[] = [];
  const { nodes: na, loops: la, orchestrators: oa, ...ga } = a;
  const { nodes: nb, loops: lb, orchestrators: ob, ...gb } = b;
  diffRecords('graph', ga as Record<string, unknown>, gb as Record<string, unknown>, out);
  for (const [kind, xs, ys] of [
    ['nodes', na, nb],
    ['loops', la, lb],
    ['orchestrators', oa, ob],
  ] as const) {
    const ma = byKey(xs as Array<{ key: string }>);
    const mb = byKey(ys as Array<{ key: string }>);
    for (const [key, item] of ma) {
      const other = mb.get(key);
      if (!other) out.push({ path: `${kind}.${key}`, before: item });
      else
        diffRecords(
          `${kind}.${key}`,
          item as Record<string, unknown>,
          other as Record<string, unknown>,
          out,
        );
    }
    for (const [key, item] of mb)
      if (!ma.has(key)) out.push({ path: `${kind}.${key}`, after: item });
  }
  return out.sort((x, y) => (x.path < y.path ? -1 : x.path > y.path ? 1 : 0));
}

/** Lesson ops do not change the spec; they hash by content, independent of order. */
function lessonOps(ops: EditOp[]): string[] {
  return ops
    .filter((o) => o.op === 'add_lesson' || o.op === 'merge_lessons' || o.op === 'retire_lesson')
    .map((o) => canonicalJson(o))
    .sort();
}

export function canonicalHash(
  target: { type: 'graph' | 'template'; id: string },
  base: NormalizedSpec,
  candidate: NormalizedSpec,
  ops: EditOp[],
): string {
  return sha256(
    canonicalJson({ target, changes: specDiff(base, candidate), lessons: lessonOps(ops) }),
  );
}

export type ProposalCheck =
  | {
      status: 'invalid';
      errors: Array<{ path: string; code: string; message: string; hint?: string }>;
    }
  | {
      status: 'refused';
      canonicalHash: string;
      reason: string;
    }
  | {
      status: 'ok';
      canonicalHash: string;
      candidate: NormalizedSpec;
      classification: Classification;
      outOfScope: string[];
      requiresApproval: boolean;
      approvalReasons: string[];
      noop: boolean;
    };

/**
 * The checking step: parse ops, enforce limits, patch and validate, hash, consult the rejection
 * memory, and decide whether a human must approve (always for protected fields).
 */
export function checkProposal(input: {
  target: { type: 'graph' | 'template'; id: string };
  base: NormalizedSpec;
  ops: unknown;
  evolution: ResolvedEvolution;
  /** Canonical hashes of proposals previously rejected for this target. */
  rejectedHashes?: Iterable<string>;
}): ProposalCheck {
  const parsed = EditOps.safeParse(input.ops);
  if (!parsed.success) {
    return {
      status: 'invalid',
      errors: parsed.error.issues.map((i) => ({
        path: `ops.${i.path.join('.')}`,
        code: 'invalid_op',
        message: i.message,
      })),
    };
  }
  const ops = parsed.data;
  const max = input.evolution.validation.maxOpsPerProposal;
  if (ops.length > max) {
    return {
      status: 'invalid',
      errors: [
        {
          path: 'ops',
          code: 'too_many_ops',
          message: `A proposal may contain at most ${max} ops (got ${ops.length}).`,
          hint: 'Split it into smaller proposals; small edits validate faster and fail more clearly.',
        },
      ],
    };
  }
  const applied = applyOps(input.base, ops);
  if (!applied.ok || !applied.validation?.normalized)
    return { status: 'invalid', errors: applied.errors };
  const candidate = applied.validation.normalized;
  const hash = canonicalHash(input.target, input.base, candidate, ops);
  if (new Set(input.rejectedHashes ?? []).has(hash)) {
    return {
      status: 'refused',
      canonicalHash: hash,
      reason: 'An identical edit set was rejected for this target before (rejection memory).',
    };
  }
  const classification = classifyOps(ops);
  const allowed = new Set(input.evolution.scope);
  const outOfScope = [...new Set(classification.classes.filter((c) => !allowed.has(c)))];
  const approvalReasons: string[] = [];
  if (classification.protected.length)
    approvalReasons.push(`touches protected fields: ${classification.protected.join(', ')}`);
  if (outOfScope.length) approvalReasons.push(`outside evolution.scope: ${outOfScope.join(', ')}`);
  if (input.evolution.mode !== 'auto') approvalReasons.push(`mode is ${input.evolution.mode}`);
  else if (input.evolution.validation.ladder.includes('human'))
    approvalReasons.push('the validation ladder ends with human approval');
  const noop = specDiff(input.base, candidate).length === 0 && lessonOps(ops).length === 0;
  return {
    status: 'ok',
    canonicalHash: hash,
    candidate,
    classification,
    outOfScope,
    requiresApproval: approvalReasons.length > 0,
    approvalReasons,
    noop,
  };
}
