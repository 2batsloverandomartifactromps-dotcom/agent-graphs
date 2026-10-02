/** Token budgeting shared by briefings and sitreps (docs/agent-protocol.md §4). */

/** Approximate tokens: characters ÷ 4, rounded up. */
export function estimateTokens(text: string): number {
  return Math.ceil(text.length / 4);
}

/**
 * A rendered section with progressively smaller variants. `levels[0]` is the full rendering;
 * later levels are reductions; an empty string drops the section.
 */
export type Section = {
  id: string;
  title: string;
  /** Lower numbers are more important (1 = header). */
  priority: number;
  levels: string[];
  /** Sections that are never truncated (header, node, acceptance, directives). */
  fixed?: boolean;
};

export type FittedSection = {
  id: string;
  title: string;
  priority: number;
  text: string;
  level: number;
  truncated: boolean;
  tokens: number;
};

export type Fitted = { sections: FittedSection[]; tokens: number; overBudget: boolean };

/**
 * Reduce sections, least important first, until the total fits the budget. Each section is
 * reduced through all its levels before the next more important one is touched.
 */
export function fitSections(sections: Section[], budget: number): Fitted {
  const level = new Map(sections.map((s) => [s.id, 0]));
  const text = (s: Section) => s.levels[level.get(s.id) ?? 0] ?? '';
  const total = () =>
    sections.reduce((sum, s) => sum + (text(s) ? estimateTokens(text(s)) + 1 : 0), 0);
  const reducible = sections.filter((s) => !s.fixed).sort((a, b) => b.priority - a.priority);
  for (const s of reducible) {
    while (total() > budget && (level.get(s.id) ?? 0) < s.levels.length - 1) {
      level.set(s.id, (level.get(s.id) ?? 0) + 1);
    }
    if (total() <= budget) break;
  }
  const fitted = sections
    .map((s) => ({
      id: s.id,
      title: s.title,
      priority: s.priority,
      text: text(s),
      level: level.get(s.id) ?? 0,
      truncated: (level.get(s.id) ?? 0) > 0,
      tokens: estimateTokens(text(s)),
    }))
    .sort((a, b) => a.priority - b.priority);
  const tokens = total();
  return { sections: fitted, tokens, overBudget: tokens > budget };
}

/** Wrap content written by other agents so it is read as data, not instructions. */
export function agentContent(source: string, body: string): string {
  const safeSource = source.replace(/"/g, "'");
  const safeBody = body.replace(/<\/?agent-content[^>]*>/gi, '');
  return `<agent-content source="${safeSource}">\n${safeBody}\n</agent-content>`;
}

export function clip(text: string, max: number): string {
  const flat = text.trim();
  return flat.length <= max ? flat : `${flat.slice(0, Math.max(0, max - 1)).trimEnd()}…`;
}

export function firstLine(text: string, max = 160): string {
  return clip(text.split('\n').find((l) => l.trim()) ?? '', max);
}

export function indent(text: string, prefix = '  '): string {
  return text
    .trimEnd()
    .split('\n')
    .map((l) => (l ? prefix + l : l))
    .join('\n');
}

export function isoMinute(ms: number): string {
  return `${new Date(ms).toISOString().slice(11, 16)}Z`;
}
