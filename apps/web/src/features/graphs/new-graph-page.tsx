/**
 * New graph (docs/ui.md §4.7): YAML on the left with live validation (POST /graphs/validate),
 * inline markers and hints; a live canvas preview on the right; Validate · Create draft ·
 * Create & start.
 */
import type { ValidationOutput } from '@agent-graphs/sdk';
import { useQueryClient } from '@tanstack/react-query';
import { useNavigate } from '@tanstack/react-router';
import { CircleAlert, FileUp, Play, Save, ShieldCheck, TriangleAlert } from 'lucide-react';
import { useEffect, useMemo, useRef, useState } from 'react';
import { toast } from 'sonner';
import { Button, Empty } from '../../components/ui';
import { type EditorIssue, YamlEditor } from '../../components/yaml-editor';
import { toastError, useClient } from '../../lib/api';
import { specToPreviewView } from '../../lib/preview';
import { cn } from '../../lib/utils';
import { GraphCanvas } from '../workspace/canvas/graph-canvas';

export const STARTER = `schema: agent-graphs/v1
title: My first graph
slug: my-first-graph
description: A small plan for an agent-orchestrated build.

aims:
  - All nodes complete

nodes:
  - key: plan
    title: Plan the work
    aim: A short written plan with acceptance criteria
    prompt: Write docs/plan.md with the steps and how each is verified.
    aims:
      - The plan is concrete and testable

  - key: build
    title: Build it
    aim: The feature works and its tests pass
    needs: [plan]
    prompt: Implement the plan. Report test_pass_rate when you submit.
    aims:
      - check: "test_pass_rate >= 1"

  - key: review
    title: Review
    kind: gate
    aim: A human approves the result
    needs: [build]
    gate:
      approver: human

loops:
  - key: fix-cycle
    from: review
    to: build
    maxIterations: 3
`;

