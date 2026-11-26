/** Independent verification of the squashed migrations (D40) and FTS triggers. */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';
import { openDb } from './db/index.js';
import { seedProject } from './test/fixtures.js';
import { makeDomain, type TestDomain } from './test/helpers.js';

const UI = { source: 'ui' } as const;
const drizzleDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../drizzle');

let t: TestDomain | null = null;
afterEach(() => {
  t?.cleanup();
  t = null;
});

describe('verify: migrations', () => {
  // D40 regenerated 0000/0001; later migrations are append-only (0002: phase 5 hooks).
  it('drizzle/ migrations start with init and FTS, are numbered in order and match the journal', () => {
    const sql = fs
      .readdirSync(drizzleDir)
      .filter((f) => f.endsWith('.sql'))
      .sort();
    expect(sql.slice(0, 3)).toEqual([
      '0000_init.sql',
      '0001_search_fts.sql',
      '0002_claude_session_hooks.sql',
    ]);
    for (const [i, f] of sql.entries()) expect(f.startsWith(String(i).padStart(4, '0'))).toBe(true);
    const journal = JSON.parse(
      fs.readFileSync(path.join(drizzleDir, 'meta/_journal.json'), 'utf8'),
    );
    expect(journal.entries.map((e: { tag: string }) => `${e.tag}.sql`)).toEqual(sql);
    const snaps = fs
      .readdirSync(path.join(drizzleDir, 'meta'))
      .filter((f) => f.endsWith('_snapshot.json'));
    expect(snaps.length).toBe(sql.length);
  });

  it('a fresh file database migrates cleanly and re-opening is a no-op', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'heph-verify-db-'));
    try {
      const file = path.join(dir, 'heph.db');
      const db1 = openDb({ file });
      const c1 = db1.$client as unknown as {
        prepare(q: string): { all(): unknown[] };
        close(): void;
      };
      const applied = c1.prepare('select * from __drizzle_migrations').all();
      expect(applied.length).toBe(migrationCount());
      c1.close();
      const db2 = openDb({ file });
      const c2 = db2.$client as unknown as {
        prepare(q: string): { all(): unknown[] };
        close(): void;
      };
      expect(c2.prepare('select * from __drizzle_migrations').all().length).toBe(migrationCount());
      expect(
        c2.prepare("select name from sqlite_master where name='search_fts'").all().length,
      ).toBe(1);
      c2.close();
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it('FTS triggers keep search in sync for insert, update and delete', () => {
    t = makeDomain();
    const { d } = t;
    const p = seedProject(d, { name: 'Zebrafish tank', description: 'quokka' });
    expect(d.search.search({ q: 'zebrafish' }).length).toBeGreaterThan(0);
    expect(d.search.search({ q: 'quokka' }).length).toBe(1);
    d.projects.update(p.id, { description: 'wombat' }, UI);
    expect(d.search.search({ q: 'quokka' }).length).toBe(0);
    expect(d.search.search({ q: 'wombat' }).length).toBe(1);
    const task = d.roadmap.addTask(p.phases[0]!.id, { title: 'Platypus filter' }, UI);
    expect(d.search.search({ q: 'platypus' }).map((h) => h.kind)).toContain('task');
    d.roadmap.updateTask(task.id, { title: 'Axolotl filter' }, UI);
    expect(d.search.search({ q: 'platypus' }).length).toBe(0);
    expect(d.search.search({ q: 'axolotl' }).length).toBe(1);
    d.diary.addNote(p.id, { body: 'narwhal sighting' }, UI);
    expect(d.search.search({ q: 'narwhal' }).map((h) => h.kind)).toEqual(['diary']);
    d.projects.delete(p.id, UI);
    for (const q of ['zebrafish', 'wombat', 'axolotl', 'narwhal']) {
      expect(d.search.search({ q }).length, q).toBe(0);
    }
  });
});

function migrationCount(): number {
  return fs.readdirSync(drizzleDir).filter((f) => f.endsWith('.sql')).length;
}
