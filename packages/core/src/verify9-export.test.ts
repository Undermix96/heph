// Independent verification of the project export, round 9. Invented data only.
// Focus: criterion 4 (demote round-trip semantics and the heading invariant of the
// full export) with a real CommonMark + GFM parser, criterion 5 (diary paging), speed.
import fs from 'node:fs';
import { eq } from 'drizzle-orm';
import type { Nodes, Root } from 'mdast';
import { fromMarkdown } from 'mdast-util-from-markdown';
import { gfmFromMarkdown } from 'mdast-util-gfm';
import { gfm } from 'micromark-extension-gfm';
import { afterEach, describe, expect, it } from 'vitest';
import { UI } from './context.js';
import { diaryEntries, projectRepos } from './db/schema.js';
import { demote } from './export.js';
import { seedProject, writeTemp } from './test/fixtures.js';
import { makeDomain, type TestDomain } from './test/helpers.js';

let t: TestDomain;
afterEach(() => t?.cleanup());

const SECTIONS = ['Project', 'Roadmap', 'Documentation', 'Materials', 'Files', 'Diary'];

// ------------------------------------------------------------------ parser oracle

function parse(md: string): Root {
  return fromMarkdown(md, { extensions: [gfm()], mdastExtensions: [gfmFromMarkdown()] });
}

function text(n: Nodes): string {
  if ('value' in n && typeof n.value === 'string') return n.value;
  return 'children' in n ? n.children.map((c) => text(c as Nodes)).join('') : '';
}

function headings(md: string): { depth: number; text: string; top: boolean }[] {
  const out: { depth: number; text: string; top: boolean }[] = [];
  const root = parse(md);
  const walk = (n: Nodes, top: boolean) => {
    if (n.type === 'heading') out.push({ depth: n.depth, text: text(n).trim(), top });
    if ('children' in n) for (const c of n.children) walk(c as Nodes, false);
  };
  for (const c of root.children) walk(c, true);
  return out;
}

/** Tree without positions; heading depths replaced by a marker when `dropDepth`. */
function strip(n: unknown, dropDepth: boolean): unknown {
  if (Array.isArray(n)) return n.map((x) => strip(x, dropDepth));
  if (n && typeof n === 'object') {
    const o: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(n)) {
      if (k === 'position') continue;
      if (dropDepth && k === 'depth' && (n as { type?: string }).type === 'heading') continue;
      o[k] = strip(v, dropDepth);
    }
    return o;
  }
  return n;
}

/** Heading depths in document order. */
function depthList(root: Nodes): number[] {
  const out: number[] = [];
  const walk = (n: Nodes) => {
    if (n.type === 'heading') out.push(n.depth);
    if ('children' in n) for (const c of n.children) walk(c as Nodes);
  };
  walk(root);
  return out;
}

// ------------------------------------------------------------------ generator

function rng(seed: number) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let r = Math.imul(a ^ (a >>> 15), 1 | a);
    r = (r + Math.imul(r ^ (r >>> 7), 61 | r)) ^ r;
    return ((r ^ (r >>> 14)) >>> 0) / 4294967296;
  };
}

/**
 * Hostile Markdown with nested containers. HTML blocks that only end at an explicit
 * marker (types 1-5) are generated closed here: unclosed ones are tested separately.
 */
