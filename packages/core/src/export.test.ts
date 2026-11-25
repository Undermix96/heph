import fs from 'node:fs';
import { eq } from 'drizzle-orm';
import type { Nodes } from 'mdast';
import { fromMarkdown } from 'mdast-util-from-markdown';
import { afterEach, describe, expect, it } from 'vitest';
import { UI } from './context.js';
import { projectRepos } from './db/schema.js';
import { demote, safeName } from './export.js';
import { CLAUDE, expectDomainError, seedProject, writeTemp } from './test/fixtures.js';
import { makeDomain, type TestDomain } from './test/helpers.js';

let t: TestDomain;
afterEach(() => t?.cleanup());

function setup(overrides: Record<string, unknown> = {}) {
  t = makeDomain();
  const p = seedProject(t.d, overrides);
  return { ...t, p };
}

describe('projects.docs', () => {
  it('returns internal docs and no repos for an internal project', () => {
    const { d, p } = setup();
    d.projects.update(p.id, { internalDocs: '# Notes\n\nWhy.' }, UI);
    expect(d.projects.docs(p.slug)).toEqual({
      projectId: p.id,
      source: 'internal',
      internal: '# Notes\n\nWhy.',
      repos: [],
    });
  });

  it('returns the cached content of every linked repo, null when not synced', () => {
    const { d, p } = setup({ repos: ['acme/a', 'acme/b'] });
    const [a] = d.projects.repoRows(p.id);
    d.db
      .update(projectRepos)
      .set({ docsContent: '# D1', docsUpdatedAt: t.clock.now, docsOrigin: 'hook' })
      .where(eq(projectRepos.id, a!.id))
      .run();
    const docs = d.projects.docs('acme/b');
    expect(docs.source).toBe('repo');
    expect(docs.repos.map((r) => [r.fullName, r.docsPath, r.content])).toEqual([
      ['acme/a', 'DECISIONS.md', '# D1'],
      ['acme/b', 'DECISIONS.md', null],
    ]);
    expect(docs.repos[0]!.docsUpdatedAt).toBe(new Date(t.clock.now).toISOString());
  });

  it('fails with not_found for an unknown project', () => {
    const { d } = setup();
    expectDomainError(() => d.projects.docs('nope'), 'not_found');
  });
});

describe('export.build', () => {
  it('contains roadmap, docs, materials, files and diary in Markdown and JSON', async () => {
    const { d, p } = setup({ tags: ['electronics'], description: 'A welder.' });
    const [design] = p.phases;
    const task = design!.tasks[0]!;
    d.roadmap.completeTask(task.id, UI);
    d.projects.update(p.id, { internalDocs: '# Decisions\n\n## D1 — Pick\n\nBecause.' }, UI);
    d.materials.add(p.id, { name: 'Cap | 10uF', quantity: 2, unit: 'pcs', price: 1.5 }, UI);
    d.diary.addNote(p.id, { body: '# Heading\n\nFirst note.' }, CLAUDE);
    const f = await d.files.ingest(
      p.id,
      { tempPath: writeTemp(d, 'hello'), originalName: '../../etc/pass wd.txt', caption: null },
      UI,
    );

    const x = d.export.build(p.slug);
    expect(x.slug).toBe(p.slug);
    expect(x.files).toEqual([
      { zipPath: `files/${f.id}-pass_wd.txt`, absPath: d.files.open(f.id).path },
    ]);

    const md = x.markdown;
    expect(md.startsWith('# Spot Welder\n')).toBe(true);
    expect(md).toContain(String.raw`* [x] \#${task.id} Schematic`); // the writer escapes a leading #
    expect(md).toContain(String.raw`* [ ] \#${design!.tasks[1]!.id} BOM`);
    // Embedded headings are demoted below the export's own sections.
    expect(md).toContain('### Decisions');
    expect(md).toContain('#### D1 — Pick');
    expect(md).toContain('### Heading');
    expect(md).toContain('| Cap \\| 10uF | 2 pcs | 1.5 EUR | to_buy |');
    expect(md).toContain(`[pass wd.txt](files/${f.id}-pass_wd.txt)`);
    expect(md).toContain('First note.');
    expect(md.endsWith('\n')).toBe(true);

    expect(x.json).toMatchObject({
      format: 'heph-project-export',
      version: 1,
      project: { id: p.id, slug: p.slug, tags: ['electronics'] },
      docs: { source: 'internal' },
    });
    expect(x.json.materials).toHaveLength(1);
    expect(x.json.files).toEqual([
      expect.objectContaining({ id: f.id, exportPath: `files/${f.id}-pass_wd.txt` }),
    ]);
    // Oldest first: creation event, then the note, then the upload event.
    const ids = x.json.diary.map((e) => e.id);
    expect(ids).toEqual([...ids].sort((a, b) => a - b));
    const noteAt = x.json.diary.findIndex((e) => e.body.includes('First note.'));
    expect(noteAt).toBeGreaterThan(0);
    expect(x.json.diary.at(-1)!.body).toContain('pass wd.txt');
  });

  it('lists a file missing on disk without exporting it', async () => {
    const { d, p } = setup();
    const f = await d.files.ingest(
      p.id,
      { tempPath: writeTemp(d, 'x'), originalName: 'gone.txt', caption: 'Gone' },
      UI,
    );
    fs.rmSync(d.files.open(f.id).path);
    const x = d.export.build(p.id);
    expect(x.files).toEqual([]);
    expect(x.json.files[0]!.exportPath).toBeNull();
    expect(x.markdown).toContain('Gone (missing on disk, not exported)');
  });

  it('exports every diary entry across pages, including equal timestamps', () => {
    const { d, p, clock } = setup();
    for (let i = 0; i < 1200; i++) {
      if (i % 3 === 0) clock.advance(1);
      d.diary.addNote(p.id, { body: `note ${i}` }, UI);
    }
    const all = d.export.build(p.id).json.diary;
    const notes = all.filter((e) => e.type === 'note').map((e) => e.body);
    expect(notes).toHaveLength(1200);
    expect(new Set(all.map((e) => e.id)).size).toBe(all.length);
    expect(notes[0]).toBe('note 0');
    expect(notes.at(-1)).toBe('note 1199');
  });

  it('renders repo docs per repo and an empty project without crashing', () => {
    const { d } = setup();
    const p = d.projects.create({ name: 'Empty', repos: ['acme/x'] }, UI);
    const md = d.export.build(p.id).markdown;
    expect(md).toContain('No phases.');
    expect(md).toContain('### acme/x: DECISIONS.md');
    expect(md).toContain('Not synced yet.');
    expect(md).toContain('## Materials\n\nNone.');
    expect(md).toContain('## Files\n\nNone.');
  });
});

