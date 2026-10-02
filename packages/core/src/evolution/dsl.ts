/**
 * The edit DSL (docs/self-evolution.md §8.3): typed operations on a spec, validated as one batch.
 * `applyOps` patches a spec and re-runs full validation; `classifyOps` maps each op to its
 * evolution scope and flags protected-field edits (§5).
 */
import { z } from 'zod';
import { Key } from '../schemas/common';
import { toSpecInput } from '../spec/export';
import type { NormalizedSpec } from '../spec/normalize';
import { ChecklistItemInput, LoopInput, NodeInput } from '../spec/schema';
import { type ValidationResult, validateSpec } from '../spec/validate';
import {
  EDGE_KINDS,
  EDGE_RELATIONS,
  type EvolutionScope,
  LOOP_EXHAUSTION_POLICIES,
  PRIORITIES,
} from '../vocabulary';

const EdgeId = z.strictObject({ from: Key, to: Key, kind: z.enum(EDGE_KINDS).default('requires') });
const EdgeAttributes = {
  label: z.string().max(200).optional(),
  condition: z.string().max(2000).optional(),
  guidance: z.string().max(4000).optional(),
  pitfalls: z.string().max(4000).optional(),
};

const TextDelta = z.union([
  z.strictObject({ append: z.string().min(1) }),
  z.strictObject({ replace: z.strictObject({ from: z.string().min(1), to: z.string() }) }),
  z.strictObject({ set: z.string() }),
]);

const ChecklistDelta = z.strictObject({
  add: z.array(ChecklistItemInput).optional(),
  retire: z.array(Key).optional(),
  reword: z.array(z.strictObject({ key: Key, title: z.string().min(1) })).optional(),
});

const LessonPayload = z.record(z.string(), z.unknown());

export const EditOp = z.union([
  z.strictObject({ op: z.literal('add_node'), node: NodeInput }),
  z.strictObject({ op: z.literal('delete_node'), key: Key }),
  z.strictObject({
    op: z.literal('add_edge'),
    ...EdgeId.shape,
    relation: z.enum(EDGE_RELATIONS).optional(),
    ...EdgeAttributes,
  }),
  z.strictObject({ op: z.literal('delete_edge'), ...EdgeId.shape }),
  z.strictObject({
    op: z.literal('set_edge_attributes'),
    ...EdgeId.shape,
    ...EdgeAttributes,
    mode: z.enum(['append', 'replace']).default('append'),
  }),
  z.strictObject({
    op: z.literal('set_node_field'),
    key: Key,
    field: z.literal(['prompt', 'purpose']),
    delta: TextDelta,
  }),
  z.strictObject({
    op: z.literal('set_node_field'),
    key: Key,
    field: z.literal('checklist'),
    delta: ChecklistDelta,
  }),
  z.strictObject({
    op: z.literal('set_node_field'),
    key: Key,
    field: z.literal('executor'),
    delta: z.record(z.string(), z.unknown()),
  }),
  z.strictObject({
    op: z.literal('set_node_field'),
    key: Key,
    field: z.literal('maxAttempts'),
    delta: z.strictObject({ set: z.number().int().min(1).max(50) }),
  }),
  z.strictObject({
    op: z.literal('set_node_field'),
    key: Key,
    field: z.literal('priority'),
    delta: z.strictObject({ set: z.enum(PRIORITIES) }),
  }),
  z.strictObject({ op: z.literal('add_loop'), loop: LoopInput }),
  z.strictObject({ op: z.literal('delete_loop'), key: Key }),
  z.strictObject({
    op: z.literal('set_loop'),
    key: Key,
    maxIterations: z.number().int().min(1).max(50).optional(),
    onExhausted: z.enum(LOOP_EXHAUSTION_POLICIES).optional(),
  }),
  z.strictObject({ op: z.literal('add_lesson'), lesson: LessonPayload }),
  z.strictObject({
    op: z.literal('merge_lessons'),
    ids: z.array(z.string()).min(2),
    into: LessonPayload,
  }),
  z.strictObject({ op: z.literal('retire_lesson'), id: z.string(), reason: z.string().optional() }),
]);
export type EditOp = z.infer<typeof EditOp>;
export const EditOps = z.array(EditOp).min(1);

export type OpClass = EvolutionScope;

export type Classification = {
  /** Scope class of each op, in order. */
  classes: OpClass[];
  /** Protected fields the batch touches (aims, policy, …); any entry requires a human. */
  protected: string[];
  riskClass: 'guidance' | 'structure' | 'protected';
};

const LOOSE_EXHAUSTION = new Set(['accept', 'skip']);

