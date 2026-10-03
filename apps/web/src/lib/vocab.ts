/**
 * Execution annotation display (docs/ui.md §6.3): friendly model names from GET /vocab (with the
 * core table as a fallback), provider tint classes, thinking bars, and mechanism icons.
 */
import { MECHANISM_DISPLAY, modelDisplay, THINKING_BARS } from '@agent-graphs/core';
import type { Vocab } from '@agent-graphs/sdk';

type VocabPayload = (Pick<Vocab, 'models'> & { overrides?: Record<string, unknown> }) | undefined;

export type ModelInfo = {
  id: string;
  name: string;
  monogram: string;
  provider: string;
  known: boolean;
};

const TINTED = new Set(['anthropic', 'openai', 'google', 'human']);

export function providerClass(provider: string | undefined): string {
  if (provider && TINTED.has(provider)) return `prov-${provider}`;
  if (provider === 'gcp-vertex') return 'prov-google';
  return 'prov-neutral';
}

export function modelInfo(
  model: string | undefined,
  provider: string | undefined,
  vocab?: VocabPayload,
): ModelInfo {
  if (!model) {
    const name = provider === 'human' ? 'Human' : 'Unknown';
    return {
      id: '',
      name,
      monogram: name.charAt(0),
      provider: provider ?? 'neutral',
      known: false,
    };
  }
  const fromVocab = vocab?.models.find((m) => m.id === model || model.startsWith(`${m.id}-`));
  const d = fromVocab ?? modelDisplay(model);
  if (d)
    return {
      id: model,
      name: d.name,
      monogram: d.monogram,
      provider: provider ?? d.provider,
      known: true,
    };
  // Unknown models show their raw id (docs/ui.md §6.3).
  return {
    id: model,
    name: model,
    monogram: model.charAt(0).toUpperCase(),
    provider: provider ?? 'neutral',
    known: false,
  };
}

export function thinkingBars(level: string | undefined): number {
  if (!level) return 0;
  return (THINKING_BARS as Record<string, number>)[level] ?? 0;
}

export type MechIcon =
  | 'terminal'
  | 'cloud'
  | 'braces'
  | 'code'
  | 'plug'
  | 'user'
  | 'workflow'
  | 'cursor'
  | 'gear';

export function mechanismIcon(mechanism: string | undefined, kind?: string): MechIcon {
  if (kind === 'system') return 'gear';
  if (!mechanism) return 'code';
  if (mechanism === 'agent-sdk') return 'braces';
  if (mechanism === 'system') return 'gear';
  return ((MECHANISM_DISPLAY as Record<string, { icon: MechIcon }>)[mechanism]?.icon ??
    'code') as MechIcon;
}

export function mechanismName(mechanism: string | undefined): string {
  if (!mechanism) return '';
  return (MECHANISM_DISPLAY as Record<string, { name: string }>)[mechanism]?.name ?? mechanism;
}
