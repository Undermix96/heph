// Independent verification of the project export, round 10. Invented data only.
// Focus: criterion 4 (heading invariant with hostile content in every field, HTML edge
// cases) and criterion 5 (round trip of demote, HTML conversions per D53).
import fs from 'node:fs';
import { eq } from 'drizzle-orm';
import type { Nodes, Root } from 'mdast';
import { fromMarkdown } from 'mdast-util-from-markdown';
import { gfmFromMarkdown } from 'mdast-util-gfm';
import { gfm } from 'micromark-extension-gfm';
import { afterEach, describe, expect, it } from 'vitest';
import { UI } from './context.js';
import { files as filesTable, projectRepos } from './db/schema.js';
import { demote } from './export.js';
import { seedProject, writeTemp } from './test/fixtures.js';
import { makeDomain, type TestDomain } from './test/helpers.js';

let t: TestDomain | undefined;
afterEach(() => {
  t?.cleanup();
  t = undefined;
});

const SECTIONS = ['Project', 'Roadmap', 'Documentation', 'Materials', 'Files', 'Diary'];
const MARKER = 'LASTMARKERZZ';

function parse(md: string): Root {
  return fromMarkdown(md, { extensions: [gfm()], mdastExtensions: [gfmFromMarkdown()] });
}

function plain(n: Nodes): string {
  if ('value' in n && typeof n.value === 'string') return n.value;
  return 'children' in n ? n.children.map((c) => plain(c as Nodes)).join('') : '';
}

function rng(seed: number) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let r = Math.imul(a ^ (a >>> 15), 1 | a);
    r = (r + Math.imul(r ^ (r >>> 7), 61 | r)) ^ r;
    return ((r ^ (r >>> 14)) >>> 0) / 4294967296;
  };
}

// ------------------------------------------------------------------ HTML edge cases

/** Raw HTML snippets, closed and unclosed, per CommonMark 0.31 html block types 1-7. */
const HTML: string[] = [
  '<!-->',
  '<!--->',
  '<!---->',
  '<!-- a -- b -->',
  '<!-- x --',
  '<!--',
  '-->',
  '<script>\nx\n</script >',
  '<script>\nx\n</script\t>',
  '<textarea>\nx\n</textarea\n>',
  '<style>\nx\n</style  >',
  '<pre>\nx\n</ pre>',
  '<SCRIPT>\nx\n</SCRIPT>',
  '<Pre>\n# x',
  '<STYLE type="a">\n# x',
  '<pre>\n# x\n</script>',
  '<script>\n# x\n</pre>',
  '<?php echo 1 ?>',
  '<?>',
  '<?x ?',
  '<![CDATA[ x ]]>',
  '<![CDATA[ x ]>',
  '<!DOCTYPE html>',
  '<!DOCTYPE',
  '<!x',
  '<div>\n# raw\n</div>',
  '<DIV>\n# raw',
  '<del>\n\n# a\n\n</del>',
  '<a href="x">\n# a',
  '| a | b |\n|---|---|\n| <!-- x | y |',
  '| a | b |\n|---|---|\n| <span>x</span> | <SCRIPT> |',
  '| a |\n|---|\n| <!-- c --> |',
  '[a <span\nb>](https://e.com)',
  '*a <span\nb>*',
  '**a <!--\nb -->**',
  '[a <!--\n# x\n-->](https://e.com)',
  'a <span\n    # x>',
  'x <!-- inline\n-->',
  'x <![CDATA[\n]]>',
  'x <?a\n?>',
  'x <!A\n>',
  '> <!--\n> # x',
  '- <pre>\n  # x',
  '1. <script>\n   # x\n   </script >',
  '<!-- a -->\n<!-- b',
  '<pre>\n</pre>\n<pre>',
];

