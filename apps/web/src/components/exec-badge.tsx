/**
 * Execution annotation badges (docs/ui.md §6.3, §6.6): provider-tinted monogram, friendly
 * model name, a 0–5 bar thinking meter, and the delivery-mechanism icon. Tooltips carry the
 * full annotation.
 */
import type { Annotation } from '@agent-graphs/sdk';
import {
  Braces,
  Cloud,
  CodeXml,
  Cog,
  MousePointer2,
  Plug,
  SquareTerminal,
  User,
  Workflow,
} from 'lucide-react';
import { formatTokens, formatUsd, totalTokens } from '../lib/format';
import { useVocab } from '../lib/queries';
import { cn } from '../lib/utils';
import {
  type MechIcon,
  mechanismIcon,
  mechanismName,
  modelInfo,
  providerClass,
  thinkingBars,
} from '../lib/vocab';

export type ExecLike = Partial<Annotation> & {
  usage?: { inputTokens?: number; outputTokens?: number; costUsd?: number };
};

const MECH: Record<MechIcon, typeof SquareTerminal> = {
  terminal: SquareTerminal,
  cloud: Cloud,
  braces: Braces,
  code: CodeXml,
  plug: Plug,
  user: User,
  workflow: Workflow,
  cursor: MousePointer2,
  gear: Cog,
};

export function MechanismIcon({
  mechanism,
  kind,
  size = 12,
}: {
  mechanism?: string;
  kind?: string;
  size?: number;
}) {
  const Icon = MECH[mechanismIcon(mechanism, kind)];
  return <Icon size={size} aria-hidden="true" />;
}

export function ThinkMeter({ level }: { level?: string }) {
  const n = thinkingBars(level);
  return (
    <span
      className={cn('think', level === 'max' && 't-max')}
      role="img"
      aria-label={`thinking: ${level ?? 'off'}`}
    >
      {[1, 2, 3, 4, 5].map((i) => (
        <i key={i} className={i <= n ? 'on' : ''} />
      ))}
    </span>
  );
}

function isHuman(x: ExecLike) {
  return x.kind === 'human' || x.provider === 'human';
}

export function MonoTile({ x }: { x: ExecLike }) {
  const { data: vocab } = useVocab();
  if (isHuman(x))
    return (
      <span className="mono-tile prov-human person" role="img" aria-label="Human">
        <User size={11} strokeWidth={2.2} />
      </span>
    );
  if (x.kind === 'system')
    return (
      <span className="mono-tile prov-neutral" role="img" aria-label="System">
        <Cog size={11} strokeWidth={2.2} />
      </span>
    );
  const m = modelInfo(x.model, x.provider, vocab);
  return <span className={cn('mono-tile', providerClass(m.provider))}>{m.monogram}</span>;
}

export function annotationTitle(x: ExecLike, vocabName?: string): string {
  const parts = [
    x.agent,
    x.role,
    vocabName ?? x.model,
    x.thinking ? `thinking ${x.thinking}` : undefined,
    x.provider,
    x.mechanism ? mechanismName(x.mechanism) : undefined,
    x.sessionId ? `session ${x.sessionId}` : undefined,
    x.usage?.costUsd !== undefined ? formatUsd(x.usage.costUsd) : undefined,
    x.usage ? formatTokens(totalTokens(x.usage)) : undefined,
  ].filter(Boolean);
  return parts.join(' · ');
}