/** Map ops to scopes and detect protected-field edits. */
export function classifyOps(ops: EditOp[]): Classification {
  const classes: OpClass[] = [];
  const touched = new Set<string>();
  for (const op of ops) {
    switch (op.op) {
      case 'set_edge_attributes':
      case 'add_lesson':
      case 'merge_lessons':
      case 'retire_lesson':
        classes.push('guidance');
        break;
      case 'set_node_field':
        classes.push(
          op.field === 'checklist'
            ? 'checklists'
            : op.field === 'prompt' || op.field === 'purpose'
              ? 'prompts'
              : op.field === 'executor'
                ? 'executor'
                : 'topology',
        );
        break;
      case 'delete_node':
        // Deleting a node drops its acceptance criteria: an aims edit in disguise.
        touched.add('aims');
        classes.push('topology');
        break;
      case 'add_node':
        if (op.node.onExhausted && LOOSE_EXHAUSTION.has(op.node.onExhausted)) touched.add('policy');
        classes.push('topology');
        break;
      case 'set_loop':
        if (op.onExhausted === 'accept') touched.add('policy');
        classes.push('topology');
        break;
      case 'add_loop':
        if (op.loop.onExhausted === 'accept') touched.add('policy');
        classes.push('topology');
        break;
      default:
        classes.push('topology');
    }
  }
  const protectedFields = [...touched].sort();
  return {
    classes,
    protected: protectedFields,
    riskClass: protectedFields.length
      ? 'protected'
      : classes.every((c) => c === 'guidance')
        ? 'guidance'
        : 'structure',
  };
}

/** Specs are plain JSON, so a JSON round trip is a faithful deep copy. */
function cloneJson<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T;
}

export class EditError extends Error {
  constructor(
    readonly opIndex: number,
    message: string,
  ) {
    super(`ops[${opIndex}]: ${message}`);
  }
}

type SpecObj = Record<string, unknown> & {
  nodes: Array<Record<string, unknown> & { key: string }>;
  loops?: Array<Record<string, unknown> & { key: string }>;
};

function edgeList(node: Record<string, unknown>, kind: 'requires' | 'informs') {
  const field = kind === 'requires' ? 'needs' : 'informedBy';
  node[field] ??= [];
  return node[field] as Array<string | (Record<string, unknown> & { key: string })>;
}

function refKey(ref: string | { key: string }): string {
  return typeof ref === 'string' ? ref : ref.key;
}

function applyText(current: unknown, delta: z.infer<typeof TextDelta>, index: number): string {
  const text = typeof current === 'string' ? current : '';
  if ('append' in delta) return text ? `${text.trimEnd()}\n${delta.append}` : delta.append;
  if ('set' in delta) return delta.set;
  if (!text.includes(delta.replace.from)) {
    throw new EditError(
      index,
      `text to replace was not found: "${delta.replace.from.slice(0, 80)}"`,
    );
  }
  return text.replace(delta.replace.from, delta.replace.to);
}

function appendText(current: unknown, add: string | undefined, mode: 'append' | 'replace') {
  if (add === undefined) return current;
  if (mode === 'replace' || typeof current !== 'string' || !current) return add;
  return current.includes(add) ? current : `${current}; ${add}`;
}

