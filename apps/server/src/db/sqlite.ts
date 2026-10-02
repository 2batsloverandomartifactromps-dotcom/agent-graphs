import Database from 'better-sqlite3';

/**
 * Opens the SQLite database with the pragmas from docs/data-model.md. The Drizzle schema,
 * migrations, and repositories arrive in M2 (node `db-schema` in docs/build-graph.yaml).
 */
export function openDatabase(path: string): Database.Database {
  const db = new Database(path);
  db.pragma('journal_mode = WAL');
  db.pragma('synchronous = NORMAL');
  db.pragma('foreign_keys = ON');
  db.pragma('busy_timeout = 5000');
  return db;
}