function gen(rand: () => number, depth = 0): string {
  const pick = <T>(xs: T[]) => xs[Math.floor(rand() * xs.length)]!;
  const n = () => Math.floor(rand() * 99);
  const fence = () => pick(['`', '~']).repeat(3 + Math.floor(rand() * 2));
  const leaf: (() => string)[] = [
    () => `${'#'.repeat(1 + Math.floor(rand() * 6))} H${n()}`,
    () => `Para ${n()} with *em*, **strong**, \`code\`, ~~del~~ and a\\\nhard break`,
    () => `Setext ${n()}\n${pick(['===', '---', '='])}`,
    () => {
      const f = fence();
      return `${f}${pick(['', 'js', 'ts title="x"', 'md {1,3}'])}\n# not a heading\n\tTab\n${f}`;
    },
    () => `${fence()}\n# unclosed fence ${n()}`,
    () => `    indented code ${n()}\n    # still code`,
    () => '| a | b |\n|---|:-:|\n| 1 \\| 2 | `x|y` |\n| # c | d |',
    () => `Footnote ref[^f${n() % 3}].\n\n[^f${n() % 3}]: Footnote body\n    # in footnote`,
    () => `[ref${n() % 3}]: https://example.com/${n()} "Title"\n\n[link][ref${n() % 3}]`,
    () => '<div>\n# raw html heading\n</div>',
    () => '<!-- comment\n# inside comment\n```\n-->',
    () => '<pre>\n# inside pre\n</pre>',
    () => '<details><summary>x</summary>\n\n# real heading after blank\n\n</details>',
    () => '***',
    () => '- [ ] todo\n- [x] done',
    () => 'Unicode: café 日本 \u{1F600} ​ zero-width, RTL ‮ text',
    () => `Autolink <https://example.com/${n()}> and www.example.com and x@example.com`,
    () => '![img](a.png "t") [inline](https://e.com/(x) \'t\')',
    () => '\\# escaped hash and \\* star and \\[bracket\\]',
    () => '#nospace and #\ttab',
    () => '',
    () => '   ',
    () => '\t# tab-indented code',
    () => 'line\r\n# crlf heading\r\nmore',
    () => 'line\r# cr heading\rmore',
  ];
  const containers: ((inner: string) => string)[] = [
    (s) =>
      s
        .split(/\r\n|\r|\n/)
        .map((l) => `> ${l}`)
        .join('\n'),
    (s) =>
      s
        .split(/\r\n|\r|\n/)
        .map((l, i) => (i === 0 ? `- ${l}` : `  ${l}`))
        .join('\n'),
    (s) =>
      s
        .split(/\r\n|\r|\n/)
        .map((l, i) => (i === 0 ? `1. ${l}` : `   ${l}`))
        .join('\n'),
    // Lazy continuation: only the first line gets the marker.
    (s) => `> ${s}`,
    (s) => `* ${s}`,
  ];
  const blocks: string[] = [];
  const count = 1 + Math.floor(rand() * 6);
  for (let i = 0; i < count; i++) {
    if (depth < 3 && rand() < 0.35) blocks.push(pick(containers)(gen(rand, depth + 1)));
    else blocks.push(pick(leaf)());
  }
  const sep = pick(['\n\n', '\n', '\r\n\r\n', '\n\n\n']);
  return blocks.join(sep);
}

// ------------------------------------------------------------------ demote round trip

