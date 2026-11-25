// Independent verification of the project export, round 11. Invented data only.
// Focus: criterion 2 (heading and list invariant of the full export, D53) in contexts the
// post-write check does not model: text without raw HTML (the check is skipped), task notes
// indented under a list item (the check parses at the root), and the export's own `*` lists.
import type { Nodes, Root } from 'mdast';
import { fromMarkdown } from 'mdast-util-from-markdown';
import { gfmFromMarkdown } from 'mdast-util-gfm';
import { gfm } from 'micromark-extension-gfm';
import { afterEach, describe, expect, it } from 'vitest';
import { UI } from './context.js';
import { demote } from './export.js';
import { seedProject, writeTemp } from './test/fixtures.js';
import { makeDomain, type TestDomain } from './test/helpers.js';

let t: TestDomain | undefined;
afterEach(() => {
  t?.cleanup();
  t = undefined;
});

const SECTIONS = ['Project', 'Roadmap', 'Documentation', 'Materials', 'Files', 'Diary'];

function parse(md: string): Root {
  return fromMarkdown(md, { extensions: [gfm()], mdastExtensions: [gfmFromMarkdown()] });
}

function plain(n: Nodes): string {
  if ('value' in n && typeof n.value === 'string') return n.value;
  return 'children' in n ? n.children.map((c) => plain(c as Nodes)).join('') : '';
}

function highHeadings(md: string): string[] {
  const out: string[] = [];
  const walk = (n: Nodes) => {
    if (n.type === 'heading' && n.depth <= 2) out.push(`${n.depth}:${plain(n).trim()}`);
    if ('children' in n) for (const c of n.children) walk(c as Nodes);
  };
  walk(parse(md));
  return out;
}

/** Top-level lists written with `*` (the export's own lists), as arrays of item texts. */
function expectSections(md: string, name = 'Spot Welder') {
  expect(highHeadings(md), md).toEqual([`1:${name}`, ...SECTIONS.map((s) => `2:${s}`)]);
}

// ------------------------------------------------------------------ bug 1

// A footnote reference written at the start of a line (the line break comes from a
// character reference such as `&#10;` or `&#13;`) is followed by ":" and becomes a new
// footnote definition, whose content can be a level-1/2 heading. The text has no raw
// HTML, so the post-write check of D53 does not run.
describe('verify11 footnote reference after a character-reference line break', () => {
  it.each([
    ['&#10; and H1', '[^1]: d\n\nx&#10;[^1]: # Evil'],
    ['&#xA; and H2', '[^1]: d\n\nx&#xA;[^1]: ## Evil'],
    ['&#13; (bare CR in the output) and H2', '[^1]: d\n\nx&#13;[^1]:## Evil'],
  ])('%s: demote adds no level-1/2 heading', (_n, md) => {
    expect(highHeadings(md)).toEqual([]);
    const out = demote(md);
    expect(highHeadings(out), JSON.stringify(out)).toEqual([]);
  });

  it('in a diary body of a full export', () => {
    t = makeDomain();
    const p = seedProject(t.d);
    t.d.diary.addNote(p.id, { body: '[^1]: d\n\nx&#10;[^1]: # Evil' }, UI);
    expectSections(t.d.export.build(p.id).markdown);
  });
});

// ------------------------------------------------------------------ bug 2

// Task notes are indented by two spaces under their `*` item, but the post-write check
// parses the text at the root. A tab kept verbatim inside raw HTML expands differently
// after the two spaces: at the root "\t<p" opens an HTML block that holds the "#" line,
// under the item it is indented code and the "# Evil" line becomes a level-1 heading.
describe('verify11 tab inside raw HTML in task notes', () => {
  it('task notes cannot add a level-1 heading', () => {
    t = makeDomain();
    const p = seedProject(t.d);
    t.d.roadmap.updateTask(p.phases[0]!.tasks[0]!.id, { notes: '* >\n  \t<p\n  # Evil' }, UI);
    expectSections(t.d.export.build(p.id).markdown);
  });
});

// ------------------------------------------------------------------ bug 3

// Revised by the author on 2026-11-25 (D53, single-pass writer): the export is now one
// mdast tree written in one pass, so the writer may pick `*` or `-` for any list,
// user or export. Merging is a structural question, so these checks look at every
// top-level list regardless of its bullet, in the full export.
function topLists(md: string): string[][] {
  return parse(md)
    .children.filter((k) => k.type === 'list')
    .map((l) =>
      (l as { children: Nodes[] }).children.map((li) => {
        const first = (li as { children: Nodes[] }).children[0];
        return first ? plain(first) : '';
      }),
    );
}

