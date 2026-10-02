/**
 * Inbox resolution UX over the option catalog (docs/concepts.md §11.1): which fields each option
 * needs, its one-line consequence, and how the form values become a `ResolveBody`.
 */
import type { ResolveBody } from '@agent-graphs/core';

export type FieldKind =
  | 'int'
  | 'number'
  | 'text'
  | 'longtext'
  | 'duration'
  | 'aimKey'
  | 'nodeKey'
  | 'prompt';

export type OptionField = {
  name: string;
  label: string;
  kind: FieldKind;
  required: boolean;
  default?: string;
  placeholder?: string;
  /** Where the value goes: `data.<name>` (default) or the resolution `comment`. */
  target?: 'data' | 'comment';
};

export type OptionSpec = {
  /** Short label override (the server option label is used otherwise). */
  label?: string;
  consequence: string;
  fields: OptionField[];
  /** The resolution needs a comment (for example rejecting an approval). */
  commentRequired?: boolean;
  /** Destructive choices are styled as such and confirm the reason. */
  destructive?: boolean;
  /** Approval-style primary/secondary buttons instead of a radio list. */
  tone?: 'approve' | 'reject';
};

const reason = (label = 'Reason'): OptionField => ({
  name: 'reason',
  label,
  kind: 'text',
  required: true,
  placeholder: 'Stored in the event log',
});
const justification: OptionField = {
  name: 'justification',
  label: 'Justification',
  kind: 'text',
  required: true,
  placeholder: 'Why this is acceptable',
};
const comment = (required: boolean, label = 'Comment'): OptionField => ({
  name: 'comment',
  label,
  kind: 'longtext',
  required,
  target: 'comment',
});

