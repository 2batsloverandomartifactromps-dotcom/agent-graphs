/**
 * Orchestrator inspector (docs/ui.md §4.5): role, status and bound session (lease, heartbeat),
 * aim, purpose, prompt, scope, capabilities, the duty queue, notes, activity and controls.
 */
import type { Orchestrator } from '@agent-graphs/sdk';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { useNavigate, useParams, useSearch } from '@tanstack/react-router';
import { Bot, ListTodo, MessageSquarePlus, Pause, Play, Square, X } from 'lucide-react';
import { useState } from 'react';
import { toast } from 'sonner';
import { Markdown, NoteThread } from '../../components/display';
import { Annot, ExecBadge } from '../../components/exec-badge';
import { Glyph, StatusPill } from '../../components/status';
import { Button, Empty, IconButton } from '../../components/ui';
import { toastError, useClient } from '../../lib/api';
import { actorName, describeEvent, fromStored } from '../../lib/events';
import { timeAgo, timeLeft } from '../../lib/format';
import { qk, useEvents, useNotes, useSessions } from '../../lib/queries';
import { statusMeta } from '../../lib/status';
import { cn } from '../../lib/utils';
import type { NodeSearch } from '../../router';
import { ROLE_ICON, scopeKeys } from './canvas/orchestration-lane';
import { DirectiveComposer } from './directives';
import { InspectorDrawer, InspectorTabs, Section } from './inspector-shell';
import { useWorkspace, withoutTab } from './workspace';

type OrchTab = 'overview' | 'queue' | 'notes' | 'activity';

export function OrchestratorInspectorRoute() {
  const { key } = useParams({ strict: false }) as { key: string };
  const search = useSearch({ strict: false }) as NodeSearch;
  const navigate = useNavigate();
  const { graph, view } = useWorkspace();
  const o = view.orchestrators.find((x) => x.key === key);
  const tab = (
    ['overview', 'queue', 'notes', 'activity'].includes(search.tab ?? '') ? search.tab : 'overview'
  ) as OrchTab;
  if (!o)
    return (
      <InspectorDrawer label="Orchestrator inspector">
        <Empty title="Orchestrator not found" />
      </InspectorDrawer>
    );
  return (
    <OrchestratorInspector
      graph={graph}
      o={o}
      nodeKeys={[...scopeKeys(o, view.nodes)]}
      tab={tab}
      onTab={(t) =>
        void navigate({
          to: '.',
          search: (p) => ({ ...(p as object), tab: t === 'overview' ? undefined : t }),
          replace: true,
        })
      }
      onClose={() => void navigate({ to: '/graphs/$graph', params: { graph }, search: withoutTab })}
    />
  );
}

