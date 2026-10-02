/** Lesson-duty detection (docs/self-evolution.md §7 Capture). */
import { attemptsOf } from '../engine/state';
import type { GraphState } from '../engine/types';

/**
 * When a node passes after one or more failed attempts or loop iterations, return the failed
 * attempts to contrast with the pass (empty when no lesson duty is due).
 */
export function lessonDutyFailures(
  state: GraphState,
  nodeId: string,
  passedAttemptId: string,
): string[] {
  if (state.graph.evolution.mode === 'off') return [];
  return attemptsOf(state, nodeId)
    .filter((a) => a.id !== passedAttemptId && (a.status === 'failed' || a.counted))
    .map((a) => a.id);
}
