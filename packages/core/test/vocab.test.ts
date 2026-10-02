import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { specJsonSchema } from '../src/spec/json-schema';
import { MODEL_DISPLAY, modelDisplay, providerTint, vocabPayload } from '../src/vocab-display';
import { EVENT_TYPES, KNOWN_MODELS, MECHANISMS, PROVIDERS } from '../src/vocabulary';

const root = resolve(import.meta.dirname, '../../..');

describe('vocabulary matches the docs', () => {
  it('EVENT_TYPES equals the data-model event catalog', () => {
    const doc = readFileSync(resolve(root, 'docs/data-model.md'), 'utf8');
    const catalog = doc.slice(doc.indexOf('## Event catalog'), doc.indexOf('## Hash chain'));
    const documented = new Set([...catalog.matchAll(/`([a-z]+\.[a-z_]+)`/g)].map((m) => m[1]));
    expect(new Set(EVENT_TYPES)).toEqual(documented);
  });
});

describe('vocab display', () => {
  it('covers every known model, provider, and mechanism', () => {
    for (const m of KNOWN_MODELS) expect(MODEL_DISPLAY[m].name).toBeTruthy();
    const payload = vocabPayload();
    expect(payload.providers.map((p) => p.id).sort()).toEqual([...PROVIDERS].sort());
    expect(payload.mechanisms.map((m) => m.id).sort()).toEqual([...MECHANISMS].sort());
    expect(payload.thinking.at(-1)).toEqual({ id: 'max', bars: 5 });
  });

  it('resolves dated model ids and unknown providers', () => {
    expect(modelDisplay('claude-haiku-4-5-20251001')?.name).toBe('Haiku 4.5');
    expect(modelDisplay('some-local-model')).toBeUndefined();
    expect(providerTint('mystery')).toEqual(providerTint(undefined));
  });
});

describe('JSON Schema', () => {
  it('is up to date (run pnpm -F @agent-graphs/core schema:json)', () => {
    const committed = readFileSync(
      resolve(root, 'packages/core/dist-schema/graph-spec.schema.json'),
      'utf8',
    );
    expect(committed).toBe(`${JSON.stringify(specJsonSchema(), null, 2)}\n`);
  });
});
