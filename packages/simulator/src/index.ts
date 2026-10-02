/**
 * @agent-graphs/simulator: configurable fake workers, reviewers, and human auto-resolvers that
 * drive graphs through the real API, plus seed data and a YAML scenario runner for server tests.
 * Powers `pnpm demo`. Built in milestone M3 (node `simulator` in docs/build-graph.yaml).
 */

export type SimulatedAgentProfile = {
  name: string;
  model: string;
  thinking: string;
  provider: string;
  mechanism: string;
  /** Probability that an attempt fails its aims (exercises failure-cycles). */
  failureRate: number;
};

export const DEFAULT_PROFILES: readonly SimulatedAgentProfile[] = [
  {
    name: 'opus-worker',
    model: 'claude-opus-5-5',
    thinking: 'high',
    provider: 'anthropic',
    mechanism: 'claude-code',
    failureRate: 0.15,
  },
  {
    name: 'sonnet-worker',
    model: 'claude-sonnet-5-5',
    thinking: 'medium',
    provider: 'anthropic',
    mechanism: 'claude-agent-sdk',
    failureRate: 0.25,
  },
  {
    name: 'haiku-worker',
    model: 'claude-haiku-4-5',
    thinking: 'low',
    provider: 'anthropic',
    mechanism: 'claude-code',
    failureRate: 0.35,
  },
];