/** Wraps a snippet in a container so it is a child of blockquote / listItem. */
const WRAP: ((s: string) => string)[] = [
  (s) => s,
  (s) =>
    s
      .split('\n')
      .map((l) => `> ${l}`)
      .join('\n'),
  (s) =>
    s
      .split('\n')
      .map((l, i) => (i ? `  ${l}` : `- ${l}`))
      .join('\n'),
  (s) => `Intro paragraph\n\n${s}\n\nOutro paragraph`,
];

/** Oracle independent of export.ts: an HTML block is closed when a later paragraph survives. */
function htmlClosed(value: string): boolean {
  const last = parse(`${value}\n\nSENTINELQQ`).children.at(-1);
  return last?.type === 'paragraph' && plain(last) === 'SENTINELQQ';
}

const FLOW = new Set(['root', 'blockquote', 'listItem', 'footnoteDefinition']);
const ws = (s: string) => s.replace(/\s+/g, ' ').trim();

/**
 * Normalised tree. For the original, applies the D53 conversions (unclosed HTML blocks
 * to html code, inline HTML spanning lines to inline code); ignores positions, heading
 * depths, list spread and whitespace inside html/inline code (known, D53).
 */
function norm(n: Nodes, parent: string | null, original: boolean): unknown {
  let node: Nodes = n;
  if (original && n.type === 'html') {
    if (parent && FLOW.has(parent) && !htmlClosed(n.value))
      node = { type: 'code', lang: 'html', meta: null, value: n.value };
    else if (!(parent && FLOW.has(parent)) && n.value.includes('\n'))
      node = { type: 'inlineCode', value: n.value };
  }
  const o: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(node)) {
    if (k === 'position' || k === 'spread' || k === 'children') continue;
    if (k === 'depth' && node.type === 'heading') continue;
    if (
      k === 'value' &&
      (node.type === 'html' || node.type === 'inlineCode' || node.type === 'code')
    )
      o[k] = ws(String(v));
    else o[k] = v;
  }
  if ('children' in node)
    o.children = (node.children as Nodes[]).map((c) => norm(c, node.type, original));
  return o;
}

function depths(n: Nodes): number[] {
  const out: number[] = [];
  const w = (x: Nodes) => {
    if (x.type === 'heading') out.push(x.depth);
    if ('children' in x) for (const c of x.children) w(c as Nodes);
  };
  w(n);
  return out;
}

function roundTripDiff(md: string): string | null {
  const before = parse(md);
  const out = demote(md);
  const after = parse(out);
  const a = JSON.stringify(norm(after, null, false));
  const b = JSON.stringify(norm(before, null, true));
  const da = depths(after);
  const db = depths(before).map((d) => Math.min(6, d + 2));
  if (a === b && JSON.stringify(da) === JSON.stringify(db)) return null;
  return `${JSON.stringify(md)}\n  -> ${JSON.stringify(out)}`;
}

describe('verify10 demote round trip on HTML edge cases', () => {
  it('every HTML snippet in every container: parse(demote(x)) == parse(x) modulo D53 conversions', () => {
    const fails: string[] = [];
    for (const h of HTML)
      for (const w of WRAP) {
        const d = roundTripDiff(w(h));
        if (d) fails.push(d);
      }
    expect(fails, fails.join('\n')).toEqual([]);
  });

  it('demote never leaves an HTML block that swallows a following paragraph', () => {
    const fails: string[] = [];
    for (const h of HTML)
      for (const w of WRAP) {
        const out = demote(w(h));
        const last = parse(`${out}\n\n${MARKER}`).children.at(-1);
        if (!(last?.type === 'paragraph' && plain(last) === MARKER))
          fails.push(`${JSON.stringify(w(h))} -> ${JSON.stringify(out)}`);
      }
    expect(fails, fails.join('\n')).toEqual([]);
  });

  // CommonMark 0.31 type 1 end condition: the line contains `</script>` (no whitespace).
  it.each([
    ['</script >', '<script>\nx\n</script >'],
    ['</script\\t>', '<script>\nx\n</script\t>'],
    ['</textarea\\n>', '<textarea>\nx\n</textarea\n>'],
    ['</style  >', '<style>\nx\n</style  >'],
  ])('a raw block closed only by %s is unclosed and must become code', (_n, md) => {
    expect(htmlClosed(md)).toBe(false);
    const out = demote(md);
    const last = parse(`${out}\n\n${MARKER}`).children.at(-1);
    expect(last?.type === 'paragraph' && plain(last) === MARKER, out).toBe(true);
  });
});

