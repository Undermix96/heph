// Independent verification of the project export (verify round 7). Invented data only.
import fs from 'node:fs';
import { eq } from 'drizzle-orm';
import { afterEach, describe, expect, it } from 'vitest';
import { UI } from './context.js';
import { files as filesTable, projectRepos } from './db/schema.js';
import { safeName } from './export.js';
import { seedProject, writeTemp } from './test/fixtures.js';
import { makeDomain, type TestDomain } from './test/helpers.js';

let t: TestDomain;
afterEach(() => t?.cleanup());

const SAFE = /^[A-Za-z0-9._-]{1,100}$/;

describe('verify7 safeName invariants', () => {
  const inputs = [
    '',
    '.',
    '..',
    '...',
    '/',
    '\\',
    '///',
    '\\\\\\',
    '../..',
    '..\\..\\',
    'a/',
    'C:',
    'C:\\',
    '/etc/passwd',
    '\u0000',
    '\u202e.exe',
    '😀😀.png',
    '😀',
    '日本語',
    `${'a'.repeat(50)}${'.'.repeat(60)}b`,
    `x${'.'.repeat(120)}`,
    `${'.'.repeat(200)}`,
    `${'a'.repeat(5)}.${'b'.repeat(99)}`,
    'con',
    'name with spaces.txt',
    'a\r\nb.txt',
  ];

  it.each(inputs.map((s) => [s]))('%j → only [A-Za-z0-9._-], ≤100, no leading dot', (s) => {
    const out = safeName(s);
    expect(out).toMatch(SAFE);
    expect(out.startsWith('.')).toBe(false);
    expect(out.includes('/') || out.includes('\\')).toBe(false);
    expect(out).not.toBe('..');
  });

  it('never yields a leading dot after truncating to 100 characters', () => {
    // 1 letter, then 120 dots, then "b": the leading-dot strip runs before slice(-100).
    const out = safeName(`a${'.'.repeat(120)}b`);
    expect(out.startsWith('.')).toBe(false);
  });
});