describe('verify9 demote: round-trip semantics with a real parser', () => {
  // Accepted limitation (D53, user decision 2026-11-25): mdast-util-to-markdown does not
  // round-trip this exactly. `it.fails` keeps the case visible and flags it once fixed.
  it.fails('parse(demote(x)) equals parse(x) except heading depths (3000 nested hostile cases)', () => {
    const rand = rng(9001);
    const failures: string[] = [];
    for (let i = 0; i < 3000; i++) {
      const md = gen(rand);
      const before = parse(md);
      const out = demote(md);
      const after = parse(out);
      const a = JSON.stringify(strip(after, true));
      const b = JSON.stringify(strip(before, true));
      if (a !== b) failures.push(`${JSON.stringify(md)}\n→ ${JSON.stringify(out)}`);
      expect(depthList(after)).toEqual(depthList(before).map((d) => Math.min(6, d + 2)));
    }
    expect(failures.slice(0, 5), `${failures.length} of 3000 differ`).toEqual([]);
  }, 60_000);

  // Split out of the `it.fails` loop above (fourth verification, 2026-11-25) so the
  // heading-depth check stays a real assertion.
  it('heading depths move down two levels, capped at 6 (3000 nested hostile cases)', () => {
    const rand = rng(9001);
    let fallbacks = 0;
    for (let i = 0; i < 3000; i++) {
      const md = gen(rand);
      const before = depthList(parse(md)).map((d) => Math.min(6, d + 2));
      const out = parse(demote(md));
      // D53 (single-pass writer, 2026-11-25): verbatim fallback, counted and bounded.
      const top = out.children;
      if (top.length === 1 && top[0]!.type === 'code' && top[0]!.lang === 'markdown') {
        fallbacks++;
        continue;
      }
      expect(depthList(out), JSON.stringify(md)).toEqual(before);
    }
    expect(fallbacks, 'verbatim fallbacks of 3000').toBeLessThan(300);
  }, 60_000);

  it('demote is idempotent on structure: demote(demote(x)) differs only by depth', () => {
    const rand = rng(77);
    for (let i = 0; i < 500; i++) {
      const md = gen(rand);
      const once = demote(md);
      const twice = demote(once);
      expect(JSON.stringify(strip(parse(twice), true))).toBe(
        JSON.stringify(strip(parse(once), true)),
      );
    }
  }, 30_000);

  it.each([
    ['empty', ''],
    ['whitespace only', ' \t \n\r\n '],
    ['only CR', '\r\r\r'],
    ['NUL character', 'a\u0000b'],
    ['BOM', '﻿# Title'],
    ['lone surrogate', 'x\uD800y'],
  ])('edge input %s: no throw and no depth-1/2 heading', (_name, md) => {
    const out = demote(md);
    expect(headings(out).filter((h) => h.depth <= 2)).toEqual([]);
  });

  it('raw HTML blocks are passed through unchanged (accepted limitation)', () => {
    for (const html of ['<div>\n# x\n</div>', '<!--\n# x\n-->', '<pre>\n# x\n</pre>']) {
      expect(demote(html)).toBe(html);
    }
  });
});

// ------------------------------------------------------------------ full export invariant

function assertInvariant(md: string, name: string, lastMarker: string) {
  const hs = headings(md);
  expect(
    hs.filter((h) => h.depth === 1).map((h) => h.text),
    md,
  ).toEqual([name]);
  const h2 = hs.filter((h) => h.depth === 2);
  expect(
    h2.map((h) => h.text),
    md,
  ).toEqual(SECTIONS);
  // Export sections must be real top-level headings, not nested in user containers.
  expect(h2.every((h) => h.top)).toBe(true);
  // Nothing swallowed: the last diary entry's marker is a top-level paragraph.
  const root = parse(md);
  const last = root.children.at(-1)!;
  expect(last.type === 'paragraph' && text(last) === lastMarker, md.slice(-400)).toBe(true);
}

async function hostileExport(rand: () => number) {
  t?.cleanup();
  t = makeDomain();
  const g = () => gen(rand);
  const p = seedProject(t.d, {
    name: 'Spot Welder',
    description: g(),
    phases: [
      { title: 'P1', description: g(), tasks: ['T1', 'T2'] },
      { title: 'P2', description: g(), tasks: ['T3'] },
    ],
    repos: ['acme/a'],
  });
  for (const ph of p.phases)
    for (const task of ph.tasks) t.d.roadmap.updateTask(task.id, { notes: g() }, UI);
  if (rand() < 0.5) {
    t.d.projects.update(p.id, { internalDocs: g() }, UI);
  } else {
    t.d.projects.update(p.id, { docsSource: 'repo' }, UI);
    const [r] = t.d.projects.repoRows(p.id);
    t.d.db
      .update(projectRepos)
      .set({ docsContent: g(), docsUpdatedAt: t.clock.now, docsOrigin: 'hook' })
      .where(eq(projectRepos.id, r!.id))
      .run();
  }
  for (let i = 0; i < 3; i++) {
    t.d.diary.addNote(p.id, { body: g().trim() || 'x' }, UI);
    t.clock.advance(1000);
  }
  t.d.diary.addNote(p.id, { body: 'LAST_MARKER' }, UI);
  return t.d.export.build(p.id).markdown;
}

