/** Emit the JSON Schema for graph specs (for editors: `# yaml-language-server: $schema=…`). */
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { specJsonSchema } from '../src/spec/json-schema';

const out = resolve(import.meta.dirname, '../dist-schema/graph-spec.schema.json');
mkdirSync(dirname(out), { recursive: true });
writeFileSync(out, `${JSON.stringify(specJsonSchema(), null, 2)}\n`);
console.log(`wrote ${out}`);