// ------------------------------------------------------------------ hostile fields

const ATOMS = [
  '# H',
  '## Roadmap',
  '<!--',
  '-->',
  '<script>',
  '</script>', // the whitespace variant is bug class A, pinned separately
  '<pre>',
  '<?',
  '?>',
  '<![CDATA[',
  ']]>',
  '<!X',
  '`',
  '```',
  '~~~',
  '[x]: https://e.com',
  '[^1]: f',
  '[^1]',
  '| a |',
  '|',
  '\\',
  '*',
  '**',
  '_',
  '- x',
  '1. x',
  '1)',
  '> q',
  '===',
  '---',
  '[',
  ']',
  '](',
  '![',
  '<https://e.com',
  '<',
  '>',
  '&amp;',
  '&#35;',
  '\n# NL',
  '\r# CR',
  '\r\n## CRLF',
  ' # LS',
  '\t',
  '    ',
  '<div>',
  '<DIV>',
  '<a href="x">',
  '~~',
  '$$',
  ':::',
  '+',
  '#',
  '\u0000',
  'é日本\u{1F600}',
];

function hostileLine(rand: () => number): string {
  const n = 1 + Math.floor(rand() * 5);
  let s = '';
  for (let i = 0; i < n; i++)
    s += ATOMS[Math.floor(rand() * ATOMS.length)]! + (rand() < 0.5 ? ' ' : '');
  return s.trim() || '#';
}

/**
 * The fuzz pool leaves out raw blocks "closed" by an end tag with whitespace: that bug
 * class is pinned by the dedicated tests above, so the fuzz can find other classes.
 */
const FUZZ_HTML = HTML.filter((h) => !/<\/(script|style|textarea)\s+>/i.test(h));

function hostileBlock(rand: () => number): string {
  const parts: string[] = [];
  const n = 1 + Math.floor(rand() * 4);
  for (let i = 0; i < n; i++) {
    const r = rand();
    if (r < 0.4)
      parts.push(
        WRAP[Math.floor(rand() * WRAP.length)]!(FUZZ_HTML[Math.floor(rand() * FUZZ_HTML.length)]!),
      );
    else parts.push(hostileLine(rand));
  }
  return parts.join(rand() < 0.5 ? '\n' : '\n\n');
}

interface Built {
  md: string;
  phases: { id: number; title: string; tasks: { id: number; done: boolean }[] }[];
  diaryCount: number;
}

