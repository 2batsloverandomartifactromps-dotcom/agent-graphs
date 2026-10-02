/** Lessons (docs/self-evolution.md §7): shape, retrieval ranking, retirement flags. */
import type { ExecutionAnnotation } from '../schemas/common';
import type { LessonKind, NodeKind } from '../vocabulary';

export type LessonScope =
  | 'global'
  | {
      graph?: string;
      template?: string;
      nodeKey?: string;
      edge?: [string, string];
      tags?: string[];
      kind?: NodeKind;
    };

export type Lesson = {
  id: string;
  scope: LessonScope;
  kind: LessonKind;
  condition?: string;
  content: string;
  evidence: { failedAttempts: string[]; passedAttempts: string[]; notes?: string[] };
  source: 'worker' | 'evolver' | 'human' | 'import';
  counters: { applied: number; helpful: number; harmful: number };
  status: 'active' | 'retired';
  version: number;
  supersedes?: string;
  author: ExecutionAnnotation;
  createdAt: number;
  updatedAt: number;
};

/** Where a briefing is being rendered: the node, its graph/template, and its incoming edges. */
export type LessonContext = {
  graphId: string;
  templateId?: string;
  nodeKey: string;
  nodeKind: NodeKind;
  tags: string[];
  /** Incoming and outgoing edges as [from, to] keys. */
  edges: Array<[string, string]>;
};

/**
 * Scope match strength: edge (5) > node key (4) > template (3) > tags or kind (2) > global (1).
 * 0 means the lesson does not apply here.
 */
export function scopeMatch(lesson: Lesson, ctx: LessonContext): number {
  const s = lesson.scope;
  if (s === 'global') return 1;
  if (s.graph && s.graph !== ctx.graphId) return 0;
  if (s.template && s.template !== ctx.templateId && !s.graph) return 0;
  if (s.edge) {
    const [from, to] = s.edge;
    return ctx.edges.some(([a, b]) => a === from && b === to) ? 5 : 0;
  }
  if (s.nodeKey) return s.nodeKey === ctx.nodeKey ? 4 : 0;
  if (s.tags || s.kind) {
    const tagHit = s.tags ? s.tags.some((t) => ctx.tags.includes(t)) : true;
    const kindHit = s.kind ? s.kind === ctx.nodeKind : true;
    return tagHit && kindHit ? 2 : 0;
  }
  if (s.template) return 3;
  return s.graph ? 3 : 1;
}

/** Laplace-smoothed helpfulness: (helpful + 1) / (applied + 2). */
export function helpfulness(lesson: Lesson): number {
  return (lesson.counters.helpful + 1) / (lesson.counters.applied + 2);
}

/** Active lessons that apply here, best first: scope match, helpfulness, recency. */
export function rankLessons(lessons: Lesson[], ctx: LessonContext): Lesson[] {
  return lessons
    .filter((l) => l.status === 'active')
    .map((l) => ({ l, match: scopeMatch(l, ctx) }))
    .filter((x) => x.match > 0)
    .sort(
      (a, b) =>
        b.match - a.match ||
        helpfulness(b.l) - helpfulness(a.l) ||
        b.l.updatedAt - a.l.updatedAt ||
        a.l.id.localeCompare(b.l.id),
    )
    .map((x) => x.l);
}

/** Flag for retirement: more harmful than helpful after at least 5 applications. */
export function shouldRetire(lesson: Lesson): boolean {
  return lesson.counters.applied >= 5 && lesson.counters.harmful > lesson.counters.helpful;
}