describe('verify9 export: one H1, only the export H2s, nothing swallowed', () => {
  it('hostile nested content in every Markdown field (150 projects)', async () => {
    const rand = rng(31337);
    for (let i = 0; i < 150; i++) {
      assertInvariant(await hostileExport(rand), 'Spot Welder', 'LAST_MARKER');
    }
  }, 60_000);

  // Raw HTML blocks of types 1-5 run until an explicit end marker, or to the end of
  // the document. Passed through as is, an unclosed one swallows every later section.
  it.each([
    ['unclosed comment', '<!-- never closed'],
    ['unclosed pre', '<pre>\nnever closed'],
    ['unclosed script', '<script>\nnever closed'],
    ['unclosed CDATA', '<![CDATA[\nnever closed'],
    ['unclosed processing instruction', '<?php never closed'],
  ])('project description with %s does not swallow later sections', (_n, description) => {
    t = makeDomain();
    const p = seedProject(t.d, { description });
    t.d.diary.addNote(p.id, { body: 'LAST_MARKER' }, UI);
    assertInvariant(t.d.export.build(p.id).markdown, 'Spot Welder', 'LAST_MARKER');
  });

  it('diary body with an unclosed HTML comment does not swallow later entries', () => {
    t = makeDomain();
    const p = seedProject(t.d);
    t.d.diary.addNote(p.id, { body: 'x <!-- inline is fine' }, UI);
    t.clock.advance(1000);
    t.d.diary.addNote(p.id, { body: '<!-- block never closed' }, UI);
    t.clock.advance(1000);
    t.d.diary.addNote(p.id, { body: 'LAST_MARKER' }, UI);
    assertInvariant(t.d.export.build(p.id).markdown, 'Spot Welder', 'LAST_MARKER');
  });

  it('a tag containing a newline cannot add a heading', () => {
    t = makeDomain();
    const p = seedProject(t.d, { tags: ['ok', 'a\n# Evil tag'] });
    t.d.diary.addNote(p.id, { body: 'LAST_MARKER' }, UI);
    assertInvariant(t.d.export.build(p.id).markdown, 'Spot Welder', 'LAST_MARKER');
  });

  it('a repo docsPath containing a newline cannot add a heading', () => {
    t = makeDomain();
    const p = seedProject(t.d, { repos: [{ fullName: 'acme/a', docsPath: 'x.md\n# Evil' }] });
    t.d.projects.update(p.id, { docsSource: 'repo' }, UI);
    t.d.diary.addNote(p.id, { body: 'LAST_MARKER' }, UI);
    assertInvariant(t.d.export.build(p.id).markdown, 'Spot Welder', 'LAST_MARKER');
  });

  it('the currency setting cannot break the materials table or add a heading', () => {
    t = makeDomain();
    t.d.settings.update({ currency: '\n# ' }, UI);
    const p = seedProject(t.d);
    t.d.materials.add(p.id, { name: 'Wire', quantity: 1, price: 2 }, UI);
    t.d.diary.addNote(p.id, { body: 'LAST_MARKER' }, UI);
    assertInvariant(t.d.export.build(p.id).markdown, 'Spot Welder', 'LAST_MARKER');
  });

  it('a missing file named "# Evil.png" cannot add a heading (Files and Diary lists)', async () => {
    t = makeDomain();
    const p = seedProject(t.d);
    const f = await t.d.files.ingest(
      p.id,
      { tempPath: writeTemp(t.d, 'x'), originalName: '# Evil.png' },
      UI,
    );
    fs.rmSync(t.d.files.open(f.id).path);
    t.clock.advance(1000);
    t.d.diary.addNote(p.id, { body: 'LAST_MARKER' }, UI);
    assertInvariant(t.d.export.build(p.id).markdown, 'Spot Welder', 'LAST_MARKER');
  });

  it('a link label ending with a backslash still renders as a link', () => {
    t = makeDomain();
    const p = seedProject(t.d, { links: [{ label: 'Docs\\', url: 'https://example.com/d' }] });
    const md = t.d.export.build(p.id).markdown;
    const links: string[] = [];
    const walk = (n: Nodes) => {
      // The GFM autolink literal would also match the bare URL, so require the label too.
      if (n.type === 'link') links.push(`${text(n)} -> ${n.url}`);
      if ('children' in n) for (const c of n.children) walk(c as Nodes);
    };
    walk(parse(md));
    expect(links.some((l) => l.startsWith('Docs') && l.endsWith(' -> https://example.com/d'))).toBe(
      true,
    );
  });
});

