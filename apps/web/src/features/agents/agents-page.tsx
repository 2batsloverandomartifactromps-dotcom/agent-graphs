/**
 * Agents (docs/ui.md §2): sessions (active and recent), what each is doing, and usage by
 * model, provider and mechanism.
 */
import type { GraphView, Session } from '@agent-graphs/sdk';
import { useQueryClient } from '@tanstack/react-query';
import { Link } from '@tanstack/react-router';
import { Bot } from 'lucide-react';
import { useState } from 'react';
import { Annot, MechanismIcon, MonoTile } from '../../components/exec-badge';
import { StatusPill } from '../../components/status';
import { Empty, Segmented, Skeleton } from '../../components/ui';
import { timeAgo } from '../../lib/format';
import { useSessions } from '../../lib/queries';
import { modelInfo } from '../../lib/vocab';

function group(
  sessions: Session[],
  key: 'model' | 'provider' | 'mechanism',
): Array<[string, number]> {
  const m = new Map<string, number>();
  for (const s of sessions) {
    const v = s[key] ?? 'unknown';
    m.set(v, (m.get(v) ?? 0) + 1);
  }
  return [...m.entries()].sort((a, b) => b[1] - a[1]);
}

export function AgentsPage() {
  const { data: sessions, isLoading } = useSessions({});
  const [filter, setFilter] = useState<'active' | 'all'>('active');
  const qc = useQueryClient();
  const doing = (() => {
    const m = new Map<string, { graph: string; node: string; title: string; progress?: number }>();
    for (const [, v] of qc.getQueriesData<GraphView>({ queryKey: ['graph'] })) {
      if (!v) continue;
      for (const n of v.nodes) {
        const sid = n.currentAttempt?.executor.sessionId;
        if (sid)
          m.set(sid, {
            graph: v.graph.slug ?? v.graph.id,
            node: n.key,
            title: v.graph.title,
            ...(n.currentAttempt?.progress !== undefined
              ? { progress: n.currentAttempt.progress }
              : {}),
          });
      }
    }
    return m;
  })();
  const list = (sessions ?? []).filter((s) => filter === 'all' || s.status === 'active');
  const agents = (sessions ?? []).filter((s) => s.kind !== 'human');
  return (
    <section className="view on page" aria-label="Agents">
      <div className="page-in">
        <div className="page-h">
          <div>
            <h1>Agents</h1>
            <div className="sub">
              Registered agent and human sessions, what each is doing, and usage.
            </div>
          </div>
          <div className="right">
            <Segmented
              label="Sessions"
              value={filter}
              onChange={setFilter}
              options={[
                { value: 'active', label: 'Active' },
                { value: 'all', label: 'Recent' },
              ]}
            />
          </div>
        </div>
        <div className="ov-grid">
          <div className="card">
            <div className="card-h">
              <h3>Sessions</h3>
              <span className="sub">{list.length}</span>
            </div>
            {isLoading ? (
              <Skeleton style={{ height: 200, margin: 16 }} />
            ) : list.length === 0 ? (
              <Empty icon={<Bot />} title="No sessions">
                Agents register a session when they claim work or attach as orchestrators.
              </Empty>
            ) : (
              <table className="tbl compact">
                <thead>
                  <tr>
                    <th>Agent</th>
                    <th>Status</th>
                    <th>Doing</th>
                    <th>Started</th>
                    <th>Last seen</th>
                  </tr>
                </thead>
                <tbody>
                  {list.map((s) => {
                    const d = doing.get(s.id);
                    return (
                      <tr key={s.id} style={{ cursor: 'default' }}>
                        <td>
                          <Annot x={s.annotation} />
                          {s.parentSessionId && (
                            <div className="muted mono" style={{ fontSize: 10.5 }}>
                              child of {s.parentSessionId}
                            </div>
                          )}
                        </td>
                        <td>
                          <StatusPill status={s.status} />
                        </td>
                        <td>
                          {d ? (
                            <Link
                              to="/graphs/$graph/nodes/$node"
                              params={{ graph: d.graph, node: d.node }}
                              className="link mono"
                            >
                              {d.node}
                              {d.progress !== undefined ? ` · ${d.progress}%` : ''}
                            </Link>
                          ) : (
                            <span className="muted">{s.role ?? '—'}</span>
                          )}
                        </td>
                        <td className="muted">{timeAgo(s.startedAt)}</td>
                        <td className="muted">{timeAgo(s.lastSeenAt)}</td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            )}
          </div>
          <div className="ov-col">
            {(['model', 'provider', 'mechanism'] as const).map((k) => {
              const rows = group(agents, k);
              const max = Math.max(1, ...rows.map((r) => r[1]));
              return (
                <div key={k} className="card">
                  <div className="card-h">
                    <h3>By {k}</h3>
                  </div>
                  <div className="mbars">
                    {rows.length === 0 && <span className="muted">No agent sessions.</span>}
                    {rows.map(([v, c], i) => (
                      <div key={v} className="mbar">
                        <span className="nm">
                          {k === 'model' && <MonoTile x={{ kind: 'agent', model: v }} />}
                          {k === 'mechanism' && <MechanismIcon mechanism={v} />}
                          <span className="ellipsis">
                            {k === 'model' ? modelInfo(v, undefined).name : v}
                          </span>
                        </span>
                        <span className="track">
                          <i
                            style={{
                              width: `${(c / max) * 100}%`,
                              ['--c' as string]: `var(--cat-${(i % 4) + 1})`,
                            }}
                          />
                        </span>
                        <span className="val">{c}</span>
                      </div>
                    ))}
                  </div>
                </div>
              );
            })}
          </div>
        </div>
      </div>
    </section>
  );
}
