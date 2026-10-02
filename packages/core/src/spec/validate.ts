/**
 * Spec validation: structure (zod), normalization, then every semantic rule in
 * docs/spec-format.md §8. Errors block creation; warnings don't.
 */
import { parse as parseYaml } from 'yaml';
import type { z } from 'zod';
import {
  buildAdjacency,
  didYouMean,
  findCycle,
  laminarViolations,
  loopBody,
  reachable,
  singleExitViolations,
} from '../graph/algorithms';
import type { Issue } from '../schemas/common';
import {
  DERIVED_METRICS,
  EVENT_TYPES,
  EVOLUTION_PROTECTED,
  KNOWN_MODELS,
  MECHANISMS,
  PROVIDERS,
} from '../vocabulary';
import { type NormalizedAim, type NormalizedSpec, normalizeSpec } from './normalize';
import {
  AimObjectInput,
  DefaultsInput,
  EvolutionInput,
  ExecutorInput,
  GateInput,
  KNOWN_EVOLUTION_SCOPES,
  LoopInput,
  NodeInput,
  OrchestratorInput,
  PolicyInput,
  SpecInput,
} from './schema';

export type ValidationResult = {
  ok: boolean;
  normalized?: NormalizedSpec;
  errors: Issue[];
  warnings: Issue[];
  stats?: { nodes: number; edges: number; loops: number; orchestrators: number; aims: number };
};

/** Parse YAML or JSON text into a plain value. YAML is a superset of JSON, so it is the default. */
export function parseSpecText(text: string): { value?: unknown; errors: Issue[] } {
  try {
    return { value: parseYaml(text, { prettyErrors: true }), errors: [] };
  } catch (error) {
    return {
      errors: [
        {
          path: '',
          code: 'parse_error',
          message: `Could not parse spec: ${(error as Error).message}`,
          hint: 'Check indentation and quoting. Strings containing ": " or starting with a quote must be quoted.',
        },
      ],
    };
  }
}

export function formatPath(path: ReadonlyArray<PropertyKey>): string {
  let out = '';
  for (const part of path) {
    if (typeof part === 'number') out += `[${part}]`;
    else out += out ? `.${String(part)}` : String(part);
  }
  return out;
}

const SHAPES: Array<[RegExp, string[]]> = [
  [/^$/, Object.keys(SpecInput.shape)],
  [/^nodes\[\d+\]$/, Object.keys(NodeInput.shape)],
  [/(aims)\[\d+\]$/, Object.keys(AimObjectInput.shape)],
  [/^loops\[\d+\]$/, Object.keys(LoopInput.shape)],
  [/^orchestrators\[\d+\]$/, Object.keys(OrchestratorInput.shape)],
  [/^policy$/, Object.keys(PolicyInput.shape)],
  [/^defaults$/, Object.keys(DefaultsInput.shape)],
  [/^evolution$/, Object.keys(EvolutionInput.shape)],
  [/executor$/, Object.keys(ExecutorInput.shape)],
  [/gate$/, Object.keys(GateInput.shape)],
  [/(needs|informedBy)\[\d+\]$/, ['key', 'label', 'relation', 'condition', 'guidance', 'pitfalls']],
];

function allowedKeysFor(path: string): string[] {
  for (const [re, keys] of SHAPES) if (re.test(path)) return keys;
  return [];
}

type ZodIssueLike = z.core.$ZodIssue;