const CATALOG: Record<string, Record<string, OptionSpec>> = {
  gate: {
    approve: {
      consequence: 'The gate completes; dependants become ready.',
      fields: [comment(false)],
      tone: 'approve',
    },
    reject: {
      label: 'Request changes',
      consequence: 'The gate fails; its loop fires with your comment as feedback.',
      fields: [comment(true, 'What should change')],
      commentRequired: true,
      tone: 'reject',
    },
  },
  aim: {
    approve: {
      label: 'Met',
      consequence: 'Records a met verdict for this aim.',
      fields: [comment(false, 'Rationale')],
      tone: 'approve',
    },
    partial: {
      label: 'Partial',
      consequence: 'Records a partial verdict (counts as unmet for completion).',
      fields: [comment(false, 'Rationale')],
    },
    reject: {
      label: 'Unmet',
      consequence: 'Records an unmet verdict; the attempt fails and may retry.',
      fields: [comment(true, 'Rationale')],
      commentRequired: true,
      tone: 'reject',
    },
  },
  plan: {
    approve: { consequence: 'The graph starts.', fields: [comment(false)], tone: 'approve' },
    reject: {
      consequence: 'The graph stays a draft; your comment becomes a guidance directive.',
      fields: [comment(true)],
      commentRequired: true,
      tone: 'reject',
    },
  },
  proposal: {
    approve: {
      consequence: 'The proposal is committed.',
      fields: [comment(false)],
      tone: 'approve',
    },
    reject: {
      consequence: 'The proposal is rejected into the rejection memory.',
      fields: [comment(true)],
      commentRequired: true,
      tone: 'reject',
    },
  },
  question: {
    answer: {
      consequence: 'Sends an answer directive to the asking agent.',
      fields: [{ name: 'text', label: 'Answer', kind: 'longtext', required: true }],
    },
  },
  exhaustion: {
    retry: {
      consequence: 'Grants more attempts; the node returns to ready with feedback.',
      fields: [
        {
          name: 'extraAttempts',
          label: 'Extra attempts',
          kind: 'int',
          required: true,
          default: '2',
        },
      ],
    },
    edit_retry: {
      consequence: 'Change the prompt first, then start a fresh attempt.',
      fields: [
        { name: 'prompt', label: 'New prompt', kind: 'prompt', required: true },
        {
          name: 'extraAttempts',
          label: 'Extra attempts',
          kind: 'int',
          required: false,
          default: '1',
        },
      ],
    },
    accept: {
      consequence: 'Marks the node done with a recorded deviation.',
      fields: [justification],
    },
    skip: {
      consequence: 'Skips the node; dependants proceed without it.',
      fields: [reason()],
      destructive: true,
    },
    fail: {
      consequence: 'Fails the node; the graph may stall.',
      fields: [reason()],
      destructive: true,
    },
  },
  loop: {
    extend: {
      consequence: 'Grants more iterations and fires the loop immediately.',
      fields: [
        {
          name: 'extraIterations',
          label: 'Extra iterations',
          kind: 'int',
          required: true,
          default: '1',
        },
      ],
    },
    edit_retry: {
      consequence: 'Edit the loop entry, then run another iteration.',
      fields: [
        { name: 'prompt', label: 'New prompt for the entry node', kind: 'prompt', required: true },
        {
          name: 'extraIterations',
          label: 'Extra iterations',
          kind: 'int',
          required: false,
          default: '1',
        },
      ],
    },
    accept: {
      consequence: 'Accepts the trigger as done with a deviation.',
      fields: [comment(false, 'Justification')],
    },
    fail: {
      consequence: 'Fails the trigger node.',
      fields: [comment(false, 'Reason')],
      destructive: true,
    },
  },
  guard: {
    raise_target: {
      consequence: 'Raises the guard target (human only); the graph resumes.',
      fields: [{ name: 'target', label: 'New target', kind: 'number', required: true }],
    },
    waive: { consequence: 'Waives the guard; the graph resumes.', fields: [justification] },
    fail: {
      consequence: 'Fails the graph.',
      fields: [comment(false, 'Reason')],
      destructive: true,
    },
  },
  stall: {
    retry: {
      consequence: 'Grants attempts to the blocking node.',
      fields: [
        { name: 'nodeKey', label: 'Node', kind: 'nodeKey', required: false },
        {
          name: 'extraAttempts',
          label: 'Extra attempts',
          kind: 'int',
          required: false,
          default: '1',
        },
      ],
    },
    skip: {
      consequence: 'Skips the blocking node.',
      fields: [{ name: 'nodeKey', label: 'Node', kind: 'nodeKey', required: false }, reason()],
      destructive: true,
    },
    fail: {
      consequence: 'Fails the blocking node.',
      fields: [{ name: 'nodeKey', label: 'Node', kind: 'nodeKey', required: false }, reason()],
      destructive: true,
    },
    fail_graph: {
      consequence: 'Fails the whole graph.',
      fields: [comment(false, 'Reason')],
      destructive: true,
    },
  },
  verification: {
    add_work: {
      consequence: 'Returns the graph to active so work can be added.',
      fields: [comment(false)],
    },
    waive: {
      consequence: 'Waives one graph aim with a justification.',
      fields: [{ name: 'aimKey', label: 'Aim', kind: 'aimKey', required: true }, justification],
    },
    accept: {
      consequence: 'Completes the graph with a recorded deviation.',
      fields: [justification],
    },
    fail: {
      consequence: 'Fails the graph.',
      fields: [comment(false, 'Reason')],
      destructive: true,
    },
  },
  timeout: {
    extend: {
      consequence: 'Extends the attempt timeout.',
      fields: [
        { name: 'duration', label: 'Extend by', kind: 'duration', required: true, default: '30m' },
      ],
    },
    fail_attempt: {
      consequence: 'Fails the attempt (counted as errored).',
      fields: [comment(false, 'Reason')],
      destructive: true,
    },
    ignore: { consequence: 'Lets the attempt keep running.', fields: [] },
  },
  milestone: {
    waive: {
      consequence: 'Waives the unmet milestone aim.',
      fields: [{ name: 'aimKey', label: 'Aim', kind: 'aimKey', required: true }, justification],
    },
    add_work: { consequence: 'Returns the milestone to pending so work can be added.', fields: [] },
    fail: {
      consequence: 'Fails the milestone.',
      fields: [comment(false, 'Reason')],
      destructive: true,
    },
  },
  blocker: {
    unblock: {
      label: 'Provide info & unblock',
      consequence: 'Sends your info as an answer directive; the node returns to ready.',
      fields: [{ name: 'info', label: 'Info for the agent', kind: 'longtext', required: true }],
    },
    skip: {
      label: 'Skip with reason',
      consequence: 'Skips the node.',
      fields: [reason()],
      destructive: true,
    },
    fail: { consequence: 'Fails the node.', fields: [reason()], destructive: true },
  },
};

