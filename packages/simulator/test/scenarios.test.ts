import { readdirSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { loadScenario, runScenario } from '../src/index';
import { memoryHost } from './host';

const dir = resolve(import.meta.dirname, '../scenarios');
const files = readdirSync(dir)
  .filter((f) => f.endsWith('.yaml'))
  .sort();

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