describe('verify11 user lists do not merge with the export lists', () => {
  it.each([
    ['thematic break in the first item', '- ***'],
    ['second of two adjacent lists', '- a\n\n+ b'],
    ['star list', '* a\n* b'],
  ])('%s in a phase description: the task list holds only the tasks', (_n, md) => {
    t = makeDomain();
    const p = seedProject(t.d, {
      phases: [{ title: 'P', description: md, tasks: ['Schematic', 'BOM'] }],
    });
    const out = t.d.export.build(p.id).markdown;
    const ids = p.phases[0]!.tasks.map((x) => x.id);
    const taskList = topLists(out).find((l) => l.some((s) => s.startsWith(`#${ids[0]} `)));
    expect(taskList, out).toEqual([`#${ids[0]} Schematic`, `#${ids[1]} BOM`]);
  });

  it('phase description: the task list holds only the tasks', () => {
    t = makeDomain();
    const p = seedProject(t.d, {
      phases: [{ title: 'P', description: '- a\n\n+ b', tasks: ['Schematic', 'BOM'] }],
    });
    const md = t.d.export.build(p.id).markdown;
    const ids = p.phases[0]!.tasks.map((x) => x.id);
    const taskList = topLists(md).find((l) => l.some((s) => s.startsWith(`#${ids[0]} `)));
    expect(taskList, md).toEqual([`#${ids[0]} Schematic`, `#${ids[1]} BOM`]);
  });

  it('project description: the project facts list is not extended', () => {
    t = makeDomain();
    const p = seedProject(t.d, { description: '- ***' });
    const md = t.d.export.build(p.id).markdown;
    const facts = topLists(md).find((l) => l[0]?.startsWith('Slug:'));
    expect(facts?.at(-1), md).toMatch(/^Created: /);
  });

  it('diary body: the attached-files list holds only the files', async () => {
    t = makeDomain();
    const p = seedProject(t.d);
    const e = t.d.diary.addNote(p.id, { body: '- ***' }, UI);
    await t.d.files.ingest(
      p.id,
      { tempPath: writeTemp(t.d, 'abc'), originalName: 'a.bin', target: { diaryEntryId: e.id } },
      UI,
    );
    const md = t.d.export.build(p.id).markdown;
    const diary = md.slice(md.indexOf('## Diary'));
    const files = topLists(diary).find((l) => l.includes('a.bin'));
    expect(files, diary).toEqual(['a.bin']);
  });
});

// ------------------------------------------------------------------ speed (reported)

describe('verify11 speed (reported, generous bounds)', () => {
  const para = (i: number, html: boolean) =>
    `Paragraph ${i} with *emphasis*, **strong**, \`code\` and a [link](https://example.com/${i}).` +
    `${html ? ' Some <b>bold</b> and <span class="x">span</span>.' : ''}\n` +
    'Second line of the paragraph with more words to fill it up.\n\n' +
    `${i % 10 === 0 ? `## Heading ${i}\n\n- item a\n- item b\n\n` : ''}`;
  const prose = (bytes: number, html: boolean) => {
    let s = '';
    for (let i = 0; s.length < bytes; i++) s += para(i, html);
    return s.slice(0, bytes);
  };

  it('demote on 125 KB / 1 MB prose with and without inline HTML; build with 1000 entries', () => {
    const res: string[] = [];
    for (const [label, size, html] of [
      ['125 KB plain', 125_000, false],
      ['125 KB inline HTML', 125_000, true],
      ['1 MB plain', 1_000_000, false],
      ['1 MB inline HTML', 1_000_000, true],
    ] as const) {
      const src = prose(size, html);
      const t0 = performance.now();
      demote(src);
      res.push(`${label}: ${(performance.now() - t0).toFixed(0)} ms`);
    }
    t = makeDomain();
    const p = seedProject(t.d);
    for (let i = 0; i < 1000; i++)
      t.d.diary.addNote(p.id, { body: para(i, i % 2 === 0).repeat(3) }, UI);
    const t0 = performance.now();
    const md = t.d.export.build(p.id).markdown;
    res.push(
      `export.build, 1000 diary entries (${md.length} chars): ${(performance.now() - t0).toFixed(0)} ms`,
    );
    console.log(`[verify11 timing] ${res.join('; ')}`);
    expect(md.length).toBeGreaterThan(0);
  }, 300_000);
});