// ------------------------------------------------------------------ project.json diary

describe('verify9 project.json diary paging', () => {
  it('1203 entries, many sharing a timestamp: all present once, oldest first', () => {
    t = makeDomain();
    const p = seedProject(t.d);
    const before = t.d.export.build(p.id).json.diary.length;
    for (let i = 0; i < 1203; i++) {
      t.d.diary.addNote(p.id, { body: `n${i}` }, UI);
      if (i % 7 === 6) t.clock.advance(1); // runs of 7 equal timestamps
    }
    // Also a whole run of equal timestamps across page boundaries.
    const x = t.d.export.build(p.id).json.diary;
    expect(x.length).toBe(before + 1203);
    expect(new Set(x.map((e) => e.id)).size).toBe(x.length);
    const notes = x.filter((e) => /^n\d+$/.test(e.body)).map((e) => Number(e.body.slice(1)));
    expect(notes).toEqual([...Array(1203).keys()]);
    for (let i = 1; i < x.length; i++) {
      expect(x[i]!.occurredAt >= x[i - 1]!.occurredAt).toBe(true);
    }
    // Every DB row of the project is exported.
    const rows = t.d.db
      .select({ id: diaryEntries.id })
      .from(diaryEntries)
      .where(eq(diaryEntries.projectId, p.id))
      .all();
    expect(new Set(x.map((e) => e.id))).toEqual(new Set(rows.map((r) => r.id)));
  }, 60_000);
});

// ------------------------------------------------------------------ speed (reported)