describe('verify7 export.build', () => {
  it('two files with the same name get distinct archive paths', async () => {
    t = makeDomain();
    const p = seedProject(t.d);
    const a = await t.d.files.ingest(
      p.id,
      { tempPath: writeTemp(t.d, 'one'), originalName: 'same.txt' },
      UI,
    );
    const b = await t.d.files.ingest(
      p.id,
      { tempPath: writeTemp(t.d, 'two'), originalName: 'same.txt' },
      UI,
    );
    const x = t.d.export.build(p.id);
    const paths = x.files.map((f) => f.zipPath);
    expect(new Set(paths).size).toBe(2);
    expect(paths).toContain(`files/${a.id}-same.txt`);
    expect(paths).toContain(`files/${b.id}-same.txt`);
  });

  it('archive paths stay safe even when the stored original name is hostile', async () => {
    t = makeDomain();
    const p = seedProject(t.d);
    const f = await t.d.files.ingest(
      p.id,
      { tempPath: writeTemp(t.d, 'x'), originalName: 'ok.txt' },
      UI,
    );
    for (const name of ['../../../x', '..', '/abs/path', 'C:\\a\\..\\b', '😀', '....']) {
      t.d.db.update(filesTable).set({ originalName: name }).where(eq(filesTable.id, f.id)).run();
      const zp = t.d.export.build(p.id).files[0]!.zipPath;
      expect(zp).toMatch(/^files\/\d+-[A-Za-z0-9._-]+$/);
      expect(zp.split('/').some((seg) => seg === '..' || seg === '.')).toBe(false);
    }
  });

  it('includes statusNote, tags, links, repos, description and nextTask in the Markdown', () => {
    t = makeDomain();
    const p = seedProject(t.d, {
      tags: ['alpha', 'beta'],
      links: [{ label: 'Docs site', url: 'https://example.com/docs' }],
      repos: ['acme/widget'],
      description: 'Invented description.',
      statusNote: 'Waiting on parts',
    });
    const md = t.d.export.build('acme/widget').markdown;
    expect(md).toContain('* Tags: alpha, beta'); // own lists use `*` since D53 rev. 2026-11-25
    expect(md).toContain('acme/widget');
    expect(md).toContain('[Docs site](https://example.com/docs)');
    expect(md).toContain('Invented description.');
    expect(md).toContain('Waiting on parts');
    expect(md).toMatch(/\* Next task: #\d+ Schematic/);
    expect(md).toContain('* Progress: 0/4 (0%)');
    expect(t.d.export.build('acme/widget').json.project.id).toBe(p.id);
  });

  it('demotes headings inside the project description', () => {
    t = makeDomain();
    seedProject(t.d, { description: '# Big title\n\nText.' });
    const md = t.d.export.build('spot-welder').markdown;
    // Only the export title may be an H1.
    const h1 = md.split('\n').filter((l) => /^# /.test(l));
    expect(h1).toEqual(['# Spot Welder']);
  });

  it('demotes headings inside phase descriptions', () => {
    t = makeDomain();
    seedProject(t.d, {
      phases: [{ title: 'Design', description: '# Phase heading\n\nText.', tasks: ['A'] }],
    });
    const md = t.d.export.build('spot-welder').markdown;
    const h1 = md.split('\n').filter((l) => /^# /.test(l));
    expect(h1).toEqual(['# Spot Welder']);
  });

  it('keeps headings inside fenced code blocks of diary notes untouched', () => {
    t = makeDomain();
    const p = seedProject(t.d);
    t.d.diary.addNote(p.id, { body: '## Real\n\n```md\n# not a heading\n```\n\n# After' }, UI);
    const md = t.d.export.build(p.id).markdown;
    expect(md).toContain('#### Real');
    expect(md).toContain('```md\n# not a heading\n```');
    expect(md).toContain('### After');
  });

  it('demotes setext headings in embedded Markdown', () => {
    t = makeDomain();
    const p = seedProject(t.d);
    t.d.diary.addNote(p.id, { body: 'Title\n=====\n\nbody' }, UI);
    const md = t.d.export.build(p.id).markdown;
    // A setext "=====" underline makes an H1 that escapes the diary section.
    expect(md).not.toMatch(/\nTitle\n=+\n/);
  });

  it('an unclosed fence in one diary note does not swallow the following sections', () => {
    t = makeDomain();
    const p = seedProject(t.d);
    t.d.diary.addNote(p.id, { body: 'start\n```\nunclosed code' }, UI);
    t.d.diary.addNote(p.id, { body: '# Later note' }, UI);
    const md = t.d.export.build(p.id).markdown;
    // Count fence lines: an odd count means everything after the open fence is code.
    const fences = md.split('\n').filter((l) => /^\s*(```|~~~)/.test(l)).length;
    expect(fences % 2).toBe(0);
  });

  it('escapes pipes in every materials cell (name, unit) and survives newlines', () => {
    t = makeDomain();
    const p = seedProject(t.d);
    t.d.materials.add(p.id, { name: 'A|B\nC', quantity: 1, unit: 'm|m' }, UI);
    const md = t.d.export.build(p.id).markdown;
    const row = md.split('\n').find((l) => l.includes('A\\|B'));
    expect(row).toBeDefined();
    expect(row).toContain('m\\|m');
    // 4 columns → 5 unescaped pipes.
    expect(row!.replace(/\\\|/g, '').split('|').length - 1).toBe(5);
  });

  it.each([499, 500, 501, 999, 1000, 1001])(
    'exports exactly every diary entry with %i entries at one timestamp',
    (n) => {
      t = makeDomain();
      const p = seedProject(t.d); // creates 1 event entry
      for (let i = 0; i < n - 1; i++) t.d.diary.addNote(p.id, { body: `n${i}` }, UI);
      const diary = t.d.export.build(p.id).json.diary;
      expect(diary).toHaveLength(n);
      const ids = diary.map((e) => e.id);
      expect(new Set(ids).size).toBe(n);
      expect(ids).toEqual([...ids].sort((a, b) => a - b));
      const md = t.d.export.build(p.id).markdown;
      expect(md).toContain('n0');
      expect(md).toContain(`n${n - 2}`);
    },
  );

  it('diary in the Markdown is oldest first', () => {
    t = makeDomain();
    const p = seedProject(t.d);
    t.d.diary.addNote(p.id, { body: 'FIRST-NOTE' }, UI);
    t.clock.advance(1000);
    t.d.diary.addNote(p.id, { body: 'SECOND-NOTE' }, UI);
    const md = t.d.export.build(p.id).markdown;
    expect(md.indexOf('FIRST-NOTE')).toBeLessThan(md.indexOf('SECOND-NOTE'));
  });

  it('exportedAt is ISO UTC and the empty files list is fine', () => {
    t = makeDomain();
    const p = seedProject(t.d);
    const j = t.d.export.build(p.id).json;
    expect(j.exportedAt).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/);
    expect(j.files).toEqual([]);
    expect(Array.isArray(j.proposals)).toBe(true);
  });

  it('repo docs: synced content demoted, unsynced shows "Not synced yet."', () => {
    t = makeDomain();
    const p = seedProject(t.d, { repos: ['acme/a', 'acme/b'] });
    const [a] = t.d.projects.repoRows(p.id);
    t.d.db
      .update(projectRepos)
      .set({ docsContent: '# Top\n\n## Sub', docsUpdatedAt: t.clock.now, docsOrigin: 'hook' })
      .where(eq(projectRepos.id, a!.id))
      .run();
    const md = t.d.export.build(p.id).markdown;
    expect(md).toContain('### acme/a: DECISIONS.md\n\n### Top\n\n#### Sub');
    expect(md).toContain('### acme/b: DECISIONS.md\n\nNot synced yet.');
  });

  it('a file whose disk path is a directory is not treated as exportable', async () => {
    t = makeDomain();
    const p = seedProject(t.d);
    const f = await t.d.files.ingest(
      p.id,
      { tempPath: writeTemp(t.d, 'x'), originalName: 'f.txt' },
      UI,
    );
    const abs = t.d.files.open(f.id).path;
    fs.rmSync(abs);
    fs.mkdirSync(abs);
    const x = t.d.export.build(p.id);
    // existsSync() is true for a directory; the stream would then fail with EISDIR.
    expect(x.files).toEqual([]);
  });
});
