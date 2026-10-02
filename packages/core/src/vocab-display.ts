/**
 * Display metadata for the open annotation vocabularies, served by `GET /api/v1/vocab`
 * (docs/api.md) and used by the UI model badges (docs/ui.md §6.3, §6.6). Unknown values are
 * accepted everywhere and render with their raw id.
 */
import { type KNOWN_MODELS, type MECHANISMS, type PROVIDERS, THINKING_LEVELS } from './vocabulary';

export type Tint = { dark: string; light: string };

export type ModelDisplay = {
  id: string;
  name: string;
  provider: (typeof PROVIDERS)[number];
  /** Monogram for the 16 px badge tile. */
  monogram: string;
  family: string;
};

export const MODEL_DISPLAY: Record<(typeof KNOWN_MODELS)[number], ModelDisplay> = {
  'claude-fable-5-1': {
    id: 'claude-fable-5-1',
    name: 'Fable 5.1',
    provider: 'anthropic',
    monogram: 'F',
    family: 'claude',
  },
  'claude-opus-5-5': {
    id: 'claude-opus-5-5',
    name: 'Opus 5.5',
    provider: 'anthropic',
    monogram: 'O',
    family: 'claude',
  },
  'claude-sonnet-5-5': {
    id: 'claude-sonnet-5-5',
    name: 'Sonnet 5.5',
    provider: 'anthropic',
    monogram: 'S',
    family: 'claude',
  },
  'claude-haiku-4-5': {
    id: 'claude-haiku-4-5',
    name: 'Haiku 4.5',
    provider: 'anthropic',
    monogram: 'H',
    family: 'claude',
  },
  'gpt-5': { id: 'gpt-5', name: 'GPT-5', provider: 'openai', monogram: 'G', family: 'gpt' },
  'gemini-2.5-pro': {
    id: 'gemini-2.5-pro',
    name: 'Gemini 2.5 Pro',
    provider: 'google',
    monogram: 'G',
    family: 'gemini',
  },
};

/** Low-chroma provider tints (never read as a status). Unlisted providers use `neutral`. */
export const PROVIDER_TINTS: Record<string, Tint> = {
  anthropic: { dark: '#d4a27f', light: '#b9774b' },
  openai: { dark: '#8fbfaa', light: '#3f8f6e' },
  google: { dark: '#93a9dc', light: '#4f6fbf' },
  human: { dark: '#c3c4cc', light: '#8a8c96' },
  neutral: { dark: '#a3a6ae', light: '#6f727b' },
};

export const PROVIDER_DISPLAY: Record<(typeof PROVIDERS)[number], { name: string; tint: Tint }> = {
  anthropic: { name: 'Anthropic', tint: PROVIDER_TINTS.anthropic as Tint },
  openai: { name: 'OpenAI', tint: PROVIDER_TINTS.openai as Tint },
  google: { name: 'Google', tint: PROVIDER_TINTS.google as Tint },
  'aws-bedrock': { name: 'AWS Bedrock', tint: PROVIDER_TINTS.neutral as Tint },
  'gcp-vertex': { name: 'Google Vertex AI', tint: PROVIDER_TINTS.google as Tint },
  azure: { name: 'Azure', tint: PROVIDER_TINTS.neutral as Tint },
  local: { name: 'Local', tint: PROVIDER_TINTS.neutral as Tint },
  human: { name: 'Human', tint: PROVIDER_TINTS.human as Tint },
};

export type MechanismIcon =
  | 'terminal'
  | 'cloud'
  | 'braces'
  | 'code'
  | 'plug'
  | 'user'
  | 'workflow'
  | 'cursor';

export const MECHANISM_DISPLAY: Record<
  (typeof MECHANISMS)[number],
  { name: string; icon: MechanismIcon }
> = {
  'claude-code': { name: 'Claude Code', icon: 'terminal' },
  'claude-code-web': { name: 'Claude Code on the web', icon: 'cloud' },
  'claude-agent-sdk': { name: 'Claude Agent SDK', icon: 'braces' },
  'claude-api': { name: 'Claude API', icon: 'code' },
  codex: { name: 'Codex', icon: 'terminal' },
  'gemini-cli': { name: 'Gemini CLI', icon: 'terminal' },
  cursor: { name: 'Cursor', icon: 'cursor' },
  'github-action': { name: 'GitHub Action', icon: 'workflow' },
  mcp: { name: 'MCP', icon: 'plug' },
  cli: { name: 'CLI', icon: 'terminal' },
  api: { name: 'API', icon: 'code' },
  ui: { name: 'Web UI', icon: 'user' },
};

/** Thinking meter bars (0–5) for off … max. */
export const THINKING_BARS: Record<(typeof THINKING_LEVELS)[number], number> = {
  off: 0,
  low: 1,
  medium: 2,
  high: 3,
  xhigh: 4,
  max: 5,
};

export function modelDisplay(id: string | undefined): ModelDisplay | undefined {
  if (!id) return undefined;
  const known = (MODEL_DISPLAY as Record<string, ModelDisplay>)[id];
  if (known) return known;
  // Dated or suffixed ids (for example `claude-haiku-4-5-20251001`) map to their base model.
  const base = Object.keys(MODEL_DISPLAY).find((k) => id.startsWith(`${k}-`));
  return base ? (MODEL_DISPLAY as Record<string, ModelDisplay>)[base] : undefined;
}

export function providerTint(provider: string | undefined): Tint {
  return PROVIDER_TINTS[provider ?? ''] ?? (PROVIDER_TINTS.neutral as Tint);
}

/** The `GET /vocab` payload (before admin display overrides). */
export function vocabPayload() {
  return {
    models: Object.values(MODEL_DISPLAY),
    providers: Object.entries(PROVIDER_DISPLAY).map(([id, d]) => ({ id, ...d })),
    mechanisms: Object.entries(MECHANISM_DISPLAY).map(([id, d]) => ({ id, ...d })),
    thinking: THINKING_LEVELS.map((id) => ({ id, bars: THINKING_BARS[id] })),
  };
}