async function buildHostile(rand: () => number): Promise<Built> {
  t?.cleanup();
  t = makeDomain();
  const L = () => hostileLine(rand);
  const B = () => hostileBlock(rand);
  const CUR = ['<!-', '\n# ', '|#`', '<pr', '[^1', '\\|*', '-->', '```'];
  t.d.settings.update({ currency: CUR[Math.floor(rand() * CUR.length)] }, UI);
  const p = seedProject(t.d, {
    name: L(),
    description: B(),
    tags: [L().slice(0, 50), L().slice(0, 50)],
    links: [{ label: L(), url: 'https://example.com/a(b)c' }],
    phases: [
      { title: L(), description: B(), tasks: [L(), L()] },
      { title: L(), description: B(), tasks: [L()] },
    ],
    repos: [{ fullName: 'acme/a', docsPath: L() }],
    statusNote: B(),
  });
  // Repo full names are validated on input; set a hostile one in the DB to test escaping.
  const [repo] = t.d.projects.repoRows(p.id);
  t.d.db
    .update(projectRepos)
    .set({
      fullName: `acme/${L()}`,
      docsContent: B(),
      docsUpdatedAt: t.clock.now,
      docsOrigin: 'hook',
    })
    .where(eq(projectRepos.id, repo!.id))
    .run();
  if (rand() < 0.5) t.d.projects.update(p.id, { internalDocs: B() }, UI);
  else t.d.projects.update(p.id, { docsSource: 'repo' }, UI);
  for (const ph of p.phases)
    for (const task of ph.tasks) t.d.roadmap.updateTask(task.id, { notes: B() }, UI);
  t.d.roadmap.completeTask(p.phases[0]!.tasks[0]!.id, UI);
  t.d.materials.add(
    p.id,
    { name: L(), unit: L().slice(0, 30), quantity: 2, price: 3.5, link: 'https://example.com/m|x' },
    UI,
  );
  t.d.materials.add(p.id, { name: L(), unit: L().slice(0, 30) }, UI);
  const e1 = t.d.diary.addNote(p.id, { body: B() }, UI);
  t.clock.advance(1000);
  const f1 = await t.d.files.ingest(
    p.id,
    { tempPath: writeTemp(t.d, 'abc'), originalName: 'a.bin', target: { diaryEntryId: e1.id } },
    UI,
  );
  t.d.files.update(f1.id, { caption: L() }, UI);
  const f2 = await t.d.files.ingest(
    p.id,
    { tempPath: writeTemp(t.d, 'def'), originalName: 'b.bin' },
    UI,
  );
  fs.rmSync(t.d.files.open(f2.id).path); // missing on disk
  // A hostile original name stored directly (ingest may normalise it).
  // Ingest derives the storage extension from the name (Windows rejects some characters).
  for (const id of [f1.id, f2.id])
    t.d.db.update(filesTable).set({ originalName: L() }).where(eq(filesTable.id, id)).run();
  t.clock.advance(1000);
  t.d.diary.addNote(p.id, { body: B() }, UI);
  t.clock.advance(1000);
  t.d.diary.addNote(p.id, { body: MARKER }, UI);
  const x = t.d.export.build(p.id);
  return {
    md: x.markdown,
    phases: x.json.project.phases.map((ph) => ({
      id: ph.id,
      title: ph.title,
      tasks: ph.tasks.map((tk) => ({ id: tk.id, done: tk.done })),
    })),
    diaryCount: x.json.diary.length,
  };
}

