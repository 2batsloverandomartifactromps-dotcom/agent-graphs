/** Simulated agent profiles: identity (the execution annotation) plus behavior. */

export type SimulatedAgentProfile = {
  name: string;
  model: string;
  thinking: string;
  provider: string;
  mechanism: string;
  /** Probability that an attempt fails its aims (exercises failure-cycles). */
  failureRate: number;
  /** Probability of `attempt_fail` (an execution error; counted, retryable). */
  errorRate?: number;
  /** Probability of crashing mid-attempt: heartbeats stop and the lease expires. */
  crashRate?: number;
  /** Probability of stopping on an external blocker (`attempt_block`). */
  blockRate?: number;
  /** Probability of asking a (non-blocking) question mid-attempt. */
  questionRate?: number;
  /** Simulated minutes per attempt. */
  durationMinutes?: { min: number; max: number };
  /** Simulated spend per minute of work (reported as cumulative usage). */
  costPerMinute?: number;
  /** Judges: probability of an `unmet` verdict. */
  strictness?: number;
  /** Skills declared at claim (matched against `executor.requires`). */
  skills?: string[];
};

export const DEFAULT_PROFILES: readonly SimulatedAgentProfile[] = [
  {
    name: 'opus-worker',
    model: 'claude-opus-5-5',
    thinking: 'high',
    provider: 'anthropic',
    mechanism: 'claude-code',
    failureRate: 0.15,
    errorRate: 0.02,
    crashRate: 0.02,
    blockRate: 0.01,
    questionRate: 0.05,
    durationMinutes: { min: 8, max: 25 },
    costPerMinute: 0.06,
  },
  {
    name: 'sonnet-worker',
    model: 'claude-sonnet-5-5',
    thinking: 'medium',
    provider: 'anthropic',
    mechanism: 'claude-agent-sdk',
    failureRate: 0.25,
    errorRate: 0.03,
    crashRate: 0.02,
    blockRate: 0.01,
    questionRate: 0.05,
    durationMinutes: { min: 5, max: 18 },
    costPerMinute: 0.03,
  },
  {
    name: 'haiku-worker',
    model: 'claude-haiku-4-5',
    thinking: 'low',
    provider: 'anthropic',
    mechanism: 'claude-code',
    failureRate: 0.35,
    errorRate: 0.05,
    crashRate: 0.03,
    blockRate: 0.01,
    questionRate: 0.03,
    durationMinutes: { min: 3, max: 10 },
    costPerMinute: 0.01,
  },
  {
    name: 'gpt-worker',
    model: 'gpt-5',
    thinking: 'medium',
    provider: 'openai',
    mechanism: 'codex',
    failureRate: 0.25,
    errorRate: 0.04,
    crashRate: 0.02,
    durationMinutes: { min: 6, max: 20 },
    costPerMinute: 0.04,
  },
  {
    name: 'reliable-worker',
    model: 'claude-sonnet-5-5',
    thinking: 'medium',
    provider: 'anthropic',
    mechanism: 'claude-code',
    failureRate: 0,
    durationMinutes: { min: 5, max: 5 },
    costPerMinute: 0.02,
  },
  {
    name: 'judge',
    model: 'claude-opus-5-5',
    thinking: 'high',
    provider: 'anthropic',
    mechanism: 'claude-agent-sdk',
    failureRate: 0,
    strictness: 0.15,
  },
  {
    name: 'lead',
    model: 'claude-opus-5-5',
    thinking: 'high',
    provider: 'anthropic',
    mechanism: 'claude-code',
    failureRate: 0,
  },
];

export function profileByName(
  name: string | undefined,
  fallback = 'sonnet-worker',
): SimulatedAgentProfile {
  const found = DEFAULT_PROFILES.find((p) => p.name === (name ?? fallback));
  if (!found)
    throw new Error(
      `Unknown simulator profile '${name}'. Known: ${DEFAULT_PROFILES.map((p) => p.name).join(', ')}.`,
    );
  return found;
}

export function annotationOf(profile: SimulatedAgentProfile, agent: string) {
  return {
    kind: 'agent' as const,
    agent,
    model: profile.model,
    thinking: profile.thinking,
    provider: profile.provider,
    mechanism: profile.mechanism,
  };
}