function OrchestratorInspector({
  graph,
  o,
  nodeKeys,
  tab,
  onTab,
  onClose,
}: {
  graph: string;
  o: Orchestrator;
  nodeKeys: string[];
  tab: OrchTab;
  onTab: (t: OrchTab) => void;
  onClose: () => void;
}) {
  const client = useClient();
  const qc = useQueryClient();
  const [directiveOpen, setDirectiveOpen] = useState(false);
  const { data: queue } = useQuery({
    queryKey: qk.queue(graph, o.key),
    queryFn: () => client.queue(graph, o.key).then((r) => r.items),
  });
  const { data: notes } = useNotes({ graph, limit: 500 });
  const { data: sessions } = useSessions({ graph });
  const { data: events } = useEvents(graph, { limit: 3000 });
  const session = sessions?.find((s) => s.id === o.sessionId);
  const myNotes = (notes ?? []).filter(
    (n) => n.orchestratorId === o.id || (o.sessionId && n.author.sessionId === o.sessionId),
  );
  const myEvents = (events ?? []).filter(
    (e) => e.entityId === o.id || (o.sessionId && e.actor.sessionId === o.sessionId),
  );
  const Icon = ROLE_ICON[o.role] ?? Bot;
  const control = async (action: 'pause' | 'resume' | 'stop') => {
    try {
      await client.orchestratorControl(graph, o.key, action);
      toast.success(`Orchestrator ${action === 'stop' ? 'stopped' : `${action}d`}`);
      void qc.invalidateQueries({ queryKey: qk.graph(graph) });
    } catch (e) {
      toastError(e);
    }
  };
  return (
    <InspectorDrawer label={`Orchestrator inspector: ${o.name}`}>
      <div className="ins-head">
        <div className="ins-top">
          <div className="grow">
            <StatusPill status={o.status} />
            <span className="tag">{o.role}</span>
          </div>
          <IconButton label="Close inspector" onClick={onClose}>
            <X size={14} />
          </IconButton>
        </div>
        <h2 className="ins-title row" style={{ gap: 8 }}>
          <span className="kind-ico st-active" style={{ width: 26, height: 26 }}>
            <Icon size={14} />
          </span>
          {o.name}
        </h2>
        <div className="ins-sub">
          <span className="ins-key">{o.key}</span>
          <ExecBadge x={{ kind: 'agent', ...o.executor }} />
          {o.capabilities.map((c) => (
            <span key={c} className="tag accent">
              {c}
            </span>
          ))}
        </div>
        <div className="ins-actions">
          {o.status === 'paused' ? (
            <Button size="sm" onClick={() => void control('resume')}>
              <Play />
              Resume
            </Button>
          ) : (
            <Button
              size="sm"
              onClick={() => void control('pause')}
              disabled={o.status === 'stopped'}
            >
              <Pause />
              Pause
            </Button>
          )}
          <Button size="sm" onClick={() => void control('stop')} disabled={o.status === 'stopped'}>
            <Square />
            Stop
          </Button>
          <Button size="sm" variant="primary" onClick={() => setDirectiveOpen(true)}>
            <MessageSquarePlus />
            Add directive
          </Button>
        </div>
      </div>
      <InspectorTabs
        tabs={[
          { id: 'overview', label: 'Overview' },
          { id: 'queue', label: 'Duty queue', count: queue?.length || undefined },
          { id: 'notes', label: 'Notes', count: myNotes.length || undefined },
          { id: 'activity', label: 'Activity' },
        ]}
        value={tab}
        onChange={onTab}
      />
      <div className="ins-body" role="tabpanel">
        {tab === 'overview' && (
          <>
            <div className={cn('statebox', statusMeta(o.status).cls)}>
              <div className="sb-top">
                <b>{statusMeta(o.status).label}</b>
                {session && <ExecBadge x={session.annotation} />}
              </div>
              <div className="sb-msg">
                {o.status === 'active' && o.sessionId ? (
                  <>
                    Bound to session <span className="mono">{o.sessionId}</span> · lease{' '}
                    {timeLeft(o.leaseExpiresAt)} · heartbeat {timeAgo(o.lastHeartbeatAt)}
                  </>
                ) : (
                  'No session attached. An agent attaches with POST /graphs/{graph}/orchestrators/{key}/attach.'
                )}
              </div>
              {session && (
                <div className="sb-msg">
                  <Annot x={session.annotation} />
                </div>
              )}
            </div>
            {o.aim && (
              <Section title="Aim">
                <p>{o.aim}</p>
              </Section>
            )}
            {o.purpose && (
              <Section title="Purpose">
                <p className="dim">{o.purpose}</p>
              </Section>
            )}
            {o.prompt && (
              <Section title="Prompt">
                <Markdown text={o.prompt} />
              </Section>
            )}
            <Section title="Scope">
              <p className="dim" style={{ marginBottom: 6 }}>
                {o.scope === 'all' ? 'All nodes' : JSON.stringify(o.scope)} · {nodeKeys.length} node
                {nodeKeys.length === 1 ? '' : 's'} (highlighted on hover in the lane)
              </p>
              <div className="ev" style={{ padding: 0 }}>
                {nodeKeys.slice(0, 40).map((k) => (
                  <span key={k} className="chip mono">
                    {k}
                  </span>
                ))}
              </div>
            </Section>
            {o.triggers.length > 0 && (
              <Section title="Triggers">
                <div className="ev" style={{ padding: 0 }}>
                  {o.triggers.map((t) => (
                    <span key={t} className="chip mono">
                      {t}
                    </span>
                  ))}
                </div>
              </Section>
            )}
            {o.aims && o.aims.length > 0 && (
              <Section title="Aims (informational)">
                {o.aims.map((a) => (
                  <div key={a.id} className="row" style={{ gap: 8, marginBottom: 4 }}>
                    <span className={cn('sicon', statusMeta(a.status).cls)}>
                      <Glyph
                        name={a.status === 'pending' ? 'aimpending' : statusMeta(a.status).icon}
                      />
                    </span>
                    {a.title}
                  </div>
                ))}
              </Section>
            )}
          </>
        )}
        {tab === 'queue' && (
          <Section title="Duty queue" icon={<ListTodo size={12} />}>
            {!queue || queue.length === 0 ? (
              <div className="muted">Nothing to do right now.</div>
            ) : (
              queue.map((item, i) => {
                const it = item as unknown as Record<string, unknown>;
                return (
                  // biome-ignore lint/suspicious/noArrayIndexKey: queue items have no stable id
                  <div key={i} className="act">
                    <span className="tag">{String(it.kind ?? it.type ?? 'item')}</span>
                    <div className="what">
                      <b>{String(it.title ?? it.nodeKey ?? it.summary ?? '')}</b>{' '}
                      <span className="muted">{String(it.reason ?? it.detail ?? '')}</span>
                    </div>
                  </div>
                );
              })
            )}
          </Section>
        )}
        {tab === 'notes' &&
          (myNotes.length ? (
            <NoteThread notes={myNotes} />
          ) : (
            <Empty title="No notes from this orchestrator yet" />
          ))}
        {tab === 'activity' &&
          (myEvents.length ? (
            myEvents.slice(0, 150).map((e) => {
              const desc = describeEvent(fromStored(e));
              return (
                <div key={e.seq} className="act">
                  <span
                    className={cn('sicon', desc.tone.startsWith('st-') ? desc.tone : 'st-pending')}
                  >
                    <Glyph name={statusMeta(desc.tone.replace('st-', '')).icon} />
                  </span>
                  <div className="what">
                    <b>{actorName(e.actor)}</b> {desc.verb}{' '}
                    {desc.target && <span className="mono">{desc.target}</span>}
                  </div>
                  <span className="when">{timeAgo(e.createdAt)}</span>
                </div>
              );
            })
          ) : (
            <Empty title="No activity yet" />
          ))}
      </div>
      <DirectiveComposer
        open={directiveOpen}
        onOpenChange={setDirectiveOpen}
        graph={graph}
        target={{ type: 'orchestrator', key: o.key }}
        targetLabel={`the ${o.name} orchestrator`}
      />
    </InspectorDrawer>
  );
}
