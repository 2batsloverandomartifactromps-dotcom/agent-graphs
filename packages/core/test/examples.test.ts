/** Every example spec and the build graph must validate with zero errors (examples_valid_ratio). */
import { readdirSync, readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { validateSpecText } from '../src/spec/validate';

const repoRoot = resolve(import.meta.dirname, '../../..');
const specFiles = [
  ...readdirSync(join(repoRoot, 'examples/graphs'))
    .filter((file) => file.endsWith('.yaml'))
    .map((file) => join(repoRoot, 'examples/graphs', file)),
  join(repoRoot, 'docs/build-graph.yaml'),
];

describe.each(specFiles)('%s', (file) => {
  it('validates with zero errors', () => {
    const result = validateSpecText(readFileSync(file, 'utf8'));
    expect(result.errors).toEqual([]);
    expect(result.ok).toBe(true);
  });
});
