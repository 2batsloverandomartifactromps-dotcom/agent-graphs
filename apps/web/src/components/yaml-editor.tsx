/**
 * CodeMirror YAML editor with inline validation markers mapped from issue paths
 * (docs/ui.md §4.7) and keyword completion for spec fields.
 */
import { autocompletion, type CompletionContext } from '@codemirror/autocomplete';
import { yaml } from '@codemirror/lang-yaml';
import { type Diagnostic, linter, lintGutter } from '@codemirror/lint';
import { EditorView } from '@codemirror/view';
import CodeMirror from '@uiw/react-codemirror';
import { useMemo } from 'react';
import { resolvedTheme, useSettings } from '../lib/settings';
import { rangeOf } from '../lib/yaml-range';

export type EditorIssue = {
  path: string;
  message: string;
  hint?: string;
  severity: 'error' | 'warning';
};

const SPEC_KEYS = [
  'schema',
  'title',
  'slug',
  'description',
  'tags',
  'repository',
  'context',
  'constraints',
  'aims',
  'policy',
  'defaults',
  'evolution',
  'orchestrators',
  'nodes',
  'loops',
  'key',
  'kind',
  'aim',
  'purpose',
  'prompt',
  'deliverables',
  'checklist',
  'needs',
  'informedBy',
  'aimMode',
  'priority',
  'executor',
  'maxAttempts',
  'onExhausted',
  'leaseTtl',
  'timeout',
  'gate',
  'approver',
  'instructions',
  'metric',
  'comparator',
  'target',
  'unit',
  'source',
  'evaluator',
  'evaluatorKey',
  'criteria',
  'terminating',
  'guard',
  'check',
  'from',
  'to',
  'maxIterations',
  'feedback',
  'role',
  'scope',
  'capabilities',
  'triggers',
  'model',
  'thinking',
  'provider',
  'mechanism',
  'requires',
  'relation',
  'condition',
  'guidance',
  'pitfalls',
  'requirePlanApproval',
  'maxParallel',
  'mutations',
];

const VALUES: Record<string, string[]> = {
  kind: ['task', 'gate', 'milestone', 'qualitative', 'quantitative'],
  priority: ['p0', 'p1', 'p2', 'p3'],
  onExhausted: ['escalate', 'fail', 'skip', 'accept'],
  evaluator: ['self', 'agent', 'orchestrator', 'human'],
  comparator: ['gte', 'gt', 'lte', 'lt', 'eq', 'neq', 'between'],
  thinking: ['off', 'low', 'medium', 'high', 'xhigh', 'max'],
  role: ['lead', 'reviewer', 'integrator', 'monitor', 'evolver', 'custom'],
  approver: ['human', 'orchestrator'],
  aimMode: ['all', 'any'],
  mutations: ['locked', 'append', 'open'],
  relation: ['leads_to', 'triggers', 'provides_input_for', 'converges_to'],
};

function complete(ctx: CompletionContext) {
  const line = ctx.state.doc.lineAt(ctx.pos);
  const before = line.text.slice(0, ctx.pos - line.from);
  const valueMatch = /^\s*-?\s*([A-Za-z]+):\s*(\w*)$/.exec(before);
  if (valueMatch && VALUES[valueMatch[1] as string]) {
    const word = valueMatch[2] ?? '';
    return {
      from: ctx.pos - word.length,
      options: (VALUES[valueMatch[1] as string] as string[]).map((v) => ({
        label: v,
        type: 'enum',
      })),
    };
  }
  const keyMatch = /^\s*-?\s*(\w*)$/.exec(before);
  if (!keyMatch) return null;
  const word = keyMatch[1] ?? '';
  if (!word && !ctx.explicit) return null;
  return {
    from: ctx.pos - word.length,
    options: SPEC_KEYS.map((k) => ({ label: k, type: 'property', apply: `${k}: ` })),
  };
}

export function YamlEditor({
  value,
  onChange,
  issues,
  readOnly,
  height = '100%',
  label,
}: {
  value: string;
  onChange?: (v: string) => void;
  issues?: EditorIssue[];
  readOnly?: boolean;
  height?: string;
  label: string;
}) {
  const theme = resolvedTheme(useSettings((s) => s.theme));
  const extensions = useMemo(() => {
    const exts = [
      yaml(),
      EditorView.lineWrapping,
      EditorView.contentAttributes.of({ 'aria-label': label }),
      autocompletion({ override: [complete] }),
    ];
    if (issues) {
      exts.push(
        lintGutter(),
        linter(
          (view) =>
            issues.map((i): Diagnostic => {
              const r = rangeOf(view.state.doc.toString(), i.path);
              return {
                from: Math.min(r.from, view.state.doc.length),
                to: Math.min(r.to, view.state.doc.length),
                severity: i.severity,
                message: i.hint ? `${i.message}\nHint: ${i.hint}` : i.message,
              };
            }),
          { delay: 100 },
        ),
      );
    }
    return exts;
  }, [issues, label]);
  return (
    <div className="cm-host" style={{ height }}>
      <CodeMirror
        value={value}
        height={height}
        theme={theme}
        readOnly={readOnly}
        editable={!readOnly}
        extensions={extensions}
        basicSetup={{ lineNumbers: true, foldGutter: true, highlightActiveLine: !readOnly }}
        {...(onChange ? { onChange } : {})}
      />
    </div>
  );
}
