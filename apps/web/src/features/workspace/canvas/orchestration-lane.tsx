/**
 * Orchestration lane (docs/ui.md §5.1): a band above the DAG with one card per orchestrator
 * (role icon, name, status, bound model badge, duty-queue size). Hovering highlights the nodes
 * in its scope; clicking opens the orchestrator inspector.
 */
import type { NodeSummary, Orchestrator } from '@agent-graphs/sdk';
import { useQuery } from '@tanstack/react-query';
import { Bot, Crown, Eye, GitMerge, ListChecks, Orbit, Sparkles } from 'lucide-react';
import { ExecBadge } from '../../../components/exec-badge';
import { useClient } from '../../../lib/api';
import { qk } from '../../../lib/queries';
import { cn } from '../../../lib/utils';

export const ROLE_ICON: Record<string, typeof Crown> = {
  lead: Crown,
  reviewer: ListChecks,
  integrator: GitMerge,
  monitor: Eye,
  evolver: Sparkles,
  custom: Bot,
};

export function scopeKeys(o: Pick<Orchestrator, 'scope'>, nodes: NodeSummary[]): Set<string> {
  const scope = o.scope as 'all' | { nodes?: string[]; tags?: string[] };
  if (scope === 'all' || !scope) return new Set(nodes.map((n) => n.key));
  if ('nodes' in scope && scope.nodes) return new Set(scope.nodes);
  if ('tags' in scope && scope.tags) {
    const tags = new Set(scope.tags);
    return new Set(nodes.filter((n) => n.tags.some((t) => tags.has(t))).map((n) => n.key));
  }
  return new Set();
}

function OrchCard({
  o,
  graph,
  selected,
  onHover,
  onSelect,
  readOnly,
}: {
  o: Orchestrator;
  graph: string;
  selected: boolean;
  onHover: (key: string | null) => void;
  onSelect: (key: string) => void;
  readOnly?: boolean;
}) {
  const client = useClient();
  const { data: queue } = useQuery({
    queryKey: qk.queue(graph, o.key),
    queryFn: () => client.queue(graph, o.key).then((r) => r.items),
    enabled: !readOnly,
    staleTime: 10_000,
  });
  const Icon = ROLE_ICON[o.role] ?? Bot;
  const idle = o.status !== 'active';
  return (
    <button
      type="button"
      className={cn('orch', idle && 'idle', selected && 'hl')}
      onMouseEnter={() => onHover(o.key)}
      onMouseLeave={() => onHover(null)}
      onFocus={() => onHover(o.key)}
      onBlur={() => onHover(null)}
      onClick={() => !readOnly && onSelect(o.key)}
      aria-label={`Orchestrator ${o.name}, ${o.role}, ${o.status}`}
      data-testid={`orch-${o.key}`}
    >
      <span className="o-ava">
        <Icon />
        <span className={cn('live-dot', idle && 'idle')} aria-hidden="true" />
      </span>
      <div className="o-main" style={{ textAlign: 'left' }}>
        <div className="o-top">
          <span className="o-name">{o.name}</span>
          <span className="o-stat2" title={o.aim}>
            {queue && queue.length > 0 ? (
              <>
                <b>{queue.length}</b> in duty queue
              </>
            ) : o.aim ? (
              `aim: ${o.aim}`
            ) : (
              o.capabilities.join(' · ')
            )}
          </span>
        </div>
        <div className="o-sub">
          <span className="o-role">{o.role}</span>
          <ExecBadge x={{ kind: 'agent', ...o.executor }} />
          {idle && <span className="muted">{o.status}</span>}
        </div>
      </div>
    </button>
  );
}

export function OrchestrationLane({
  orchestrators,
  graph,
  selected,
  onHover,
  onSelect,
  readOnly,
}: {
  orchestrators: Orchestrator[];
  graph: string;
  selected?: string;
  onHover: (key: string | null) => void;
  onSelect: (key: string) => void;
  readOnly?: boolean;
}) {
  return (
    <section className="orch-lane" aria-label="Orchestration lane">
      <div
        className="lane-label"
        title="Orchestrators supervise the whole graph, outside the task DAG"
      >
        <span className="t">
          <Orbit />
          Orchestration
        </span>
        <span className="s">outside the DAG</span>
      </div>
      {orchestrators.length === 0 && (
        <span className="muted" style={{ fontSize: 12 }}>
          No orchestrators in this graph.
        </span>
      )}
      {orchestrators.map((o) => (
        <OrchCard
          key={o.id}
          o={o}
          graph={graph}
          selected={selected === o.key}
          onHover={onHover}
          onSelect={onSelect}
          {...(readOnly ? { readOnly } : {})}
        />
      ))}
    </section>
  );
}
