import { describe, expect, it } from 'vitest';
import {
  EVOLUTION_PROTECTED,
  EVOLUTION_SCOPES,
  GRAPH_STATUSES,
  NODE_STATUSES,
  NODE_TERMINAL_FAILURE,
  NODE_TERMINAL_SUCCESS,
  SPEC_SCHEMA,
} from './vocabulary';

describe('vocabulary', () => {
  it('uses the v1 spec marker', () => {
    expect(SPEC_SCHEMA).toBe('agent-graphs/v1');
  });

  it('has no duplicate statuses', () => {
    expect(new Set(GRAPH_STATUSES).size).toBe(GRAPH_STATUSES.length);
    expect(new Set(NODE_STATUSES).size).toBe(NODE_STATUSES.length);
  });

  it('keeps terminal success and failure disjoint', () => {
    const success = new Set<string>(NODE_TERMINAL_SUCCESS);
    expect(NODE_TERMINAL_FAILURE.some((status) => success.has(status))).toBe(false);
  });

  it('never lets an evolution scope overlap a protected field', () => {
    const protectedFields = new Set<string>(EVOLUTION_PROTECTED);
    expect(EVOLUTION_SCOPES.some((scope) => protectedFields.has(scope))).toBe(false);
  });
});
