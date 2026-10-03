/**
 * Activity tab (docs/ui.md §4.3, §8): the event feed with filters, a detail view with actor and
 * payload, the hash-chain status, and a "N new events" pill instead of auto-scrolling.
 */
import type { StoredEvent } from '@agent-graphs/sdk';
import { useQuery } from '@tanstack/react-query';
import { useNavigate, useSearch } from '@tanstack/react-router';
import { ShieldCheck, ShieldX } from 'lucide-react';
import { useEffect, useMemo, useRef, useState } from 'react';
import { Annot } from '../../../components/exec-badge';
import { Glyph } from '../../../components/status';
import { Empty, Modal, Skeleton } from '../../../components/ui';
import { useClient } from '../../../lib/api';
import { actorName, describeEvent, fromStored } from '../../../lib/events';
import { formatDateTime, timeAgo } from '../../../lib/format';
import { qk, useEvents } from '../../../lib/queries';
import { statusMeta } from '../../../lib/status';
import { cn } from '../../../lib/utils';
import type { TabSearch } from '../../../router';
import { useWorkspace } from '../workspace';

const FAMILIES = [
  'graph',
  'node',
  'attempt',
  'aim',
  'request',
  'directive',
  'note',
  'loop',
  'orchestrator',
  'metric',
];

export function ActivityTab() {
  const { graph, view } = useWorkspace();
  const client = useClient();
  const search = useSearch({ strict: false }) as TabSearch;
  const navigate = useNavigate();
  const { data, isLoading } = useEvents(graph, { limit: 2000 });
  const { data: audit } = useQuery({
    queryKey: qk.audit(graph),
    queryFn: () => client.verifyAudit(graph),
  });
  const keyOf = useMemo(() => {
    const m = new Map(view.nodes.map((n) => [n.id, n.key]));
    return (id: string) => m.get(id);
  }, [view.nodes]);
  const families = search.types ? new Set(search.types.split(',')) : undefined;
  const events = (data ?? []).filter((e) => !families || families.has(e.type.split('.')[0] ?? ''));
  const [selected, setSelected] = useState<StoredEvent | null>(null);
  const listRef = useRef<HTMLDivElement>(null);
  const [seenTop, setSeenTop] = useState<number | undefined>(undefined);
  const top = events[0]?.seq;
  const [scrolledAway, setScrolledAway] = useState(false);
  useEffect(() => {
    if (!scrolledAway) setSeenTop(top);
  }, [top, scrolledAway]);
  const newCount =
    scrolledAway && seenTop !== undefined ? events.filter((e) => e.seq > seenTop).length : 0;

  const toggleFamily = (f: string) => {
    const next = new Set(families ?? []);
    if (next.has(f)) next.delete(f);
    else next.add(f);
    void navigate({
      to: '.',
      search: (p) => ({ ...(p as object), types: next.size ? [...next].join(',') : undefined }),
      replace: true,
    });
  };

  return (
    <div
      className="page"
      ref={listRef}
      onScroll={(e) => setScrolledAway((e.target as HTMLElement).scrollTop > 80)}
    >
      <div className="page-in full">
        <div className="filters">
          <button
            type="button"
            className={cn('fchip', !families && 'on')}
            onClick={() =>
              void navigate({
                to: '.',
                search: (p) => ({ ...(p as object), types: undefined }),
                replace: true,
              })
            }
          >
            All <span className="n">{data?.length ?? 0}</span>
          </button>
          {FAMILIES.map((f) => (
            <button
              key={f}
              type="button"
              className={cn('fchip', families?.has(f) && 'on')}
              onClick={() => toggleFamily(f)}
              aria-pressed={Boolean(families?.has(f))}
            >
              {f}
            </button>
          ))}
          <span style={{ marginLeft: 'auto' }} />
          {audit && (
            <span
              className={cn('pill', audit.ok ? 'st-done' : 'st-failed', !audit.ok && 'solid')}
              data-testid="audit-status"
            >
              {audit.ok ? <ShieldCheck size={13} /> : <ShieldX size={13} />}
              {audit.ok
                ? `Audit chain verified ✓ · ${audit.events.toLocaleString('en-US')} events`
                : `Chain mismatch at #${audit.firstMismatch}`}
            </span>
          )}
        </div>
        {newCount > 0 && (
          <div className="new-pill">
            <button
              type="button"
              onClick={() => {
                listRef.current?.scrollTo({ top: 0, behavior: 'smooth' });
                setScrolledAway(false);
              }}
            >
              {newCount} new event{newCount === 1 ? '' : 's'}
            </button>
          </div>
        )}
        <div className="card">
          {isLoading ? (
            <Skeleton style={{ height: 240, margin: 16 }} />
          ) : events.length === 0 ? (
            <Empty title="No events" />
          ) : (
            events.slice(0, 500).map((e) => {
              const desc = describeEvent(fromStored(e), keyOf);
              const tone = desc.tone.startsWith('st-') ? desc.tone : 'st-pending';
              return (
                <button
                  key={e.seq}
                  type="button"
                  className="feed-row"
                  style={{ width: '100%', textAlign: 'left' }}
                  onClick={() => setSelected(e)}
                >
                  <span className={cn('sicon', tone)}>
                    <Glyph name={statusMeta(tone.replace('st-', '')).icon} />
                  </span>
                  <span className="what">
                    <span className="who">{actorName(e.actor)}</span>
                    <span>{desc.verb}</span>
                    {desc.target && <span className="tgt">{desc.target}</span>}
                    {desc.detail && <span className="ellipsis">{desc.detail}</span>}
                  </span>
                  <span className="when" title={formatDateTime(e.createdAt)}>
                    <span className="mono" style={{ marginRight: 8 }}>
                      #{e.seq}
                    </span>
                    {timeAgo(e.createdAt)}
                  </span>
                </button>
              );
            })
          )}
        </div>
      </div>
      <Modal
        open={Boolean(selected)}
        onOpenChange={(o) => !o && setSelected(null)}
        title={selected?.type ?? ''}
        wide
      >
        {selected && (
          <div className="col" style={{ gap: 10 }}>
            <div className="row" style={{ gap: 8, flexWrap: 'wrap' }}>
              <span className="tag mono">#{selected.seq}</span>
              <span className="tag">{selected.entityType}</span>
              <span className="tag mono">{selected.entityId}</span>
              <span className="muted">{formatDateTime(selected.createdAt)}</span>
            </div>
            <Annot x={selected.actor} />
            <div className="eyebrow">Payload</div>
            <pre className="event-json">{JSON.stringify(selected.payload, null, 2)}</pre>
            <div className="muted mono" style={{ fontSize: 11 }}>
              hash {selected.hash.slice(0, 16)}… · prev {selected.prevHash.slice(0, 16)}…
            </div>
          </div>
        )}
      </Modal>
    </div>
  );
}
