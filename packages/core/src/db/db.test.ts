import { describe, expect, it } from 'vitest';
import { openDb } from './index.js';

describe('openDb', () => {
  it('applies migrations and enables foreign keys', () => {
    const db = openDb({ file: ':memory:' });
    const tables = db.$client
      .prepare("select name from sqlite_master where type in ('table') order by name")
      .all()
      .map((r) => (r as { name: string }).name);
    expect(tables).toEqual(
      expect.arrayContaining(['projects', 'tasks', 'search_fts', 'change_log']),
    );
    expect(db.$client.pragma('foreign_keys', { simple: true })).toBe(1);
  });

  it('enforces a single attachment target for files', () => {
    const db = openDb({ file: ':memory:' });
    const c = db.$client;
    c.prepare("insert into projects (slug, name) values ('p', 'P')").run();
    c.prepare("insert into phases (project_id, title, position) values (1, 'Ph', 0)").run();
    c.prepare(
      "insert into tasks (phase_id, project_id, title, position) values (1, 1, 'T', 0)",
    ).run();
    const insert = (phase: number | null, task: number | null) =>
      c
        .prepare(
          `insert into files (project_id, phase_id, task_id, original_name, mime, size, sha256, storage_path, source)
           values (1, ?, ?, 'a', 'text/plain', 1, 'x', 'a', 'ui')`,
        )
        .run(phase, task);
    expect(() => insert(1, null)).not.toThrow();
    expect(() => insert(1, 1)).toThrow(/CHECK/);
  });

  it('indexes tasks in FTS via triggers', () => {
    const db = openDb({ file: ':memory:' });
    const c = db.$client;
    c.prepare("insert into projects (slug, name) values ('p', 'Saldatrice')").run();
    c.prepare("insert into phases (project_id, title, position) values (1, 'Ph', 0)").run();
    c.prepare(
      "insert into tasks (phase_id, project_id, title, position) values (1, 1, 'Calibrare il sensore', 0)",
    ).run();
    const hit = (q: string) =>
      c.prepare('select kind from search_fts where search_fts match ?').all(q);
    expect(hit('sensore')).toEqual([{ kind: 'task' }]);
    c.prepare("update tasks set title = 'Montare la ventola' where id = 1").run();
    expect(hit('sensore')).toEqual([]);
    expect(hit('ventol*')).toEqual([{ kind: 'task' }]);
  });
});
