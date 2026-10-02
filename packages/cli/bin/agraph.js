#!/usr/bin/env node
// Development entry: runs the TypeScript sources through tsx. Releases (M5) point `bin` at a
// tsdown bundle instead.
import { register } from 'tsx/esm/api';

register();
await import('../src/bin.ts');