/** Options for a request: the server's option list, enriched with catalog UX. */
export function requestOptions(
  subject: string,
  serverOptions: Array<{ id: string; label: string; description?: string }>,
): Array<{ id: string; label: string } & OptionSpec> {
  const catalog = CATALOG[subject] ?? {};
  const ids = serverOptions.map((o) => o.id);
  // Human-judged aims offer a partial verdict through `approve` with data.verdict.
  if (subject === 'aim' && ids.includes('approve') && !ids.includes('partial')) {
    const at = ids.indexOf('approve') + 1;
    serverOptions = [
      ...serverOptions.slice(0, at),
      { id: 'partial', label: 'Partial' },
      ...serverOptions.slice(at),
    ];
  }
  return serverOptions.map((o) => {
    const spec = catalog[o.id];
    return {
      id: o.id,
      ...(spec ?? { consequence: o.description ?? '', fields: [] }),
      label: spec?.label ?? o.label,
    };
  });
}

export function optionSpec(subject: string, choice: string): OptionSpec | undefined {
  return CATALOG[subject]?.[choice];
}

/** Approval-like requests render Approve / Request-changes buttons instead of a radio list. */
export function isApprovalStyle(kind: string, subject: string): boolean {
  return kind === 'approval' || subject === 'gate' || subject === 'plan';
}

export type BuildResult = { ok: true; body: ResolveBody } | { ok: false; error: string };

/**
 * Turn form values into the resolution body for `choice`, validating required fields and the
 * `data` types of the option catalog.
 */
export function buildResolution(
  subject: string,
  choice: string,
  values: Record<string, string | undefined>,
): BuildResult {
  const spec = optionSpec(subject, choice);
  const data: Record<string, unknown> = {};
  let commentText: string | undefined;
  const fields = spec?.fields ?? [];
  for (const f of fields) {
    const raw = (values[f.name] ?? f.default ?? '').trim();
    if (!raw) {
      if (f.required) return { ok: false, error: `${f.label} is required.` };
      continue;
    }
    if (f.target === 'comment') {
      commentText = raw;
      continue;
    }
    switch (f.kind) {
      case 'int': {
        const n = Number(raw);
        if (!Number.isInteger(n) || n < 1)
          return { ok: false, error: `${f.label} must be a whole number ≥ 1.` };
        data[f.name] = n;
        break;
      }
      case 'number': {
        const n = Number(raw);
        if (!Number.isFinite(n)) return { ok: false, error: `${f.label} must be a number.` };
        data[f.name] = n;
        break;
      }
      case 'duration':
        if (!/^\d+(s|m|h|d)$/.test(raw) && !/^\d+$/.test(raw))
          return { ok: false, error: `${f.label} must look like 30m, 2h or 1d.` };
        data[f.name] = /^\d+$/.test(raw) ? Number(raw) : raw;
        break;
      case 'prompt':
        data.patch = { ...((data.patch as object) ?? {}), prompt: raw };
        break;
      default:
        data[f.name] = raw;
    }
  }
  if (spec?.commentRequired && !commentText) return { ok: false, error: 'A comment is required.' };
  // A partial verdict is an approval with data.verdict (concepts §11.1, approval · aim).
  let finalChoice = choice;
  if (subject === 'aim' && choice === 'partial') {
    finalChoice = 'approve';
    data.verdict = 'partial';
  } else if (subject === 'aim' && choice === 'approve') {
    data.verdict = 'met';
  }
  // Free-text reasons double as the comment so the event log shows them.
  if (!commentText) {
    const text = (data.reason ?? data.justification ?? data.info ?? data.text) as
      | string
      | undefined;
    if (typeof text === 'string') commentText = text;
  }
  const body: ResolveBody = { choice: finalChoice };
  if (commentText) body.comment = commentText;
  if (Object.keys(data).length) body.data = data;
  return { ok: true, body };
}
