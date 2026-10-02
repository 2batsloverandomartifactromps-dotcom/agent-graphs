/** Graph settings tab (docs/ui.md §4.3): details, policy, guard aims, orchestrators, danger zone. */
import { useQueryClient } from '@tanstack/react-query';
import { useNavigate } from '@tanstack/react-router';
import { Trash2 } from 'lucide-react';
import { useState } from 'react';
import { toast } from 'sonner';
import { ExecBadge } from '../../../components/exec-badge';
import { StatusPill } from '../../../components/status';
import { Button, ConfirmDialog } from '../../../components/ui';
import { toastError, useClient } from '../../../lib/api';
import { formatTarget } from '../../../lib/format';
import { qk } from '../../../lib/queries';
import { useWorkspace } from '../workspace';

export function GraphSettingsTab() {
  const { graph, view } = useWorkspace();
  const client = useClient();
  const qc = useQueryClient();
  const navigate = useNavigate();
  const g = view.graph;
  const [title, setTitle] = useState(g.title);
  const [description, setDescription] = useState(g.description ?? '');
  const [tags, setTags] = useState(g.tags.join(', '));
  const [confirmDelete, setConfirmDelete] = useState(false);
  const save = async () => {
    try {
      await client.patchGraph(
        graph,
        {
          title,
          description,
          tags: tags
            .split(',')
            .map((t) => t.trim())
            .filter(Boolean),
        },
        g.version,
      );
      toast.success('Graph updated');
      void qc.invalidateQueries({ queryKey: qk.graph(graph) });
      void qc.invalidateQueries({ queryKey: ['graphs'] });
    } catch (e) {
      toastError(e, 'Save');
    }
  };
  const policy = g.policy as unknown as Record<string, unknown>;
  return (
    <div className="page">
      <div className="page-in" style={{ maxWidth: 880 }}>
        <div className="card">
          <div className="card-h">
            <h3>Details</h3>
          </div>
          <div className="card-b">
            <div className="field" style={{ marginTop: 0 }}>
              <label htmlFor="g-title">Title</label>
              <input
                id="g-title"
                className="input"
                value={title}
                onChange={(e) => setTitle(e.target.value)}
              />
            </div>
            <div className="field">
              <label htmlFor="g-desc">Description</label>
              <textarea
                id="g-desc"
                className="textarea prose"
                value={description}
                onChange={(e) => setDescription(e.target.value)}
              />
            </div>
            <div className="field">
              <label htmlFor="g-tags">Tags</label>
              <input
                id="g-tags"
                className="input"
                value={tags}
                onChange={(e) => setTags(e.target.value)}
              />
            </div>
            <div className="row" style={{ justifyContent: 'flex-end', marginTop: 12 }}>
              <Button variant="primary" size="sm" onClick={save}>
                Save details
              </Button>
            </div>
          </div>
        </div>
        <div className="card" style={{ marginTop: 14 }}>
          <div className="card-h">
            <h3>Policy</h3>
            <span className="sub">Protected; edit through the Spec tab (admin).</span>
          </div>
          <div className="card-b hints">
            {Object.entries(policy).map(([k, v]) => (
              <div key={k} className="kv">
                <span className="k">{k}</span>
                <span className="v mono">
                  {typeof v === 'object' ? JSON.stringify(v) : String(v)}
                </span>
              </div>
            ))}
          </div>
        </div>
        <div className="card" style={{ marginTop: 14 }}>
          <div className="card-h">
            <h3>Guard aims</h3>
          </div>
          <div className="card-b col" style={{ gap: 8 }}>
            {view.aims.filter((a) => a.guard).length === 0 && (
              <span className="muted">No guards. Guards pause the graph when violated.</span>
            )}
            {view.aims
              .filter((a) => a.guard)
              .map((a) => (
                <div key={a.id} className="row">
                  <StatusPill status={a.status === 'pending' ? 'pending' : a.status} />
                  <b style={{ fontWeight: 500 }}>{a.title}</b>
                  <span className="mono muted">
                    {a.metric} {formatTarget(a)}
                  </span>
                </div>
              ))}
          </div>
        </div>
        <div className="card" style={{ marginTop: 14 }}>
          <div className="card-h">
            <h3>Orchestrators</h3>
          </div>
          <div className="card-b col" style={{ gap: 8 }}>
            {view.orchestrators.map((o) => (
              <div key={o.id} className="row">
                <StatusPill status={o.status} />
                <b style={{ fontWeight: 500 }}>{o.name}</b>
                <span className="tag">{o.role}</span>
                <ExecBadge x={{ kind: 'agent', ...o.executor }} />
                <span className="muted">{o.capabilities.join(', ') || 'no capabilities'}</span>
              </div>
            ))}
          </div>
        </div>
        <div
          className="card"
          style={{
            marginTop: 14,
            borderColor: 'color-mix(in srgb, var(--s-blocked) 35%, var(--line))',
          }}
        >
          <div className="card-h">
            <h3>Danger zone</h3>
          </div>
          <div className="card-b row" style={{ justifyContent: 'space-between' }}>
            <span className="muted">
              Delete this graph (drafts only; other graphs must be archived first).
            </span>
            <Button
              variant="danger"
              size="sm"
              onClick={() => setConfirmDelete(true)}
              disabled={g.status !== 'draft' && !g.archivedAt}
            >
              <Trash2 />
              Delete graph
            </Button>
          </div>
        </div>
      </div>
      <ConfirmDialog
        open={confirmDelete}
        onOpenChange={setConfirmDelete}
        title="Delete this graph?"
        description="This cannot be undone."
        destructive
        confirmLabel="Delete"
        onConfirm={async () => {
          try {
            await client.deleteGraph(graph);
            toast.success('Graph deleted');
            void qc.invalidateQueries({ queryKey: ['graphs'] });
            void navigate({ to: '/graphs' });
          } catch (e) {
            toastError(e, 'Delete');
            throw e;
          }
        }}
      />
    </div>
  );
}
