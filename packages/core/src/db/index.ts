import fs from 'node:fs';
import path from 'node:path';
import Database from 'better-sqlite3';
import { type BetterSQLite3Database, drizzle } from 'drizzle-orm/better-sqlite3';
import { migrate } from 'drizzle-orm/better-sqlite3/migrator';
import * as schema from './schema.js';

export type Db = BetterSQLite3Database<typeof schema> & { $client: Database.Database };

export const DEFAULT_MIGRATIONS_DIR = path.resolve(import.meta.dirname, '../../drizzle');

export interface OpenDbOptions {
  /** Path to the SQLite file, or ':memory:'. */
  file: string;
  migrationsDir?: string;
}

/** Opens the database, applies pragmas and runs pending migrations. */
export function openDb({ file, migrationsDir = DEFAULT_MIGRATIONS_DIR }: OpenDbOptions): Db {
  if (file !== ':memory:') fs.mkdirSync(path.dirname(file), { recursive: true });
  const sqlite = new Database(file);
  sqlite.pragma('journal_mode = WAL');
  sqlite.pragma('synchronous = NORMAL');
  sqlite.pragma('foreign_keys = ON');
  sqlite.pragma('busy_timeout = 5000');
  const db = drizzle(sqlite, { schema }) as Db;
  migrate(db, { migrationsFolder: migrationsDir });
  return db;
}

export { schema };