describe('verify9 demote: minimised round-trip and invariant failures', () => {
  const noH12 = (md: string) => headings(md).filter((h) => h.depth <= 2);

  it('B1 inline HTML comment spanning an indented "# x" line: demote must not create an H1', () => {
    // Input: one paragraph (text + inline html), no heading at all.
    const md = 'a <!--\n    # x\n-->';
    expect(noH12(md)).toEqual([]);
    expect(noH12(demote(md))).toEqual([]);
  });

  it('B1 (lazy variant from the 1 MB body) in a nested quote/list', () => {
    const md = '> 1. - Setext 15\n     <!-- comment\n     # inside comment\n     -->';
    expect(noH12(md)).toEqual([]);
    expect(noH12(demote(md))).toEqual([]);
  });

  it('B1 in the full export: a project description cannot add an H1', () => {
    t = makeDomain();
    const p = seedProject(t.d, { description: 'a <!--\n    # Evil\n-->' });
    t.d.diary.addNote(p.id, { body: 'LAST_MARKER' }, UI);
    assertInvariant(t.d.export.build(p.id).markdown, 'Spot Welder', 'LAST_MARKER');
  });

  it('B2 task notes with an HTML block using bare CR line endings cannot add an H1', () => {
    // demote keeps "\r" inside the raw HTML value; indent() only splits on "\n".
    t = makeDomain();
    const p = seedProject(t.d);
    t.d.roadmap.updateTask(p.phases[0]!.tasks[0]!.id, { notes: '<div>\r# Evil\r</div>' }, UI);
    t.d.diary.addNote(p.id, { body: 'LAST_MARKER' }, UI);
    assertInvariant(t.d.export.build(p.id).markdown, 'Spot Welder', 'LAST_MARKER');
  });

  // Accepted limitation (D53, user decision 2026-11-25): mdast-util-to-markdown does not
  // round-trip this exactly. `it.fails` keeps the case visible and flags it once fixed.
  it.fails('B3 a table after a nested list in a quoted list item stays a table', () => {
    const md = '> 1. * a\n>\n>    | a | b |\n>    |---|---|';
    const kinds = (s: string) => {
      const out: string[] = [];
      const w = (n: Nodes) => {
        out.push(n.type);
        if ('children' in n) for (const c of n.children) w(c as Nodes);
      };
      w(parse(s));
      return out;
    };
    expect(kinds(md)).toContain('table');
    expect(kinds(demote(md))).toContain('table');
  });

  // Accepted limitation (D53, user decision 2026-11-25): mdast-util-to-markdown does not
  // round-trip this exactly. `it.fails` keeps the case visible and flags it once fixed.
  it.fails.each([
    ['quoted task item then less-indented HTML', '>   - [x] done\n>   <div>'],
    ['indented bullet then HTML at the same indent', '   * a\n   <pre>'],
  ])('B4 %s: the HTML block does not move into the list item', (_n, md) => {
    expect(JSON.stringify(strip(parse(demote(md)), true))).toBe(
      JSON.stringify(strip(parse(md), true)),
    );
  });

  // Accepted limitation (D53, user decision 2026-11-25): mdast-util-to-markdown does not
  // round-trip this exactly. `it.fails` keeps the case visible and flags it once fixed.
  it.fails('B5 a hard line break inside a setext heading survives', () => {
    const md = 'a\\\nb\n===';
    const breaks = (s: string) => JSON.stringify(strip(parse(s), true)).split('"break"').length - 1;
    expect(breaks(md)).toBe(1);
    expect(breaks(demote(md))).toBe(1);
  });

  // Accepted limitation (D53, user decision 2026-11-25): mdast-util-to-markdown does not
  // round-trip this exactly. `it.fails` keeps the case visible and flags it once fixed.
  it.fails('B6 a tight list item (paragraph + thematic break) stays tight', () => {
    const md = '- a\n  ***';
    expect(JSON.stringify(strip(parse(demote(md)), true))).toBe(
      JSON.stringify(strip(parse(md), true)),
    );
  });
});

describe('verify9 demote speed (reported, generous bounds)', () => {
  it('1 MB hostile body, 1 MB plain prose, 1000 diary entries: timings', () => {
    const rand = rng(5);
    let hostile = '';
    while (hostile.length < 1_000_000) hostile += `${gen(rand)}\n\n`;
    let prose = '';
    for (let i = 0; prose.length < 1_000_000; i++)
      prose += `## Day ${i}\n\nWorked on the *case* and the \`wiring\`; see [notes](https://example.com/${i}).\n\n- item one\n- item two\n\n`;
    const t0 = performance.now();
    demote(hostile);
    const t1 = performance.now();
    demote(prose);
    const t2 = performance.now();

    t = makeDomain();
    const p = seedProject(t.d);
    for (let i = 0; i < 1000; i++) t.d.diary.addNote(p.id, { body: gen(rand).trim() || 'x' }, UI);
    const t3 = performance.now();
    const md = t.d.export.build(p.id).markdown;
    const t4 = performance.now();
    console.log(
      `[verify9 timing] demote hostile 1 MB: ${(t1 - t0).toFixed(0)} ms; demote prose 1 MB: ${(t2 - t1).toFixed(0)} ms; ` +
        `export.build with 1000 hostile diary entries (${md.length} chars): ${(t4 - t3).toFixed(0)} ms`,
    );
    expect(t1 - t0).toBeLessThan(60_000);
  }, 180_000);
});
