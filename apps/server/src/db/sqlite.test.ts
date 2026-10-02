import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { openDatabase } from './sqlite';

const dir = mkdtempSync(join(tmpdir(), 'agent-graphs-db-'));
afterAll(() => rmSync(dir, { recursive: true, force: true }));

describe('sqlite platform assumptions', () => {
  const db = openDatabase(join(dir, 'test.sqlite'));

  it('runs in WAL mode with foreign keys on', () => {
    expect(db.pragma('journal_mode', { simple: true })).toBe('wal');
    expect(db.pragma('foreign_keys', { simple: true })).toBe(1);
  });

  it('supports FTS5 (notes search) and JSON functions', () => {
    db.exec('CREATE VIRTUAL TABLE notes_fts USING fts5(title, body)');
    db.prepare('INSERT INTO notes_fts (title, body) VALUES (?, ?)').run(
      'Refresh tokens not rotated',
      'Found during review of auth middleware',
    );
    const hit = db.prepare('SELECT title FROM notes_fts WHERE notes_fts MATCH ?').get('rotated');
    expect(hit).toEqual({ title: 'Refresh tokens not rotated' });
    expect(db.prepare(`SELECT json_extract('{"a":{"b":2}}', '$.a.b') AS v`).get()).toEqual({
      v: 2,
    });
  });
});