/** Bordered 22 px chip: [O Opus 5.5 ▮▮▮▯▯ ⌘]. */
export function ExecBadge({
  x,
  plain,
  noMech,
  noThink,
  mismatch,
  className,
}: {
  x: ExecLike;
  plain?: boolean;
  noMech?: boolean;
  noThink?: boolean;
  mismatch?: string;
  className?: string;
}) {
  const { data: vocab } = useVocab();
  const human = isHuman(x);
  const m = modelInfo(x.model, human ? 'human' : x.provider, vocab);
  const name = human ? (x.agent ?? 'Human') : x.kind === 'system' ? (x.agent ?? 'System') : m.name;
  return (
    <span
      className={cn(
        'exec',
        providerClass(human ? 'human' : m.provider),
        plain && 'plain',
        className,
      )}
      title={`${annotationTitle(x, m.name)}${mismatch ? `\n${mismatch}` : ''}`}
    >
      <MonoTile x={x} />
      <span className="mname">{name}</span>
      {!human && !noThink && x.kind !== 'system' && <ThinkMeter level={x.thinking} />}
      {mismatch && <span className="mismatch" role="img" aria-label={mismatch} />}
      {!noMech && x.mechanism && (
        <span className="mech" title={mechanismName(x.mechanism)}>
          <MechanismIcon mechanism={x.mechanism} kind={x.kind} />
        </span>
      )}
    </span>
  );
}

/** Compact 11 px inline annotation for note footers and attempt cards. */
export function AnnotLine({ x, className }: { x: ExecLike; className?: string }) {
  const { data: vocab } = useVocab();
  const human = isHuman(x);
  const m = modelInfo(x.model, human ? 'human' : x.provider, vocab);
  return (
    <span
      className={cn('aline', providerClass(human ? 'human' : m.provider), className)}
      title={annotationTitle(x, m.name)}
    >
      <MonoTile x={x} />
      <b>{x.agent ?? (human ? 'Human' : m.name)}</b>
      {!human && x.model && <span className="mn">{m.name}</span>}
      {!human && x.thinking && (
        <>
          <ThinkMeter level={x.thinking} />
          <span>{x.thinking}</span>
        </>
      )}
      {x.provider && (
        <>
          <span className="sep">·</span>
          <span>{x.provider}</span>
        </>
      )}
      {x.mechanism && (
        <>
          <span className="sep">·</span>
          <span className="mech-t">
            <MechanismIcon mechanism={x.mechanism} kind={x.kind} size={11} />
            {x.mechanism}
          </span>
        </>
      )}
    </span>
  );
}

/** Full annotation: agent · [badge] · thinking · provider · mechanism (wraps as one unit). */
export function Annot({ x }: { x: ExecLike }) {
  const human = isHuman(x);
  return (
    <span className="annot">
      {x.agent && (
        <>
          <b>{x.agent}</b>
          <span className="sep">·</span>
        </>
      )}
      <ExecBadge x={{ ...x, agent: human ? 'Human' : x.agent }} noMech />
      <span className="annot-meta">
        {!human && x.thinking && (
          <>
            <span className="sep">·</span>
            <span>{x.thinking}</span>
          </>
        )}
        {x.provider && (
          <>
            <span className="sep">·</span>
            <span>{x.provider}</span>
          </>
        )}
        {x.mechanism && (
          <>
            <span className="sep">·</span>
            <span className="mech-t">
              <MechanismIcon mechanism={x.mechanism} kind={x.kind} size={11} />
              {x.mechanism}
            </span>
          </>
        )}
      </span>
    </span>
  );
}

/**
 * "recommended Opus · high, ran on Sonnet · medium" when the actual annotation differs from
 * the node's executor hints (concepts §9.2).
 */
export function executorMismatch(
  hint: { model?: string; thinking?: string } | undefined,
  actual: ExecLike | undefined,
): string | undefined {
  if (!hint || !actual || actual.kind === 'human') return undefined;
  const modelOff =
    hint.model &&
    actual.model &&
    hint.model !== actual.model &&
    !actual.model.startsWith(`${hint.model}-`);
  const thinkOff = hint.thinking && actual.thinking && hint.thinking !== actual.thinking;
  if (!modelOff && !thinkOff) return undefined;
  const rec = [hint.model ? modelInfo(hint.model, undefined).name : undefined, hint.thinking]
    .filter(Boolean)
    .join(' · ');
  const ran = [actual.model ? modelInfo(actual.model, undefined).name : undefined, actual.thinking]
    .filter(Boolean)
    .join(' · ');
  return `Recommended ${rec}, ran on ${ran}`;
}