export default function NewGraphPage() {
  const client = useClient();
  const qc = useQueryClient();
  const navigate = useNavigate();
  const [text, setText] = useState(STARTER);
  const [result, setResult] = useState<ValidationOutput | null>(null);
  const [validating, setValidating] = useState(false);
  const [busy, setBusy] = useState(false);
  const fileRef = useRef<HTMLInputElement>(null);
  const reqId = useRef(0);

  const validate = async (spec: string) => {
    const id = ++reqId.current;
    setValidating(true);
    try {
      const out = await client.validateSpec(spec);
      if (id === reqId.current) setResult(out);
    } catch (e) {
      if (id === reqId.current) toastError(e, 'Validate');
    } finally {
      if (id === reqId.current) setValidating(false);
    }
  };
  // biome-ignore lint/correctness/useExhaustiveDependencies: debounced on text changes only
  useEffect(() => {
    const t = setTimeout(() => void validate(text), 400);
    return () => clearTimeout(t);
  }, [text]);

  const issues: EditorIssue[] = useMemo(
    () => [
      ...(result?.errors ?? []).map((i) => ({ ...i, severity: 'error' as const })),
      ...(result?.warnings ?? []).map((i) => ({ ...i, severity: 'warning' as const })),
    ],
    [result],
  );
  const preview = useMemo(
    () => (result?.normalized ? specToPreviewView(result.normalized) : null),
    [result],
  );

  const create = async (start: boolean) => {
    setBusy(true);
    try {
      const out = await client.createGraph(text, { start });
      toast.success(
        start
          ? out.started
            ? 'Graph created and started'
            : 'Graph created — plan approval requested'
          : 'Draft created',
      );
      void qc.invalidateQueries({ queryKey: ['graphs'] });
      void navigate({ to: '/graphs/$graph', params: { graph: out.graph.slug ?? out.graph.id } });
    } catch (e) {
      toastError(e, 'Create');
    } finally {
      setBusy(false);
    }
  };

  const onFile = async (file: File | undefined) => {
    if (!file) return;
    setText(await file.text());
    toast.success(`Loaded ${file.name}`);
  };

  return (
    <section
      className="view on"
      aria-label="New graph"
      style={{ flexDirection: 'column', minHeight: 0 }}
    >
      <div className="gh" style={{ paddingBottom: 12 }}>
        <div className="gh-row1">
          <h1 className="gh-title">New graph</h1>
          <span className="gh-meta">
            Paste or upload a spec (YAML or JSON). It is validated as you type.
          </span>
          <div className="gh-actions">
            <input
              ref={fileRef}
              type="file"
              accept=".yaml,.yml,.json,text/yaml,application/json"
              hidden
              onChange={(e) => void onFile(e.target.files?.[0])}
            />
            <Button size="sm" onClick={() => fileRef.current?.click()}>
              <FileUp />
              Upload
            </Button>
            <Button size="sm" onClick={() => void validate(text)} disabled={validating}>
              <ShieldCheck />
              Validate
            </Button>
            <Button size="sm" onClick={() => void create(false)} disabled={busy || !result?.ok}>
              <Save />
              Create draft
            </Button>
            <Button
              size="sm"
              variant="primary"
              onClick={() => void create(true)}
              disabled={busy || !result?.ok}
            >
              <Play />
              Create & start
            </Button>
          </div>
        </div>
      </div>
      <div className="gw-body" style={{ minHeight: 0 }}>
        <div
          className="col"
          style={{
            width: '46%',
            minWidth: 420,
            borderRight: '1px solid var(--line)',
            minHeight: 0,
          }}
        >
          {/* biome-ignore lint/a11y/noStaticElementInteractions: drop target for spec files */}
          <div
            style={{ flex: 1, minHeight: 0, padding: 12 }}
            onDragOver={(e) => e.preventDefault()}
            onDrop={(e) => {
              e.preventDefault();
              void onFile(e.dataTransfer.files[0]);
            }}
          >
            <YamlEditor
              label="Graph spec YAML"
              value={text}
              onChange={setText}
              issues={issues}
              height="100%"
            />
          </div>
          <div
            style={{ maxHeight: 220, overflow: 'auto', borderTop: '1px solid var(--line)' }}
            aria-live="polite"
            data-testid="validation"
          >
            <div className="row" style={{ padding: '8px 12px', gap: 8 }}>
              <span
                className={cn(
                  'pill',
                  result?.ok ? 'st-done' : result ? 'st-failed' : 'st-pending',
                  result && !result.ok && 'solid',
                )}
              >
                {result
                  ? result.ok
                    ? 'Valid spec'
                    : `${result.errors.length} error${result.errors.length === 1 ? '' : 's'}`
                  : 'Validating…'}
              </span>
              {result && result.warnings.length > 0 && (
                <span className="pill st-evaluating">
                  {result.warnings.length} warning{result.warnings.length === 1 ? '' : 's'}
                </span>
              )}
              {result?.stats && (
                <span className="muted" style={{ fontSize: 12 }}>
                  {Object.entries(result.stats)
                    .map(([k, v]) => `${v} ${k}`)
                    .join(' · ')}
                </span>
              )}
            </div>
            {issues.map((i) => (
              <div
                key={`${i.severity}-${i.path}-${i.message}`}
                className={cn('issue', i.severity === 'error' ? 'st-failed' : 'st-evaluating')}
              >
                {i.severity === 'error' ? <CircleAlert /> : <TriangleAlert />}
                <div>
                  <div>{i.message}</div>
                  {i.path && <div className="path">{i.path}</div>}
                  {i.hint && <div className="hint">Hint: {i.hint}</div>}
                </div>
              </div>
            ))}
          </div>
        </div>
        <div className="subview on" style={{ flexDirection: 'column' }}>
          {preview ? (
            <GraphCanvas
              view={preview}
              graph="preview"
              search={{}}
              showLane={preview.orchestrators.length > 0}
            />
          ) : (
            <Empty title="Preview">A valid spec renders here as a canvas.</Empty>
          )}
        </div>
      </div>
    </section>
  );
}
