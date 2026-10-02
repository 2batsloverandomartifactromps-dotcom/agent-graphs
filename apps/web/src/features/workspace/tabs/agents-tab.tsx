/**
 * Graph Agents tab (docs/ui.md §4.3): sessions that touched this graph, usage and cost by model,
 * and "recommended vs actual" executor mismatches.
 */
import { Link } from '@tanstack/react-router';
import { AlertTriangle } from 'lucide-react';
import { Annot, ExecBadge, executorMismatch } from '../../../components/exec-badge';
import { StatusPill } from '../../../components/status';
import { Empty, Skeleton } from '../../../components/ui';
import { formatTokens, formatUsd, timeAgo } from '../../../lib/format';
import { useSessions, useStats } from '../../../lib/queries';
import { modelInfo } from '../../../lib/vocab';
import { useWorkspace } from '../workspace';

export function AgentsTab() {
  const { graph, view } = useWorkspace();
  const { data: sessions, isLoading } = useSessions({ graph });
  const { data: stats } = useStats(graph);
  const working = new Map(
    view.nodes
      .filter((n) => n.currentAttempt?.executor.sessionId)
      .map((n) => [n.currentAttempt?.executor.sessionId as string, n]),
  );
  const mismatches = view.nodes
    .map((n) => ({ n, m: executorMismatch(n.executor, n.currentAttempt?.executor) }))
    .filter((x) => x.m);
  const byModel = Object.entries(stats?.byModel ?? {}).sort(
    (a, b) => b[1].attempts - a[1].attempts,
  );
  const maxAttempts = Math.max(1, ...byModel.map(([, v]) => v.attempts));
  return (
    <div className="page">
      <div className="page-in full ov-grid">
        <div className="ov-col">
          <div className="card">
            <div className="card-h">
              <h3>Sessions</h3>
              <span className="sub">{sessions?.length ?? 0} touched this graph</span>
            </div>
            {isLoading ? (
              <Skeleton style={{ height: 160, margin: 16 }} />
            ) : !sessions || sessions.length === 0 ? (
              <Empty title="No agent sessions yet">
                Sessions appear when agents claim nodes or attach as orchestrators.
              </Empty>
            ) : (
              <table className="tbl compact">
                <thead>
                  <tr>
                    <th>Agent</th>
                    <th>Status</th>
                    <th>Working on</th>
                    <th>Last seen</th>
                  </tr>
                </thead>
                <tbody>
                  {sessions.map((s) => {
                    const node = working.get(s.id);
                    return (
                      <tr key={s.id} style={{ cursor: 'default' }}>
                        <td>
                          <Annot x={s.annotation} />
                        </td>
                        <td>
                          <StatusPill status={s.status} />
                        </td>
                        <td>
                          {node ? (
                            <Link
                              to="/graphs/$graph/nodes/$node"
                              params={{ graph, node: node.key }}
                              className="mono link"
                            >
                              {node.key}
                            </Link>
                          ) : (
                            <span className="muted">—</span>
                          )}
                        </td>
                        <td className="muted">{timeAgo(s.lastSeenAt)}</td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            )}
          </div>
        </div>
        <div className="ov-col">
          <div className="card">
            <div className="card-h">
              <h3>Usage by model</h3>
              {stats && (
                <span className="sub">
                  {formatUsd(stats.costUsd)} · {formatTokens(stats.tokens)}
                </span>
              )}
            </div>
            <div className="mbars">
              {byModel.length === 0 && <span className="muted">No usage reported yet.</span>}
              {byModel.map(([model, v]) => {
                const info = modelInfo(model, undefined);
                return (
                  <div key={model} className="mbar">
                    <span className="nm">
                      <ExecBadge
                        x={{ kind: 'agent', model, provider: info.provider }}
                        plain
                        noThink
                      />
                    </span>
                    <span className="track">
                      <i
                        style={{
                          width: `${(v.attempts / maxAttempts) * 100}%`,
                          ['--c' as string]: 'var(--cat-1)',
                        }}
                      />
                    </span>
                    <span
                      className="val"
                      title={`${v.attempts} attempts · ${formatTokens(v.tokens)}`}
                    >
                      {formatUsd(v.costUsd)}
                    </span>
                  </div>
                );
              })}
            </div>
          </div>
          <div className="card">
            <div className="card-h">
              <h3>Recommended vs actual</h3>
              <span className="sub">
                {mismatches.length} mismatch{mismatches.length === 1 ? '' : 'es'}
              </span>
            </div>
            <div className="card-b col" style={{ gap: 8 }}>
              {mismatches.length === 0 && (
                <span className="muted">Running work matches the executor hints.</span>
              )}
              {mismatches.map(({ n, m }) => (
                <div key={n.id} className="row" style={{ gap: 8 }}>
                  <AlertTriangle size={14} style={{ color: 'var(--s-evaluating)' }} />
                  <span className="mono">{n.key}</span>
                  <span className="muted">{m}</span>
                </div>
              ))}
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}