function zodIssuesToIssues(issues: ZodIssueLike[], input: unknown): Issue[] {
  const out: Issue[] = [];
  for (const issue of issues) {
    const path = formatPath(issue.path);
    if (issue.code === 'unrecognized_keys') {
      const allowed = allowedKeysFor(path);
      for (const key of issue.keys) {
        const suggestion = didYouMean(key, allowed);
        out.push({
          path: path ? `${path}.${key}` : key,
          code: 'unknown_field',
          message: `Unknown field '${key}'.`,
          hint: suggestion
            ? `Did you mean '${suggestion}'?`
            : `Allowed fields: ${allowed.join(', ')}.`,
        });
      }
      continue;
    }
    if (issue.code === 'invalid_union') {
      // Pick the branch that got furthest (not a plain type mismatch at the union's own path).
      const branches = issue.errors.filter(
        (branch) =>
          !branch.every(
            (b) => b.code === 'invalid_type' && formatPath(b.path) === '' && b.path.length === 0,
          ),
      );
      const chosen = branches[0];
      if (chosen && chosen.length > 0) {
        out.push(
          ...zodIssuesToIssues(
            chosen.map((b) => ({ ...b, path: [...issue.path, ...b.path] })) as ZodIssueLike[],
            input,
          ),
        );
        continue;
      }
    }
    out.push({
      path,
      code: issue.code === 'invalid_type' && issue.input === undefined ? 'required' : issue.code,
      message:
        issue.code === 'invalid_type' && issue.input === undefined
          ? `Missing required field '${path}'.`
          : `${path || 'spec'}: ${issue.message}`,
    });
  }
  return out;
}

const FLOAT_UNITS = new Set(['ratio', '%', 'percent', 'ms', 's', 'usd', 'seconds']);

