/** Concise markdown renderers shared by MCP tool results and the CLI's human output. */
import type {
  ClaimResult,
  Directive,
  DutyItem,
  GraphSummary,
  HeartbeatResult,
  HumanRequest,
  NextResult,
  SubmitResult,
} from '@agent-graphs/sdk';

export function graphLine(g: GraphSummary): string {
  const counts = Object.entries(g.counts)
    .filter(([, n]) => (n ?? 0) > 0)
    .map(([s, n]) => `${s} ${n}`)
    .join(', ');
  const flags = [
    g.stalled ? 'stalled' : '',
    g.pendingApproval ? 'awaiting plan approval' : '',
    g.openRequests ? `${g.openRequests} open request(s)` : '',
  ].filter(Boolean);
  return `- **${g.slug ?? g.id}** · ${g.title} · ${g.status} · ${Math.round(g.progress * 100)}% (${counts || 'no nodes'})${flags.length ? ` · ${flags.join(' · ')}` : ''}`;
}

export function directiveLines(directives: Directive[], attemptId?: string): string[] {
  return directives.map((d) => {
    const ack = d.requiresAck
      ? ` → apply it, then directive_ack {directiveId: "${d.id}"${attemptId ? `, attemptId: "${attemptId}"` : ''}, note}`
      : '';
    return `- ${d.id} · ${d.kind} · **${d.title}**${d.body ? `: ${d.body}` : ''}${ack}`;
  });
}

export function claimText(
  r: ClaimResult & { node?: NextResult['node'] },
  options: { nodeKey?: string; dispatched?: boolean } = {},
): string {
  const key = r.node?.key ?? options.nodeKey ?? '';
  const lines = [
    `Claimed **${key}** · attempt \`${r.attempt.id}\` (#${r.attempt.number}) · lease until ${r.lease.expiresAt} · heartbeat every ≤${Math.round(r.lease.heartbeatEvery / 60)}m`,
  ];
  if (r.directives.length) {
    lines.push('', '**Directives (authoritative; they override the prompt):**');
    lines.push(...directiveLines(r.directives, r.attempt.id));
  }
  if (typeof r.briefing === 'string') lines.push('', r.briefing);
  if (options.dispatched) {
    lines.push(
      '',
      '**Dispatch:** spawn a subagent whose prompt contains the briefing above plus:',
      `> You are executing Agent Graphs attempt \`${r.attempt.id}\`. Report with the agent-graphs tools using attemptId \`${r.attempt.id}\` (attempt_heartbeat, note_add, metrics_report). Finish with attempt_submit (or attempt_fail / attempt_block / attempt_release) before you stop.`,
      'When it returns, check the attempt state; relay results with note_add and submit on its behalf if it did not.',
    );
  } else {
    lines.push(
      '',
      `Next: do the work · attempt_heartbeat {attemptId: "${r.attempt.id}", progress, step} at least every 5 minutes · note_add / metrics_report as you go · finish with attempt_submit (or attempt_fail / attempt_block / attempt_release).`,
    );
  }
  return lines.join('\n');
}

export function nothingReadyText(r: NextResult): string {
  const lines = [`No ready node (${r.reason ?? 'none'}).`];
  if (r.running?.length)
    lines.push(
      `Running: ${r.running.map((x) => `${x.key} (${x.holder || 'agent'}, ${x.progress}%)`).join(', ')}`,
    );
  if (r.needsInput?.length) lines.push(`Needs input: ${r.needsInput.join(', ')}`);
  if (r.blocked?.length) lines.push(`Blocked: ${r.blocked.join(', ')}`);
  if (r.suggestion) lines.push(r.suggestion);
  return lines.join('\n');
}

export function heartbeatText(r: HeartbeatResult, attemptId?: string): string {
  const lines = [`Lease renewed until ${r.leaseExpiresAt}.`];
  if (r.directives.length) {
    lines.push('**New directives (authoritative):**', ...directiveLines(r.directives, attemptId));
  }
  if (r.briefingChanged)
    lines.push('The configuration changed: re-fetch the briefing with node_briefing {attemptId}.');
  if (r.pauseRequested)
    lines.push(
      'Pause requested: checkpoint, write a handoff note, then attempt_release {attemptId, reason, handoff}.',
    );
  if (r.cancelRequested)
    lines.push('Cancel requested: stop work, write a handoff note, then attempt_release.');
  return lines.join('\n');
}

export function submitText(r: SubmitResult): string {
  const lines = [
    `Outcome: **${r.outcome}** · attempt ${r.attempt.id} is ${r.attempt.status} · node ${r.node.key} is ${r.node.status}.`,
    r.next,
  ];
  if (r.lessonDuty)
    lines.push(`Lesson duty ${r.lessonDuty.id}: ${r.lessonDuty.ask} (lesson_add with dutyId).`);
  return lines.join('\n');
}

export function requestLine(r: HumanRequest): string {
  const graph = r.graph ? `${r.graph.slug ?? r.graph.id} · ` : '';
  const options = r.options.map((o) => o.id).join(' | ');
  return `- \`${r.id}\` · ${graph}${r.kind}/${r.subject} · **${r.title}** · assignee ${r.assignee}${r.blocking ? ' · blocking' : ''} · options: ${options}`;
}

export function dutyLine(d: DutyItem): string {
  const ids = [
    d.nodeKey ? `node ${d.nodeKey}` : '',
    d.attemptId ? `attempt ${d.attemptId}` : '',
    d.requestId ? `request ${d.requestId}` : '',
    d.aimKey ? `aim ${d.aimKey}` : '',
  ]
    .filter(Boolean)
    .join(' · ');
  return `- ${d.kind} · ${d.title}${ids ? ` (${ids})` : ''} → ${d.hint}`;
}
