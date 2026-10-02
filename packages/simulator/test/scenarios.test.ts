import { readdirSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { loadScenario, parseScenario, runScenario } from '../src/index';
import { memoryHost } from './host';

const dir = resolve(import.meta.dirname, '../scenarios');
const files = readdirSync(dir)
  .filter((f) => f.endsWith('.yaml'))
  .sort();

describe('scenario runner', () => {
  it('reports unmet expectations, wrong expected errors, and never-run actions', async () => {
    const scenario = parseScenario(
      `
name: deliberately wrong
specFile: ../../../examples/graphs/minimal.yaml
maxTicks: 30
agents:
  workers: [{ profile: reliable-worker }]
  judges: [{ profile: judge, strictness: 0 }]
  human: { delayMinutes: 1 }
script:
  - at: 1
    action: pause
    expectError: POLICY_DENIED
  - at: 1
    action: resume
  - when: { node: nonexistent, status: done }
    action: cancel
expect:
  graph: failed
  nodes: { implement: skipped }
  loops: { review-cycle: { iteration: 9 } }
  events: { include: [graph.cancelled] }
  stats: { crashes: 1 }
`,
      dir,
    );
    const result = await runScenario(scenario, memoryHost());
    expect(result.passed).toBe(false);
    const text = result.failures.join('\n');
    expect(text).toContain('action pause: expected POLICY_DENIED, got success');
    expect(text).toContain('1 scripted action(s) never ran');
    expect(text).toContain('graph status: expected failed');
    expect(text).toContain('node implement: expected skipped');
    expect(text).toContain('loop review-cycle: expected iteration 9');
    expect(text).toContain('missing event graph.cancelled');
    expect(text).toContain('stat crashes: expected ≥1, got 0');
  }, 30_000);

  it('rejects malformed scenarios', () => {
    expect(() => parseScenario('name: x\nspec: "a"\nbogus: 1\n')).toThrow();
    expect(() => parseScenario('name: x\n')).toThrow(/needs spec or specFile/);
  });
});

describe('simulator scenarios', () => {
  it('has scenarios', () => {
    expect(files.length).toBeGreaterThan(0);
  });
  for (const file of files) {
    it(file.replace(/\.yaml$/, ''), { timeout: 60_000 }, async () => {
      const scenario = loadScenario(join(dir, file));
      const result = await runScenario(scenario, memoryHost());
      const report = `${scenario.name}: ${result.status} after ${result.ticks} ticks\n${result.failures.join('\n')}\n--- log (tail) ---\n${result.log.slice(-40).join('\n')}`;
      expect(result.failures, report).toEqual([]);
      expect(result.passed).toBe(true);
    });
  }
});