/** Validate a spec value (already parsed from YAML/JSON). */
export function validateSpec(value: unknown): ValidationResult {
  const parsed = SpecInput.safeParse(value);
  if (!parsed.success) {
    return { ok: false, errors: zodIssuesToIssues(parsed.error.issues, value), warnings: [] };
  }
  const errors: Issue[] = [];
  const warnings: Issue[] = [];
  const spec = normalizeSpec(parsed.data, errors);

  const nodeIndex = new Map<string, number>();
  spec.nodes.forEach((n, i) => {
    if (nodeIndex.has(n.key)) {
      errors.push({
        path: `nodes[${i}].key`,
        code: 'duplicate_key',
        message: `Duplicate node key '${n.key}'.`,
      });
    } else nodeIndex.set(n.key, i);
  });
  const nodeKeys = [...nodeIndex.keys()];
  const orchByKey = new Map(spec.orchestrators.map((o) => [o.key, o]));

  const dup = (keys: string[], path: (i: number) => string, what: string) => {
    const seen = new Set<string>();
    keys.forEach((k, i) => {
      if (seen.has(k))
        errors.push({ path: path(i), code: 'duplicate_key', message: `Duplicate ${what} '${k}'.` });
      seen.add(k);
    });
  };
  dup(
    spec.loops.map((l) => l.key),
    (i) => `loops[${i}].key`,
    'loop key',
  );
  dup(
    spec.orchestrators.map((o) => o.key),
    (i) => `orchestrators[${i}].key`,
    'orchestrator key',
  );
  dup(
    spec.aims.map((a) => a.key),
    (i) => `aims[${i}].key`,
    'graph aim key',
  );

  // --- edges -------------------------------------------------------------------------------
  const requiresEdges: Array<{ from: string; to: string }> = [];
  const informsEdges: Array<{ from: string; to: string }> = [];
  const linked = new Set<string>();
  spec.nodes.forEach((n, i) => {
    for (const [field, list, sink] of [
      ['needs', n.needs, requiresEdges],
      ['informedBy', n.informedBy, informsEdges],
    ] as const) {
      const seen = new Set<string>();
      list.forEach((ref, j) => {
        const path = `nodes[${i}].${field}[${j}]`;
        if (!nodeIndex.has(ref.key)) {
          const s = didYouMean(ref.key, nodeKeys);
          errors.push({
            path,
            code: 'unknown_reference',
            message: `Node '${n.key}' references unknown node '${ref.key}'.`,
            ...(s ? { hint: `Did you mean '${s}'?` } : {}),
          });
          return;
        }
        if (ref.key === n.key) {
          errors.push({
            path,
            code: 'self_dependency',
            message: `Node '${n.key}' cannot depend on itself.`,
          });
          return;
        }
        if (seen.has(ref.key)) {
          errors.push({
            path,
            code: 'duplicate_edge',
            message: `Node '${n.key}' lists '${ref.key}' twice in ${field}.`,
          });
          return;
        }
        seen.add(ref.key);
        sink.push({ from: ref.key, to: n.key });
        linked.add(ref.key);
        linked.add(n.key);
      });
    }
  });

  const adj = buildAdjacency(nodeKeys, requiresEdges);
  const cycle = findCycle(adj);
  if (cycle) {
    errors.push({
      path: 'nodes',
      code: 'cycle',
      message: `Dependency cycle: ${cycle.join(' → ')}.`,
      hint: 'requires-edges (needs) must form a DAG. Use a loop for bounded failure-cycles.',
    });
  }
  for (const e of informsEdges) {
    if (!cycle && reachable(e.to, adj.succ).has(e.from)) {
      warnings.push({
        path: 'nodes',
        code: 'informs_cycle',
        message: `informs-edge ${e.from} → ${e.to} closes a cycle with requires-edges.`,
      });
    }
  }

  // --- nodes ---------------------------------------------------------------------------------
  const derived = new Set<string>(DERIVED_METRICS);
  const checkAim = (aim: NormalizedAim, path: string, owner: 'graph' | 'node' | 'orchestrator') => {
    if (aim.kind === 'quantitative') {
      if (aim.metric === undefined)
        errors.push({
          path,
          code: 'required',
          message: `Quantitative aim '${aim.key}' needs a metric.`,
          hint: 'Add `metric:` or use the shorthand `check: "metric >= 1"`.',
        });
      if (aim.comparator === undefined)
        errors.push({
          path: `${path}.comparator`,
          code: 'required',
          message: `Quantitative aim '${aim.key}' needs a comparator.`,
        });
      if (aim.target === undefined)
        errors.push({
          path: `${path}.target`,
          code: 'required',
          message: `Quantitative aim '${aim.key}' needs a numeric target.`,
          hint: 'Add `target: 1`, or use the shorthand `check: "test_pass_rate >= 1"`.',
        });
      if (aim.comparator === 'between') {
        if (aim.targetMax === undefined)
          errors.push({
            path: `${path}.targetMax`,
            code: 'required',
            message: `Aim '${aim.key}' uses 'between' and needs targetMax.`,
          });
        else if (aim.target !== undefined && aim.targetMax < aim.target)
          errors.push({
            path: `${path}.targetMax`,
            code: 'invalid_range',
            message: `Aim '${aim.key}': targetMax < target.`,
          });
      }
      if (aim.source === 'derived' && aim.metric && !derived.has(aim.metric))
        errors.push({
          path: `${path}.metric`,
          code: 'unknown_derived_metric',
          message: `Unknown derived metric '${aim.metric}'.`,
          hint: `Derived metrics: ${DERIVED_METRICS.join(', ')}.`,
        });
      if (
        (aim.comparator === 'eq' || aim.comparator === 'neq') &&
        ((aim.unit && FLOAT_UNITS.has(aim.unit)) ||
          (aim.target !== undefined && !Number.isInteger(aim.target)))
      )
        warnings.push({
          path,
          code: 'float_equality',
          message: `Aim '${aim.key}' compares a likely-float metric with ${aim.comparator}.`,
          hint: 'Prefer gte/lte for ratios and timings.',
        });
    } else if (owner === 'graph' && (aim.evaluator === 'self' || aim.evaluator === 'agent')) {
      errors.push({
        path: `${path}.evaluator`,
        code: 'invalid_graph_evaluator',
        message: `Graph aim '${aim.key}' cannot be judged by '${aim.evaluator}'.`,
        hint: 'Graph aims are judged by an orchestrator or a human.',
      });
    }
    if (aim.kind === 'qualitative' && aim.evaluator === 'orchestrator') {
      if (aim.evaluatorKey) {
        const o = orchByKey.get(aim.evaluatorKey);
        if (!o)
          errors.push({
            path: `${path}.evaluatorKey`,
            code: 'unknown_reference',
            message: `Unknown orchestrator '${aim.evaluatorKey}'.`,
          });
        else if (!o.capabilities.includes('evaluate'))
          errors.push({
            path: `${path}.evaluatorKey`,
            code: 'missing_capability',
            message: `Orchestrator '${o.key}' lacks the 'evaluate' capability.`,
          });
      } else if (!spec.orchestrators.some((o) => o.capabilities.includes('evaluate'))) {
        errors.push({
          path: `${path}.evaluator`,
          code: 'no_evaluator',
          message: `Aim '${aim.key}' is judged by an orchestrator, but none has 'evaluate'.`,
        });
      }
    }
  };
  spec.aims.forEach((a, i) => {
    checkAim(a, `aims[${i}]`, 'graph');
  });
  if (!parsed.data.aims || parsed.data.aims.length === 0)
    warnings.push({
      path: 'aims',
      code: 'default_graph_aim',
      message: 'No graph aims; the default aim nodes_done_ratio ≥ 1 was added.',
    });

  const knownModels = new Set<string>(KNOWN_MODELS);
  const knownProviders = new Set<string>(PROVIDERS);
  const knownMechanisms = new Set<string>(MECHANISMS);

  spec.nodes.forEach((n, i) => {
    const path = `nodes[${i}]`;
    dup(
      n.aims.map((a) => a.key),
      (j) => `${path}.aims[${j}].key`,
      `aim key in '${n.key}'`,
    );
    n.aims.forEach((a, j) => {
      checkAim(a, `${path}.aims[${j}]`, 'node');
    });
    if (n.kind === 'task') {
      if (!n.aim)
        errors.push({
          path: `${path}.aim`,
          code: 'required',
          message: `Task '${n.key}' needs an aim (one-sentence outcome).`,
        });
      if (!n.prompt)
        errors.push({
          path: `${path}.prompt`,
          code: 'required',
          message: `Task '${n.key}' needs a prompt.`,
        });
      if (!n.aims.some((a) => a.terminating))
        errors.push({
          path: `${path}.aims`,
          code: 'no_terminating_aim',
          message: `Task '${n.key}' needs at least one terminating aim.`,
          hint: 'Add a qualitative aim (a sentence) or a quantitative one (`check: "metric >= 1"`).',
        });
    }
    if (n.kind === 'gate') {
      if (!n.aim)
        errors.push({
          path: `${path}.aim`,
          code: 'required',
          message: `Gate '${n.key}' needs an aim.`,
        });
      if (!n.gate)
        errors.push({
          path: `${path}.gate`,
          code: 'required',
          message: `Gate '${n.key}' needs gate.approver.`,
        });
      else {
        if (!n.gate.instructions)
          warnings.push({
            path: `${path}.gate.instructions`,
            code: 'missing_instructions',
            message: `Gate '${n.key}' has no instructions for its approver.`,
          });
        if (n.gate.approver === 'orchestrator') {
          if (n.gate.approverKey) {
            const o = orchByKey.get(n.gate.approverKey);
            if (!o)
              errors.push({
                path: `${path}.gate.approverKey`,
                code: 'unknown_reference',
                message: `Unknown orchestrator '${n.gate.approverKey}'.`,
              });
            else if (!o.capabilities.includes('approve'))
              errors.push({
                path: `${path}.gate.approverKey`,
                code: 'missing_capability',
                message: `Orchestrator '${o.key}' lacks the 'approve' capability.`,
              });
          } else if (!spec.orchestrators.some((o) => o.capabilities.includes('approve'))) {
            errors.push({
              path: `${path}.gate.approver`,
              code: 'no_approver',
              message: `Gate '${n.key}' is approved by an orchestrator, but none has 'approve'.`,
            });
          }
        }
      }
    } else if (n.gate) {
      errors.push({
        path: `${path}.gate`,
        code: 'gate_on_non_gate',
        message: `Node '${n.key}' has a gate block but kind '${n.kind}'.`,
      });
    }
    if ((n.kind === 'task' || n.kind === 'gate') && !n.purpose)
      warnings.push({
        path: `${path}.purpose`,
        code: 'missing_purpose',
        message: `Node '${n.key}' has no purpose.`,
      });
    if (n.maxAttempts < 1 || n.maxAttempts > 20)
      errors.push({
        path: `${path}.maxAttempts`,
        code: 'out_of_range',
        message: `maxAttempts must be 1–20 (got ${n.maxAttempts}).`,
      });
    if (n.prompt && n.prompt.length > 20_000)
      warnings.push({
        path: `${path}.prompt`,
        code: 'long_prompt',
        message: `Prompt of '${n.key}' is over 20k characters.`,
      });
    if (n.parent !== undefined) {
      const parent = nodeIndex.get(n.parent);
      if (parent === undefined || spec.nodes[parent]?.kind !== 'group')
        errors.push({
          path: `${path}.parent`,
          code: 'invalid_parent',
          message: `Parent '${n.parent}' of '${n.key}' must be a group node.`,
        });
    }
    if (n.executor.model && !knownModels.has(n.executor.model))
      warnings.push({
        path: `${path}.executor.model`,
        code: 'unknown_model',
        message: `Model '${n.executor.model}' is not in the vocabulary (accepted).`,
      });
    if (n.executor.provider && !knownProviders.has(n.executor.provider))
      warnings.push({
        path: `${path}.executor.provider`,
        code: 'unknown_provider',
        message: `Provider '${n.executor.provider}' is not in the vocabulary (accepted).`,
      });
    if (n.executor.mechanism && !knownMechanisms.has(n.executor.mechanism))
      warnings.push({
        path: `${path}.executor.mechanism`,
        code: 'unknown_mechanism',
        message: `Mechanism '${n.executor.mechanism}' is not in the vocabulary (accepted).`,
      });
    if (spec.nodes.length > 1 && !linked.has(n.key))
      warnings.push({
        path,
        code: 'isolated_node',
        message: `Node '${n.key}' has no edges.`,
      });
  });

  // --- loops ---------------------------------------------------------------------------------
  const bodies: Array<{ key: string; body: Set<string> }> = [];
  const triggers = new Map<string, string>();
  spec.loops.forEach((l, i) => {
    const path = `loops[${i}]`;
    let ok = true;
    for (const field of ['from', 'to'] as const) {
      if (!nodeIndex.has(l[field])) {
        ok = false;
        const s = didYouMean(l[field], nodeKeys);
        errors.push({
          path: `${path}.${field}`,
          code: 'unknown_reference',
          message: `Loop '${l.key}' references unknown node '${l[field]}'.`,
          ...(s ? { hint: `Did you mean '${s}'?` } : {}),
        });
      }
    }
    if (l.maxIterations < 1 || l.maxIterations > 50)
      errors.push({
        path: `${path}.maxIterations`,
        code: 'out_of_range',
        message: `maxIterations must be 1–50 (got ${l.maxIterations}).`,
      });
    if (l.onExhausted === 'skip')
      errors.push({
        path: `${path}.onExhausted`,
        code: 'invalid_loop_policy',
        message: `Loop '${l.key}': onExhausted 'skip' is not allowed for loops.`,
        hint: 'Use escalate, fail, or accept.',
      });
    if (!ok) return;
    if (l.from === l.to) {
      errors.push({
        path,
        code: 'self_loop',
        message: `Loop '${l.key}' has from == to.`,
        hint: 'Use the node’s maxAttempts for self-retry.',
      });
      return;
    }
    const other = triggers.get(l.from);
    if (other)
      errors.push({
        path: `${path}.from`,
        code: 'multiple_loops',
        message: `Node '${l.from}' already triggers loop '${other}'.`,
      });
    triggers.set(l.from, l.key);
    if (cycle) return;
    const body = loopBody(l.from, l.to, adj);
    if (!body) {
      errors.push({
        path,
        code: 'unreachable_trigger',
        message: `Loop '${l.key}': '${l.from}' is not reachable from '${l.to}' through requires-edges.`,
      });
      return;
    }
    bodies.push({ key: l.key, body });
    for (const [a, b] of singleExitViolations(body, l.from, adj))
      errors.push({
        path,
        code: 'single_exit',
        message: `Loop '${l.key}': edge ${a} → ${b} leaves the body from a node other than the trigger '${l.from}'.`,
        hint: `Make '${b}' depend on '${l.from}' instead.`,
      });
    for (const e of informsEdges)
      if (body.has(e.from) && !body.has(e.to))
        warnings.push({
          path,
          code: 'informs_leaves_loop',
          message: `Loop '${l.key}': informs-edge ${e.from} → ${e.to} leaves the body.`,
        });
  });
  for (const [a, b] of laminarViolations(bodies))
    errors.push({
      path: 'loops',
      code: 'overlapping_loops',
      message: `Loops '${a}' and '${b}' partially overlap.`,
      hint: 'Loop bodies must be disjoint or nested.',
    });

  // --- orchestrators -------------------------------------------------------------------------
  const events = new Set<string>(EVENT_TYPES);
  spec.orchestrators.forEach((o, i) => {
    const path = `orchestrators[${i}]`;
    o.aims.forEach((a, j) => {
      checkAim(a, `${path}.aims[${j}]`, 'orchestrator');
    });
    if (o.scope !== 'all') {
      if ('nodes' in o.scope) {
        o.scope.nodes.forEach((k, j) => {
          if (!nodeIndex.has(k))
            errors.push({
              path: `${path}.scope.nodes[${j}]`,
              code: 'unknown_reference',
              message: `Orchestrator '${o.key}' scope references unknown node '${k}'.`,
            });
        });
      } else {
        const tags = new Set(o.scope.tags);
        if (!spec.nodes.some((n) => n.tags.some((t) => tags.has(t))))
          warnings.push({
            path: `${path}.scope`,
            code: 'empty_scope',
            message: `Orchestrator '${o.key}' scope matches no nodes.`,
          });
      }
    }
    o.triggers.forEach((t, j) => {
      if (!events.has(t)) {
        const s = didYouMean(t, events);
        warnings.push({
          path: `${path}.triggers[${j}]`,
          code: 'unknown_event_type',
          message: `Trigger '${t}' is not an event type.`,
          ...(s ? { hint: `Did you mean '${s}'?` } : {}),
        });
      }
    });
  });

  // --- evolution -----------------------------------------------------------------------------
  const ev = spec.evolution;
  const protectedSet = new Set<string>(EVOLUTION_PROTECTED);
  ev.scope.forEach((s, i) => {
    if (protectedSet.has(s) || ['aim', 'guard', 'policies'].includes(s))
      errors.push({
        path: `evolution.scope[${i}]`,
        code: 'protected_scope',
        message: `'${s}' is protected and can never be in evolution.scope.`,
      });
    else if (!KNOWN_EVOLUTION_SCOPES.has(s))
      errors.push({
        path: `evolution.scope[${i}]`,
        code: 'unknown_scope',
        message: `Unknown evolution scope '${s}'.`,
        hint: `Allowed: ${[...KNOWN_EVOLUTION_SCOPES].join(', ')}.`,
      });
  });
  if (ev.mode === 'auto' && !ev.validation.suite)
    errors.push({
      path: 'evolution.validation.suite',
      code: 'required',
      message: "evolution.mode 'auto' requires validation.suite.",
    });
  if (
    (ev.validation.ladder.includes('replay') || ev.validation.ladder.includes('ab')) &&
    !ev.validation.suite
  )
    errors.push({
      path: 'evolution.validation.ladder',
      code: 'required',
      message: 'Ladder stages replay/ab require validation.suite.',
    });
  if (
    ev.mode !== 'off' &&
    ev.approval === 'orchestrator' &&
    !spec.orchestrators.some((o) => o.capabilities.includes('resolve'))
  )
    errors.push({
      path: 'evolution.approval',
      code: 'no_approver',
      message: "evolution.approval 'orchestrator' needs an orchestrator with 'resolve'.",
    });

  const ok = errors.length === 0;
  return {
    ok,
    ...(ok ? { normalized: spec } : {}),
    errors,
    warnings,
    stats: {
      nodes: spec.nodes.length,
      edges: requiresEdges.length + informsEdges.length,
      loops: spec.loops.length,
      orchestrators: spec.orchestrators.length,
      aims: spec.aims.length + spec.nodes.reduce((s, n) => s + n.aims.length, 0),
    },
  };
}

/** Convenience: parse text and validate. */
export function validateSpecText(text: string): ValidationResult {
  const { value, errors } = parseSpecText(text);
  if (errors.length > 0) return { ok: false, errors, warnings: [] };
  return validateSpec(value);
}