/** Apply ops to a copy of the spec. Lesson ops do not change the spec. */
export function patchSpec(base: NormalizedSpec, ops: EditOp[]): Record<string, unknown> {
  const spec = cloneJson(toSpecInput(base)) as unknown as SpecObj;
  const node = (key: string, i: number) => {
    const found = spec.nodes.find((n) => n.key === key);
    if (!found) throw new EditError(i, `node '${key}' does not exist`);
    return found;
  };
  ops.forEach((op, i) => {
    switch (op.op) {
      case 'add_node':
        if (spec.nodes.some((n) => n.key === op.node.key))
          throw new EditError(i, `node '${op.node.key}' already exists`);
        spec.nodes.push(cloneJson(op.node) as SpecObj['nodes'][number]);
        break;
      case 'delete_node': {
        node(op.key, i);
        spec.nodes = spec.nodes.filter((n) => n.key !== op.key);
        for (const n of spec.nodes) {
          for (const kind of ['requires', 'informs'] as const) {
            const list = edgeList(n, kind);
            const kept = list.filter((r) => refKey(r) !== op.key);
            list.splice(0, list.length, ...kept);
          }
          if (n.parent === op.key) delete n.parent;
        }
        spec.loops = (spec.loops ?? []).filter((l) => l.from !== op.key && l.to !== op.key);
        break;
      }
      case 'add_edge': {
        node(op.from, i);
        const list = edgeList(node(op.to, i), op.kind);
        if (list.some((r) => refKey(r) === op.from)) throw new EditError(i, 'edge already exists');
        const { op: _op, from, to: _to, kind: _kind, ...attrs } = op;
        list.push(Object.keys(attrs).length ? { key: from, ...attrs } : from);
        break;
      }
      case 'delete_edge': {
        const list = edgeList(node(op.to, i), op.kind);
        const index = list.findIndex((r) => refKey(r) === op.from);
        if (index < 0)
          throw new EditError(i, `edge ${op.from} → ${op.to} (${op.kind}) does not exist`);
        list.splice(index, 1);
        break;
      }
      case 'set_edge_attributes': {
        const list = edgeList(node(op.to, i), op.kind);
        const index = list.findIndex((r) => refKey(r) === op.from);
        if (index < 0)
          throw new EditError(i, `edge ${op.from} → ${op.to} (${op.kind}) does not exist`);
        const current = list[index] as string | Record<string, unknown>;
        const ref: Record<string, unknown> =
          typeof current === 'string' ? { key: current } : { ...current };
        for (const attr of ['label', 'condition', 'guidance', 'pitfalls'] as const) {
          const next = appendText(ref[attr], op[attr], op.mode);
          if (next !== undefined) ref[attr] = next;
        }
        list[index] = ref as Record<string, unknown> & { key: string };
        break;
      }
      case 'set_node_field': {
        const n = node(op.key, i);
        if (op.field === 'prompt' || op.field === 'purpose')
          n[op.field] = applyText(n[op.field], op.delta, i);
        else if (op.field === 'checklist') {
          let items = ((n.checklist as Array<Record<string, unknown>>) ?? []).map((c) => ({
            ...c,
          }));
          if (op.delta.retire)
            items = items.filter((c) => !op.delta.retire?.includes(c.key as string));
          for (const r of op.delta.reword ?? []) {
            const item = items.find((c) => c.key === r.key);
            if (!item) throw new EditError(i, `checklist item '${r.key}' does not exist`);
            item.title = r.title;
          }
          for (const add of op.delta.add ?? [])
            items.push(typeof add === 'string' ? { title: add } : { ...add });
          n.checklist = items;
        } else if (op.field === 'executor') {
          n.executor = { ...(n.executor as Record<string, unknown>), ...op.delta };
        } else {
          n[op.field] = (op.delta as { set: unknown }).set;
        }
        break;
      }
      case 'add_loop':
        spec.loops ??= [];
        if (spec.loops.some((l) => l.key === op.loop.key))
          throw new EditError(i, `loop '${op.loop.key}' already exists`);
        spec.loops.push(cloneJson(op.loop) as SpecObj['nodes'][number]);
        break;
      case 'delete_loop':
        if (!(spec.loops ?? []).some((l) => l.key === op.key))
          throw new EditError(i, `loop '${op.key}' does not exist`);
        spec.loops = (spec.loops ?? []).filter((l) => l.key !== op.key);
        break;
      case 'set_loop': {
        const loop = (spec.loops ?? []).find((l) => l.key === op.key);
        if (!loop) throw new EditError(i, `loop '${op.key}' does not exist`);
        if (op.maxIterations !== undefined) loop.maxIterations = op.maxIterations;
        if (op.onExhausted !== undefined) loop.onExhausted = op.onExhausted;
        break;
      }
      default:
        break;
    }
  });
  if (spec.loops?.length === 0) delete spec.loops;
  return spec;
}

export type ApplyResult = {
  ok: boolean;
  spec?: Record<string, unknown>;
  validation?: ValidationResult;
  errors: Array<{ path: string; code: string; message: string; hint?: string }>;
};

/** Patch a spec with ops and re-run full validation (the structural stage). */
export function applyOps(base: NormalizedSpec, rawOps: unknown): ApplyResult {
  const parsed = EditOps.safeParse(rawOps);
  if (!parsed.success) {
    return {
      ok: false,
      errors: parsed.error.issues.map((issue) => ({
        path: `ops${issue.path.map((p) => (typeof p === 'number' ? `[${p}]` : `.${String(p)}`)).join('')}`,
        code: 'invalid_op',
        message: issue.message,
      })),
    };
  }
  let spec: Record<string, unknown>;
  try {
    spec = patchSpec(base, parsed.data);
  } catch (error) {
    if (error instanceof EditError) {
      return {
        ok: false,
        errors: [{ path: `ops[${error.opIndex}]`, code: 'edit_failed', message: error.message }],
      };
    }
    throw error;
  }
  const validation = validateSpec(spec);
  return { ok: validation.ok, spec, validation, errors: validation.errors };
}
