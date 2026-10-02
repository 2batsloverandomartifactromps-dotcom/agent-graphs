/**
 * Aims tab: graph aims as cards and every node's aims with their verdicts. (docs/ui.md lists
 * the full Aims tab with metric charts for M5; this is the M4 subset.)
 */
import { Link } from '@tanstack/react-router';
import { AimChip, GraphAimChip } from '../../../components/display';
import { StatusIcon, StatusPill } from '../../../components/status';
import { formatMetricValue, formatTarget } from '../../../lib/format';
import { aimMeta } from '../../../lib/status';
import { cn } from '../../../lib/utils';
import { useWorkspace } from '../workspace';

export function AimsTab() {
  const { graph, view } = useWorkspace();
  return (
    <div className="page">
      <div className="page-in full">
        <div className="page-h">
          <div>
            <h1 style={{ fontSize: 16 }}>Overall aims</h1>
            <div className="sub">
              Displayed live; they terminate the graph only during verification.
            </div>
          </div>
        </div>
        <div
          style={{
            display: 'grid',
            gridTemplateColumns: 'repeat(auto-fill, minmax(320px, 1fr))',
            gap: 12,
          }}
        >
          {view.aims.map((a) => {
            const m = aimMeta(a.status);
            return (
              <div
                key={a.id}
                className={cn('aim-card', m.cls, a.terminating && 'term')}
                style={{ marginTop: 0 }}
              >
                <div className="aim-top">
                  <StatusIcon status={a.status} aim />
                  <span className="title">{a.title}</span>
                  <span className="right">
                    <span className={cn('pill', m.cls)}>{m.label}</span>
                  </span>
                </div>
                <div className="aim-meta">
                  <span className="tag mono">{a.key}</span>
                  <span className="tag">{a.kind}</span>
                  {a.guard && <span className="tag">guard</span>}
                  <span className="tag">evaluator: {a.evaluator}</span>
                </div>
                {a.kind === 'quantitative' && (
                  <div className="quant">
                    <div>
                      <div className="big">
                        {formatMetricValue(a.currentValue, a)}
                        <small>/ {formatTarget(a)}</small>
                      </div>
                      <div className="metric">
                        {a.metric} · {a.source}
                      </div>
                    </div>
                    <GraphAimChip aim={a} />
                  </div>
                )}
                {a.criteria?.length ? (
                  <ul className="criteria">
                    {a.criteria.map((c) => (
                      <li key={c}>{c}</li>
                    ))}
                  </ul>
                ) : null}
              </div>
            );
          })}
        </div>
        <div className="page-h" style={{ marginTop: 24 }}>
          <div>
            <h1 style={{ fontSize: 16 }}>Node aims</h1>
            <div className="sub">Every node’s aims with their current verdict.</div>
          </div>
        </div>
        <div className="card" style={{ overflow: 'hidden' }}>
          <table className="tbl compact">
            <thead>
              <tr>
                <th>Node</th>
                <th>Status</th>
                <th>Aims</th>
              </tr>
            </thead>
            <tbody>
              {view.nodes
                .filter((n) => n.aims.some((a) => !a.implicit))
                .map((n) => (
                  <tr key={n.id}>
                    <td>
                      <Link
                        to="/graphs/$graph/nodes/$node"
                        params={{ graph, node: n.key }}
                        search={{ tab: 'aims' }}
                        className="mono link"
                      >
                        {n.key}
                      </Link>
                    </td>
                    <td>
                      <StatusPill status={n.status} />
                    </td>
                    <td>
                      <div className="row" style={{ gap: 4, flexWrap: 'wrap' }}>
                        {n.aims
                          .filter((a) => !a.implicit)
                          .map((a) => (
                            <AimChip key={a.key} aim={a} />
                          ))}
                      </div>
                    </td>
                  </tr>
                ))}
            </tbody>
          </table>
        </div>
      </div>
    </div>
  );
}