describe('safeName', () => {
  it.each([
    ['photo.jpg', 'photo.jpg'],
    ['../../evil.sh', 'evil.sh'],
    ['C:\\dir\\file name.txt', 'file_name.txt'],
    ['...hidden', 'hidden'],
    ['', 'file'],
    ['..', 'file'],
    ['città è.png', 'citt___.png'],
  ])('%j → %j', (input, expected) => {
    expect(safeName(input)).toBe(expected);
  });

  it('keeps at most 100 characters including the extension', () => {
    const out = safeName(`${'a'.repeat(300)}.txt`);
    expect(out).toHaveLength(100);
    expect(out.endsWith('.txt')).toBe(true);
  });
});

describe('demote', () => {
  /** Heading depths in document order, from a real parse. */
  const depths = (md: string): number[] => {
    const out: number[] = [];
    const walk = (n: Nodes) => {
      if (n.type === 'heading') out.push(n.depth);
      if ('children' in n) for (const c of n.children) walk(c);
    };
    walk(fromMarkdown(md));
    return out;
  };

  it.each([
    ['# A', [3]],
    ['#### D', [6]],
    ['##### E', [6]],
    ['   # Indented', [3]],
    ['#NoSpace', []],
    ['Title\n=====', [3]],
    ['Sub\n---', [4]],
    ['- item\n---', []],
    ['> # Quoted', [3]],
    ['- # Listed', [3]],
    ['# A\r\n## B\rC\n=', [3, 4, 3]],
  ])('%j → depths %j', (input, expected) => {
    expect(depths(demote(input))).toEqual(expected);
  });

  it('writes ATX headings and keeps fenced code content', () => {
    expect(demote('Title\n=====')).toBe('### Title');
    const md = ['````', '# in', '```', '# still in', '````', '# out'].join('\n');
    expect(demote(md)).toBe(
      ['````', '# in', '```', '# still in', '````', '', '### out'].join('\n'),
    );
  });

  it('closes a fence left open so later content is not swallowed', () => {
    const out = demote('text\n~~~~\ncode');
    expect(depths(`${out}\n\n## After`)).toEqual([2]);
  });

  it('leaves raw HTML as it is', () => {
    expect(demote('<!--\n```\n-->')).toBe('<!--\n```\n-->');
  });
});

describe('export Markdown escaping', () => {
  it('demotes descriptions and task notes and escapes link URLs', () => {
    const { d } = setup();
    const p = d.projects.create(
      {
        name: 'Esc',
        description: '# Big',
        links: [{ label: 'Wiki [x]', url: 'https://example.com/a_(b) c' }],
        phases: [{ title: 'P', description: 'Phase\n===', tasks: ['T'] }],
      },
      UI,
    );
    const task = p.phases[0]!.tasks[0]!;
    d.roadmap.updateTask(task.id, { notes: '## Note heading' }, UI);
    const md = d.export.build(p.id).markdown;
    expect(md.match(/^# /gm)).toHaveLength(1);
    expect(md).toContain('\n### Big\n');
    expect(md).toContain('\n### Phase\n');
    expect(md).toContain('  #### Note heading');
    expect(md).toContain(String.raw`* Link: [Wiki \[x\]](https://example.com/a_%28b%29%20c)`);
  });
});
