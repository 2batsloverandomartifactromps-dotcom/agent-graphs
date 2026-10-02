/**
 * Spec tab (docs/ui.md §4.3): the canonical YAML export (copy, download) and Edit-as-YAML,
 * which validates locally, previews the diff as mutation operations, and applies them with
 * POST /graphs/{g}/mutations.
 */
import { validateSpecText } from '@agent-graphs/core';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { useNavigate, useSearch } from '@tanstack/react-router';
import { Copy, Download, Pencil, Save, X } from 'lucide-react';
import { useMemo, useState } from 'react';
import { toast } from 'sonner';
import { Button, Empty, Modal, Skeleton } from '../../../components/ui';
import { type EditorIssue, YamlEditor } from '../../../components/yaml-editor';
import { toastError, useClient } from '../../../lib/api';
import { qk } from '../../../lib/queries';
import { diffSpecs, isEmptyBatch, parseSpecObject, type SpecDiff } from '../../../lib/spec-diff';
import type { TabSearch } from '../../../router';
import { useWorkspace } from '../workspace';

export default function SpecTab() {
  const { graph, view } = useWorkspace();
  const client = useClient();
  const qc = useQueryClient();
  const navigate = useNavigate();
  const search = useSearch({ strict: false }) as TabSearch;
  const {
    data: yamlText,
    isLoading,
    error,
  } = useQuery({
    queryKey: qk.spec(graph),
    queryFn: () => client.exportSpec(graph, 'yaml') as Promise<string>,
  });
  const editing = Boolean(search.edit);
  const [draft, setDraft] = useState<string | null>(null);
  const [preview, setPreview] = useState<SpecDiff | null>(null);
  const [busy, setBusy] = useState(false);
  const text = draft ?? yamlText ?? '';
  const validation = useMemo(
    () => (editing && draft !== null ? validateSpecText(draft) : undefined),
    [editing, draft],
  );
  const issues: EditorIssue[] = useMemo(
    () => [
      ...(validation?.errors ?? []).map((i) => ({ ...i, severity: 'error' as const })),
      ...(validation?.warnings ?? []).map((i) => ({ ...i, severity: 'warning' as const })),
    ],
    [validation],
  );

  const setEdit = (on: boolean) => {
    if (!on) setDraft(null);
    void navigate({
      to: '.',
      search: (p) => ({ ...(p as object), edit: on ? true : undefined }),
      replace: true,
    });
  };
  const review = () => {
    if (!yamlText || draft === null) return;
    try {
      const d = diffSpecs(parseSpecObject(yamlText), parseSpecObject(draft));
      if (isEmptyBatch(d.batch)) {
        toast.message('No changes to apply');
        return;
      }
      setPreview(d);
    } catch (e) {
      toastError(e, 'Parse');
    }
  };
  const apply = async () => {
    if (!preview) return;
    setBusy(true);
    try {
      const out = await client.mutate(graph, preview.batch);
      toast.success(`Applied revision ${out.revision}`, {
        description: out.changes.slice(0, 4).join(' · '),
      });
      setPreview(null);
      setEdit(false);
      void qc.invalidateQueries({ queryKey: qk.spec(graph) });
      void qc.invalidateQueries({ queryKey: qk.graph(graph) });
    } catch (e) {
      toastError(e, 'Apply');
    } finally {
      setBusy(false);
    }
  };
  const download = () => {
    const blob = new Blob([yamlText ?? ''], { type: 'text/yaml' });
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = `${view.graph.slug ?? view.graph.id}.yaml`;
    a.click();
    URL.revokeObjectURL(a.href);
  };

  if (error) return <Empty title="Could not export the spec">{(error as Error).message}</Empty>;
  return (
    <div className="page" style={{ display: 'flex', flexDirection: 'column' }}>
      <div
        className="page-in full"
        style={{
          display: 'flex',
          flexDirection: 'column',
          flex: 1,
          minHeight: 0,
          paddingBottom: 16,
        }}
      >
        <div className="page-h" style={{ alignItems: 'center' }}>
          <div>
            <h1 style={{ fontSize: 16 }}>Spec · revision {view.graph.revision}</h1>
            <div className="sub">
              {editing
                ? 'Edit the YAML, then review the operations before applying them as one mutation batch.'
                : 'The canonical spec export of the live graph.'}
            </div>
          </div>
          <div className="right">
            {!editing ? (
              <>
                <Button
                  size="sm"
                  onClick={() =>
                    void navigator.clipboard
                      ?.writeText(yamlText ?? '')
                      .then(() => toast.success('Copied'))
                  }
                >
                  <Copy />
                  Copy
                </Button>
                <Button size="sm" onClick={download}>
                  <Download />
                  Download
                </Button>
                <Button size="sm" variant="primary" onClick={() => setEdit(true)}>
                  <Pencil />
                  Edit as YAML
                </Button>
              </>
            ) : (
              <>
                {validation && (
                  <span className={validation.ok ? 'pill st-done' : 'pill st-failed'}>
                    {validation.ok
                      ? 'Valid'
                      : `${validation.errors.length} error${validation.errors.length === 1 ? '' : 's'}`}
                  </span>
                )}
                <Button size="sm" onClick={() => setEdit(false)}>
                  <X />
                  Cancel
                </Button>
                <Button
                  size="sm"
                  variant="primary"
                  onClick={review}
                  disabled={draft === null || validation?.ok === false}
                >
                  <Save />
                  Review changes
                </Button>
              </>
            )}
          </div>
        </div>
        {isLoading ? (
          <Skeleton style={{ flex: 1 }} />
        ) : (
          <div style={{ flex: 1, minHeight: 360 }}>
            <YamlEditor
              label="Graph spec YAML"
              value={text}
              readOnly={!editing}
              {...(editing ? { onChange: setDraft, issues } : {})}
              height="100%"
            />
          </div>
        )}
      </div>
      <Modal
        open={Boolean(preview)}
        onOpenChange={(o) => !o && setPreview(null)}
        title="Apply these changes?"
        description="Validated as a whole and applied atomically. Running agents receive change directives for edited nodes."
        wide
        footer={
          <>
            <Button onClick={() => setPreview(null)}>Back</Button>
            <Button variant="primary" onClick={apply} disabled={busy}>
              Apply mutation
            </Button>
          </>
        }
      >
        {preview && (
          <div className="col" style={{ gap: 6 }}>
            {preview.changes.map((c) => (
              <div
                key={c}
                className="mono"
                style={{
                  fontSize: 12,
                  color: c.startsWith('-')
                    ? 'var(--s-failed-fg)'
                    : c.startsWith('+')
                      ? 'var(--s-done-fg)'
                      : 'var(--text)',
                }}
              >
                {c}
              </div>
            ))}
            {preview.warnings.map((w) => (
              <div key={w} className="banner st-evaluating">
                {w}
              </div>
            ))}
            <details>
              <summary className="muted" style={{ cursor: 'pointer', fontSize: 12 }}>
                Mutation batch (JSON)
              </summary>
              <pre className="event-json">{JSON.stringify(preview.batch, null, 2)}</pre>
            </details>
          </div>
        )}
      </Modal>
    </div>
  );
}