/** Checks criterion 4 on a full export; returns the problems found. */
function invariantProblems(b: Built): string[] {
  const probs: string[] = [];
  const root = parse(b.md);
  const all: { depth: number; text: string; top: boolean }[] = [];
  const walk = (n: Nodes, top: boolean) => {
    if (n.type === 'heading') all.push({ depth: n.depth, text: plain(n).trim(), top });
    if ('children' in n) for (const c of n.children) walk(c as Nodes, false);
  };
  for (const c of root.children) walk(c, true);
  const h1 = all.filter((h) => h.depth === 1);
  if (h1.length !== 1 || root.children[0]?.type !== 'heading')
    probs.push(`H1s: ${JSON.stringify(h1)}`);
  const h2 = all.filter((h) => h.depth === 2);
  if (JSON.stringify(h2.map((h) => h.text)) !== JSON.stringify(SECTIONS) || !h2.every((h) => h.top))
    probs.push(`H2s: ${JSON.stringify(h2)}`);
  const last = root.children.at(-1);
  if (!(last?.type === 'paragraph' && plain(last) === MARKER))
    probs.push('last diary marker swallowed');

  // Sections by top-level heading index.
  const kids = root.children;
  const idx = (name: string) =>
    kids.findIndex((k) => k.type === 'heading' && k.depth === 2 && plain(k).trim() === name);
  const roadmap = kids.slice(idx('Roadmap') + 1, idx('Documentation'));
  // Each phase: its own top-level depth-3 heading "<pos>. ... (status, d/t)".
  const phaseHeads = roadmap.filter(
    (k) =>
      k.type === 'heading' &&
      k.depth === 3 &&
      /^\d+\. .*\((todo|in_progress|done|[a-z_]+), \d+\/\d+\)$/.test(plain(k).trim()),
  );
  if (phaseHeads.length !== b.phases.length)
    probs.push(`phase headings: ${phaseHeads.length} of ${b.phases.length}`);
  // Each task: its own item in a top-level list. Revised by the author on 2026-11-25
  // (D53, single-pass writer): the writer may pick `*` or `-`, so the bullet is not checked.
  const items: { id: number; checked: boolean | null | undefined }[] = [];
  for (const k of roadmap) {
    if (k.type !== 'list') continue;
    for (const li of k.children) {
      const para = li.children[0];
      const m = para && para.type === 'paragraph' ? /^#(\d+) /.exec(plain(para)) : null;
      if (m) items.push({ id: Number(m[1]), checked: li.checked });
    }
  }
  const want = b.phases.flatMap((ph) => ph.tasks.map((tk) => ({ id: tk.id, checked: tk.done })));
  if (JSON.stringify(items) !== JSON.stringify(want))
    probs.push(`task items: ${JSON.stringify(items)} want ${JSON.stringify(want)}`);
  // Each diary entry: its own top-level depth-3 heading.
  const diary = kids.slice(idx('Diary') + 1);
  const dh = diary.filter(
    (k) => k.type === 'heading' && k.depth === 3 && /^\d{4}-\d\d-\d\dT.* · .* · /.test(plain(k)),
  );
  if (dh.length !== b.diaryCount) probs.push(`diary headings: ${dh.length} of ${b.diaryCount}`);
  return probs;
}

describe('verify10 full export with hostile content in every field', () => {
  it('300 generated projects keep one H1, the six H2s, phase headings, task items, diary headings', async () => {
    const rand = rng(Number(process.env.V10_SEED ?? 10_010));
    const fails: string[] = [];
    for (let i = 0; i < 300 && fails.length < 5; i++) {
      const b = await buildHostile(rand);
      const p = invariantProblems(b);
      if (p.length) fails.push(`#${i}: ${p.join('; ')}\n${b.md.slice(0, 3000)}`);
    }
    expect(fails, fails.join('\n\n=====\n\n')).toEqual([]);
  }, 120_000);

  it('an HTML comment opened in one field and closed in a later field swallows nothing', () => {
    t = makeDomain();
    const p = seedProject(t.d, {
      description: 'Intro <!--',
      phases: [{ title: 'P', description: '<!-- open', tasks: ['T'] }],
    });
    t.d.roadmap.updateTask(p.phases[0]!.tasks[0]!.id, { notes: 'x --> after' }, UI);
    t.d.projects.update(p.id, { internalDocs: '-->\n# Docs H' }, UI);
    t.d.diary.addNote(p.id, { body: MARKER }, UI);
    const x = t.d.export.build(p.id);
    const probs = invariantProblems({
      md: x.markdown,
      phases: x.json.project.phases.map((ph) => ({
        id: ph.id,
        title: ph.title,
        tasks: ph.tasks.map((tk) => ({ id: tk.id, done: tk.done })),
      })),
      diaryCount: x.json.diary.length,
    });
    expect(probs, x.markdown).toEqual([]);
  });

  it.each([
    ['</script >', '<script>\nx\n</script >'],
    ['</textarea\\n>', '<textarea>\nx\n</textarea\n>'],
  ])(
    'a description whose raw block is "closed" by %s does not swallow later sections',
    (_n, description) => {
      t = makeDomain();
      const p = seedProject(t.d, { description });
      t.d.diary.addNote(p.id, { body: MARKER }, UI);
      const x = t.d.export.build(p.id);
      const probs = invariantProblems({
        md: x.markdown,
        phases: x.json.project.phases.map((ph) => ({
          id: ph.id,
          title: ph.title,
          tasks: ph.tasks.map((tk) => ({ id: tk.id, done: tk.done })),
        })),
        diaryCount: x.json.diary.length,
      });
      expect(probs, x.markdown).toEqual([]);
    },
  );
});

