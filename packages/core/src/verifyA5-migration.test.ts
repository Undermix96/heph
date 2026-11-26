/** Independent verification: migration 0002 on a database created by the previous version. */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { DEFAULT_MIGRATIONS_DIR, openDb } from './db/index.js';
import { Domain } from './domain.js';

const dirs: string[] = [];
afterEach(() => {
  for (const d of dirs.splice(0)) fs.rmSync(d, { recursive: true, force: true });
});

/** A copy of drizzle/ holding only 0000 and 0001, as shipped before phase 5. */
function oldMigrations(root: string): string {
  const out = path.join(root, 'old-drizzle');
  fs.mkdirSync(path.join(out, 'meta'), { recursive: true });
  for (const f of ['0000_init.sql', '0001_search_fts.sql']) {
    fs.copyFileSync(path.join(DEFAULT_MIGRATIONS_DIR, f), path.join(out, f));
  }
  for (const f of ['0000_snapshot.json', '0001_snapshot.json']) {
    fs.copyFileSync(path.join(DEFAULT_MIGRATIONS_DIR, 'meta', f), path.join(out, 'meta', f));
  }
  const journal = JSON.parse(
    fs.readFileSync(path.join(DEFAULT_MIGRATIONS_DIR, 'meta/_journal.json'), 'utf8'),
  );
  journal.entries = journal.entries.slice(0, 2);
  fs.writeFileSync(path.join(out, 'meta/_journal.json'), JSON.stringify(journal));
  return out;
}

describe('verify A5: migration 0002 on an existing database', () => {
  it('keeps existing sessions and settings; hooks work on the upgraded rows', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'heph-mig-'));
    dirs.push(root);
    const file = path.join(root, 'heph.db');
    const old = openDb({ file, migrationsDir: oldMigrations(root) });
    const now = Date.UTC(2026, 10, 25, 9);
    const at = new Date(now).toISOString();
    const c = old.$client;
    c.prepare(
      `insert into settings (key, value, updated_at) values ('sessionExpiryMinutes', '45', ?)`,
    ).run(at);
    c.prepare(
      `insert into claude_sessions (session_id, project_id, repo, started_at, last_heartbeat_at, is_testing, turns_since_diary, created_at, updated_at)
       values ('old-1', null, 'example/spot', ?, ?, 0, 3, ?, ?)`,
    ).run(at, at, at, at);
    c.close();

    const db = openDb({ file });
    const d = new Domain({ db, filesDir: root, now: () => now + 60_000 });
    expect(d.settings.get().sessionExpiryMinutes).toBe(45);
    expect(d.settings.get().diaryNudgeTurns).toBe(5);
    const row = d.sessions.row('old-1');
    expect(row?.turnsSinceDiary).toBe(3);
    expect(row?.turnsSinceNudge).toBeNull();
    expect(row?.lastStopAt).toBeNull();
    expect(() =>
      d.hooks.stop('old-1', false, { remote: 'git@github.com:example/spot.git', head: 'h1' }),
    ).not.toThrow();
    expect(d.sessions.row('old-1')?.turnsSinceDiary).toBe(4);
    db.$client.close();
  });
});
