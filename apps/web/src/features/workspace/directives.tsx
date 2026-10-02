/**
 * Directives (concepts §11.2, docs/ui.md §7): composer with "requires acknowledgment", and the
 * live round trip pending → delivered → acknowledged with the agent's ack note.
 */
import type { DirectiveBody } from '@agent-graphs/core';
import type { Directive } from '@agent-graphs/sdk';
import { useQueryClient } from '@tanstack/react-query';
import { Check, Clock, Send } from 'lucide-react';
import { useState } from 'react';
import { toast } from 'sonner';
import { AnnotLine } from '../../components/exec-badge';
import { Glyph } from '../../components/status';
import { Button, Modal } from '../../components/ui';
import { toastError, useClient } from '../../lib/api';
import { formatDuration, timeAgo, toMs } from '../../lib/format';
import { qk } from '../../lib/queries';
import { statusMeta } from '../../lib/status';
import { cn } from '../../lib/utils';

export function DirectiveComposer({
  open,
  onOpenChange,
  graph,
  target,
  targetLabel,
}: {
  open: boolean;
  onOpenChange: (o: boolean) => void;
  graph: string;
  target: DirectiveBody['target'];
  targetLabel: string;
}) {
  return (
    <Modal
      open={open}
      onOpenChange={onOpenChange}
      title="Send a directive"
      description={`To ${targetLabel}. Agents see it on their next claim, briefing, or heartbeat.`}
    >
      <DirectiveForm graph={graph} target={target} onSent={() => onOpenChange(false)} />
    </Modal>
  );
}

export function DirectiveForm({
  graph,
  target,
  onSent,
  compact,
}: {
  graph: string;
  target: DirectiveBody['target'];
  onSent?: () => void;
  compact?: boolean;
}) {
  const client = useClient();
  const qc = useQueryClient();
  const [kind, setKind] = useState<DirectiveBody['kind']>('guidance');
  const [title, setTitle] = useState('');
  const [body, setBody] = useState('');
  const [requiresAck, setRequiresAck] = useState(true);
  const [busy, setBusy] = useState(false);
  const send = async () => {
    if (!title.trim()) {
      toast.error('A title is required.');
      return;
    }
    setBusy(true);
    try {
      await client.sendDirective(graph, {
        target,
        kind,
        title: title.trim(),
        ...(body.trim() ? { body: body.trim() } : {}),
        requiresAck,
      });
      toast.success('Directive sent');
      setTitle('');
      setBody('');
      void qc.invalidateQueries({ queryKey: qk.directives(graph) });
      void qc.invalidateQueries({ queryKey: ['node', graph] });
      onSent?.();
    } catch (e) {
      toastError(e, 'Directive');
    } finally {
      setBusy(false);
    }
  };
  return (
    <div className={cn(compact && 'directive-compose')}>
      <div className="grid2">
        <div className="field" style={{ marginTop: 0 }}>
          <label htmlFor="dir-kind">Kind</label>
          <select
            id="dir-kind"
            className="input"
            value={kind}
            onChange={(e) => setKind(e.target.value as DirectiveBody['kind'])}
          >
            <option value="guidance">guidance</option>
            <option value="change">change</option>
            <option value="answer">answer</option>
            <option value="pause">pause</option>
            <option value="resume">resume</option>
            <option value="cancel">cancel</option>
          </select>
        </div>
        <div className="field" style={{ marginTop: 0, justifyContent: 'flex-end' }}>
          <label className="check" style={{ height: 32 }}>
            <input
              type="checkbox"
              checked={requiresAck}
              onChange={(e) => setRequiresAck(e.target.checked)}
            />
            Requires acknowledgment
          </label>
        </div>
      </div>
      <div className="field">
        <label htmlFor="dir-title">Title</label>
        <input
          id="dir-title"
          className="input"
          value={title}
          onChange={(e) => setTitle(e.target.value)}
          placeholder="Prefer httpOnly cookies for sessions"
        />
      </div>
      <div className="field">
        <label htmlFor="dir-body">
          Details <span className="muted">(markdown, optional)</span>
        </label>
        <textarea
          id="dir-body"
          className="textarea prose"
          value={body}
          onChange={(e) => setBody(e.target.value)}
        />
      </div>
      <div className="row" style={{ justifyContent: 'flex-end', marginTop: 12 }}>
        <Button variant="primary" onClick={send} disabled={busy}>
          <Send />
          Send directive
        </Button>
      </div>
    </div>
  );
}

/** pending → delivered → acknowledged chip. */
export function DirectiveStatusChip({ status }: { status: string }) {
  const m = statusMeta(status);
  const Icon = status === 'acknowledged' ? Check : status === 'pending' ? Clock : undefined;
  return (
    <span className={cn('dir-chip', m.cls)} data-testid="directive-status">
      {Icon ? <Icon /> : <Glyph name={m.icon} />}
      {m.label.toLowerCase()}
    </span>
  );
}

/** One directive with its delivery and acknowledgment trail. */
export function DirectiveRow({ d }: { d: Directive }) {
  const deliveries = d.deliveries ?? (d.delivery ? [d.delivery] : []);
  const created = toMs(d.createdAt) ?? 0;
  return (
    <div className="directive-state" data-directive={d.id}>
      <div className="col grow" style={{ gap: 4 }}>
        <div className="row" style={{ gap: 6, flexWrap: 'wrap' }}>
          <span className="tag">{d.kind}</span>
          <b className="ellipsis">{d.title}</b>
          <span style={{ marginLeft: 'auto' }}>
            <DirectiveStatusChip status={d.status} />
          </span>
        </div>
        {d.body && <div style={{ color: 'var(--text-2)' }}>{d.body}</div>}
        <div className="steps-track">
          <span className="on">sent {timeAgo(d.createdAt)}</span>
          <span>→</span>
          <span className={cn((d.status === 'delivered' || d.status === 'acknowledged') && 'on')}>
            delivered
          </span>
          {d.requiresAck && (
            <>
              <span>→</span>
              <span className={cn(d.status === 'acknowledged' && 'on')}>acknowledged</span>
            </>
          )}
          <span className="sep">·</span>
          <AnnotLine x={d.createdBy} />
        </div>
        {deliveries.map((x) => (
          <div
            key={`${x.recipient}-${x.deliveredAt}`}
            className="row"
            style={{ gap: 6, fontSize: 11.5, flexWrap: 'wrap' }}
          >
            <span className="muted">
              Delivered via {x.deliveredVia} to <span className="mono">{x.recipient}</span>{' '}
              {formatDuration((toMs(x.deliveredAt) ?? created) - created)} later
            </span>
            {x.ackedAt && (
              <span className="ack">
                <Check />
                acknowledged{x.ackNote ? `: “${x.ackNote}”` : ''}
              </span>
            )}
          </div>
        ))}
      </div>
    </div>
  );
}