// ------------------------------------------------------------------ bug B (found by round 10)

// A list item whose first line is blank holds an HTML block indented one space more than
// the item content. The serializer writes it right after the marker ("-  <div>"), which
// raises the item's content indent, so the block's later lines leave the item and become a
// new top-level HTML block that is never closed.
describe('verify10 HTML block in a list item that starts with a blank line', () => {
  it.each([
    ['bullet', '- \n   <div>\n  <!--'],
    ['ordered', '1. \n    <div>\n   <!--\n   # x'],
    ['ordered, pre', '1. \n    <div>\n   <pre>'],
  ])('%s: demote output does not swallow a following paragraph', (_n, md) => {
    // The input itself ends the HTML block with the list item.
    const outside = parse(`${md}\n\n${MARKER}`).children.at(-1);
    expect(outside?.type === 'paragraph' && plain(outside) === MARKER).toBe(true);
    const out = demote(md);
    const last = parse(`${out}\n\n${MARKER}`).children.at(-1);
    expect(last?.type === 'paragraph' && plain(last) === MARKER, JSON.stringify(out)).toBe(true);
  });

  it('in task notes and the project description of a full export', () => {
    t = makeDomain();
    const p = seedProject(t.d, { description: '- \n   <div>\n  <!--' });
    t.d.roadmap.updateTask(p.phases[0]!.tasks[0]!.id, { notes: '1. \n    <div>\n   <!--' }, UI);
    t.d.diary.addNote(p.id, { body: MARKER }, UI);
    const x = t.d.export.build(p.id);
    const probs = invariantProblems({
      md: x.markdown,
      phases: x.json.project.phases.map((ph) => ({
        id: ph.id,
        title: ph.title,
        tasks: ph.tasks.map((tk) => ({ id: tk.id, done: tk.done })),
      })),
      diaryCount: x.json.diary.length,
    });
    expect(probs, x.markdown).toEqual([]);
  });
});

// ------------------------------------------------------------------ class C (round trip)

// CommonMark ends a type 1 block at any of </pre>, </script>, </style>, </textarea>, and
// micromark ends "<?>" at once. demote turns these closed blocks into html code blocks,
// a round-trip difference D53 does not list (it converts only blocks that never end).
describe('verify10 closed HTML blocks are kept as HTML', () => {
  it.each([
    ['<pre> closed by </script>', '<pre>\n# x\n</script>'],
    ['<script> closed by </pre>', '<script>\n# x\n</pre>'],
    ['empty processing instruction', '<?>'],
  ])('%s', (_n, md) => {
    expect(htmlClosed(md)).toBe(true);
    expect(parse(demote(md)).children[0]?.type).toBe('html');
  });
});

// ------------------------------------------------------------------ class D (round trip)

// Inline HTML at the start of an indented continuation line: the serializer joins the
// lines with a space so the tag cannot start an HTML block. Renders the same, but the
// text node changes ("done\n" -> "done "), a difference D53 does not list.
describe('verify10 soft line break before inline HTML', () => {
  // Accepted limitation (D53, 2026-11-25): renders the same, the writer joins the lines.
  it.fails.each([
    ['div', 'done\n    <div>'],
    ['comment', 'a\n    <!-- x -->'],
  ])('%s: the line break survives the round trip', (_n, md) => {
    expect(JSON.stringify(norm(parse(demote(md)), null, false))).toBe(
      JSON.stringify(norm(parse(md), null, true)),
    );
  });
});
