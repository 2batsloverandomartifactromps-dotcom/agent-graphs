/** JSON Schema for the spec input format, derived from the zod schema (one schema source). */
import { z } from 'zod';
import { SpecInput } from './schema';

export function specJsonSchema(): Record<string, unknown> {
  const schema = z.toJSONSchema(SpecInput, {
    target: 'draft-2020-12',
    io: 'input',
    unrepresentable: 'any',
  });
  return {
    ...schema,
    $id: 'urn:agent-graphs:graph-spec:v1',
    title: 'Agent Graphs spec (agent-graphs/v1)',
    description: 'A graph of nodes, aims, loops, and orchestrators. See docs/spec-format.md.',
  };
}
