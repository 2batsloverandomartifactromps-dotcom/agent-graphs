/** The canvas as an accessible, sortable table (docs/ui.md §5.3, §6.5). */
import type { NodeSummary } from '@agent-graphs/sdk';
import { ArrowDown, ArrowUp } from 'lucide-react';
import { useMemo, useState } from 'react';
import { ExecBadge } from '../../../components/exec-badge';
import { StatusPill } from '../../../components/status';
import { timeAgo } from '../../../lib/format';
import { attemptsInActivation, STATUS_ORDER } from '../../../lib/status';
import { cn } from '../../../lib/utils';

type SortKey = 'key' | 'title' | 'status' | 'kind' | 'attempts' | 'aims' | 'updated';

export function NodeTable({
  nodes,
  selected,
  onSelect,
}: {
  nodes: NodeSummary[];
  selected?: string;
  onSelect: (key: string) => void;
}) {
  const [sort, setSort] = useState<{ key: SortKey; dir: 1 | -1 }>({ key: 'status', dir: 1 });
  const rows = useMemo(() => {
    const val = (n: NodeSummary): string | number => {
      switch (sort.key) {
        case 'status':
          return STATUS_ORDER.indexOf(n.status);
        case 'attempts':
          return n.countedAttempts;
        case 'aims':
          return n.aims.filter((a) => a.status === 'met' || a.status === 'waived').length;
        case 'updated':
          return Date.parse(n.updatedAt);
        case 'kind':
          return n.kind;
        case 'title':
          return n.title.toLowerCase();
        default:
          return n.key;
      }
    };
    return nodes.slice().sort((a, b) => {
      const x = val(a);
      const y = val(b);
      return (x < y ? -1 : x > y ? 1 : 0) * sort.dir;
    });
  }, [nodes, sort]);
  const header = (key: SortKey, label: string) => (
    <th aria-sort={sort.key === key ? (sort.dir === 1 ? 'ascending' : 'descending') : 'none'}>
      <button
        type="button"
        onClick={() => setSort((s) => ({ key, dir: s.key === key ? (-s.dir as 1 | -1) : 1 }))}
      >
        {label}
        {sort.key === key && (sort.dir === 1 ? <ArrowUp size={11} /> : <ArrowDown size={11} />)}
      </button>
    </th>
  );
  return (
    <div className="page" style={{ padding: '72px 16px 16px' }}>
      <div className="card" style={{ overflow: 'hidden' }}>
        <table className="tbl compact" aria-label="Nodes">
          <thead>
            <tr>
              {header('key', 'Key')}
              {header('title', 'Title')}
              {header('status', 'Status')}
              {header('kind', 'Kind')}
              {header('attempts', 'Attempts')}
              {header('aims', 'Aims')}
              <th>Executor</th>
              {header('updated', 'Updated')}
            </tr>
          </thead>
          <tbody>
            {rows.map((n) => (
              <tr
                key={n.id}
                className={cn(selected === n.key && 'sel')}
                tabIndex={0}
                onClick={() => onSelect(n.key)}
                onKeyDown={(e) => {
                  if (e.key === 'Enter') onSelect(n.key);
                }}
                aria-selected={selected === n.key}
              >
                <td className="mono">{n.key}</td>
                <td>{n.title}</td>
                <td>
                  <StatusPill status={n.status} />
                </td>
                <td className="muted">{n.kind}</td>
                <td className="num">
                  {attemptsInActivation(n)}/{n.maxAttempts}
                </td>
                <td className="num">
                  {n.aims.filter((a) => a.status === 'met' || a.status === 'waived').length}/
                  {n.aims.length}
                </td>
                <td>
                  {n.currentAttempt ? (
                    <ExecBadge x={n.currentAttempt.executor} />
                  ) : (
                    <span className="muted">—</span>
                  )}
                </td>
                <td className="muted">{timeAgo(n.updatedAt)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}
