// Independent verification of the project export, round 8. Invented data only.
// Focus: `demote` and the "exactly one level-1 heading" invariant of the Markdown export.
import type { Nodes, Root } from 'mdast';
import { fromMarkdown } from 'mdast-util-from-markdown';
import { gfmFromMarkdown } from 'mdast-util-gfm';
import { gfm } from 'micromark-extension-gfm';
import { afterEach, describe, expect, it } from 'vitest';
import { UI } from './context.js';
import { demote } from './export.js';
import { seedProject } from './test/fixtures.js';
import { makeDomain, type TestDomain } from './test/helpers.js';

let t: TestDomain;
afterEach(() => t?.cleanup());

// ------------------------------------------------------------------ oracle
//
// Originally a small line scanner; replaced by a real parser (see `scan`) when
// demote moved to mdast (D53). Format-preserving checks became checks on meaning.

interface Heading {
  level: number;
  text: string;
  line: number;
}

/**
 * Oracle: a real CommonMark + GFM parse (D53, revised 2026-11-24). It replaces the
 * simplified line scanner, which misread fences inside list items. Returns every
 * heading anywhere in the tree (block quotes and list items included).
 */
function scan(md: string): { headings: Heading[]; openFence: boolean } {
  const headings: Heading[] = [];
  const walk = (n: Nodes) => {
    if (n.type === 'heading') {
      headings.push({ level: n.depth, text: plain(n).trim(), line: n.position?.start.line ?? 0 });
    }
    if ('children' in n) for (const c of n.children) walk(c);
  };
  walk(parseMd(md));
  // A parser never leaves a fence "open": an unclosed fence is code until the end of
  // its container, which the sentinel checks below detect as a swallowed heading.
  return { headings, openFence: false };
}

function parseMd(md: string): Root {
  return fromMarkdown(md, { extensions: [gfm()], mdastExtensions: [gfmFromMarkdown()] });
}

function plain(n: Nodes): string {
  if ('value' in n && typeof n.value === 'string') return n.value;
  return 'children' in n ? n.children.map((c) => plain(c as Nodes)).join('') : '';
}

/** Fenced/indented code blocks as [lang, meta, value]. */
function codeBlocks(md: string): [string | null, string | null, string][] {
  const out: [string | null, string | null, string][] = [];
  const walk = (n: Nodes) => {
    if (n.type === 'code') out.push([n.lang ?? null, n.meta ?? null, n.value]);
    if ('children' in n) for (const c of n.children) walk(c);
  };
  walk(parseMd(md));
  return out;
}

function depths(md: string): number[] {
  return scan(md).headings.map((h) => h.level);
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

/** Hostile top-level Markdown lines (no container continuation). */
function genTopLevel(rand: () => number, eols: string[] = ['\n', '\n', '\r\n']): string {
  const pick = <T>(xs: T[]) => xs[Math.floor(rand() * xs.length)]!;
  const sp = () => ' '.repeat(Math.floor(rand() * 4));
  const fenceStr = () => pick(['`', '~']).repeat(3 + Math.floor(rand() * 3));
  const parts: (() => string)[] = [
    () => `${sp()}${'#'.repeat(1 + Math.floor(rand() * 6))} heading ${Math.floor(rand() * 99)}`,
    () => `${sp()}#`,
    () => `#\ttabbed`,
    () => `#nospace`,
    () => 'Plain paragraph text',
    () => `${sp()}${pick(['=', '-'])}`.padEnd(3 + Math.floor(rand() * 4), pick(['=', '-'])),
    () => `${sp()}${'='.repeat(1 + Math.floor(rand() * 5))}`,
    () => `${sp()}${'-'.repeat(1 + Math.floor(rand() * 5))}  `,
    () => '',
    () => '',
    () => `${fenceStr()}${pick(['', 'md', ' js title="x"', ' ~tilde~', ' `bad`'])}`,
    () => fenceStr(),
    () => `${sp()}${fenceStr()}   `,
    () => `    # indented code ${Math.floor(rand() * 9)}`,
    () => `\t# tab-indented code`,
    () => `- list item`,
    () => `1. ordered item`,
    () => `> quoted text`,
    () => `***`,
    () => `\`\`\` inline \`\`\` code`,
    () => 'text with `code` and # hash',
  ];
  const n = 1 + Math.floor(rand() * 14);
  const lines: string[] = [];
  for (let i = 0; i < n; i++) lines.push(pick(parts)());
  const eol = pick(eols);
  return lines.join(eol);
}

describe('verify8 demote: property loops on top-level hostile Markdown', () => {
  it('never leaves a level-1 or level-2 heading and never leaves a fence open (5000 cases)', () => {
    const rand = rng(20261124);
    for (let i = 0; i < 5000; i++) {
      const md = genTopLevel(rand);
      const out = demote(md);
      const s = scan(`${out}\n\n## SENTINEL`);
      const bad = s.headings.filter((h) => h.level <= 2 && h.text !== 'SENTINEL');
      expect(bad, `input ${JSON.stringify(md)} → ${JSON.stringify(out)}`).toEqual([]);
      expect(
        s.headings.some((h) => h.text === 'SENTINEL'),
        `sentinel swallowed for ${JSON.stringify(md)}`,
      ).toBe(true);
    }
  }, 30_000);

  it('LF only: never leaves a level-1 or level-2 heading, never leaves a fence open (5000 cases)', () => {
    const rand = rng(11);
    for (let i = 0; i < 5000; i++) {
      const md = genTopLevel(rand, ['\n']);
      const out = demote(md);
      const s = scan(`${out}\n\n## SENTINEL`);
      const bad = s.headings.filter((h) => h.level <= 2 && h.text !== 'SENTINEL');
      expect(bad, `input ${JSON.stringify(md)} → ${JSON.stringify(out)}`).toEqual([]);
      expect(s.headings.some((h) => h.text === 'SENTINEL')).toBe(true);
    }
  }, 30_000);

  it('every heading the oracle sees in the input is two levels deeper afterwards (capped at 6)', () => {
    const rand = rng(7);
    let fallbacks = 0;
    for (let i = 0; i < 3000; i++) {
      const md = genTopLevel(rand);
      const before = scan(md).headings.map((h) => Math.min(6, h.level + 2));
      const out = demote(md);
      // D53 (single-pass writer, 2026-11-25): a field the writer cannot reproduce is
      // exported verbatim in one markdown code block; that fallback must stay rare.
      const top = parseMd(out).children;
      if (top.length === 1 && top[0]!.type === 'code' && top[0]!.lang === 'markdown') {
        fallbacks++;
        continue;
      }
      const after = scan(out).headings.map((h) => h.level);
      expect(after, `input ${JSON.stringify(md)}`).toEqual(before);
    }
    expect(fallbacks, 'verbatim fallbacks of 3000').toBeLessThan(150);
  }, 30_000);

  it('content of closed fences is identical after re-serialisation (lang, meta, value)', () => {
    const rand = rng(99);
    for (let i = 0; i < 2000; i++) {
      const ch = rand() < 0.5 ? '`' : '~';
      const len = 3 + Math.floor(rand() * 3);
      const open = `${' '.repeat(Math.floor(rand() * 4))}${ch.repeat(len)}${rand() < 0.5 ? ' info' : ''}`;
      const body = genTopLevel(rand)
        .split(/\r?\n/)
        // Keep the body from closing the fence early.
        .filter((l) => !/^ {0,3}(`{3,}|~{3,})\s*$/.test(l))
        .join('\n');
      const close = ch.repeat(len + Math.floor(rand() * 2));
      const block = `${open}\n${body}\n${close}`;
      const md = `# Before\n\n${block}\n\n# After`;
      const out = demote(md);
      expect(codeBlocks(out), JSON.stringify(md)).toEqual(codeBlocks(md));
      expect(out.endsWith('### After')).toBe(true);
    }
  }, 30_000);
});

describe('verify8 demote: hand-checked CommonMark cases', () => {
  // Each input renders (CommonMark 0.31 / GFM) with an <h1>. After demote no <h1> may remain.
  it('ATX heading inside a block quote ("> # H") is demoted', () => {
    expect(demote('> # Quoted H1')).not.toMatch(/^> {0,3}# /m);
  });

  it('ATX heading inside a list item ("- # H") is demoted', () => {
    expect(demote('- # Listed H1')).not.toMatch(/^- {1,4}# /m);
  });

  it('setext heading inside a block quote ("> T\\n> ===") is demoted', () => {
    expect(demote('> Title\n> ===')).not.toMatch(/^> {0,3}=+\s*$/m);
  });

  it('setext heading inside a list item ("- T\\n  ===") is demoted', () => {
    expect(demote('- Title\n  ===')).not.toMatch(/^ {2}=+\s*$/m);
  });

  it('setext heading whose paragraph has an indented continuation line is demoted', () => {
    // "a\n    b\n===" is <h1>a\nb</h1>: an indented line cannot interrupt a paragraph.
    const out = demote('a\n    b\n===');
    expect(scan(out).headings.filter((h) => h.level === 1)).toEqual([]);
    expect(out).not.toMatch(/^=+$/m);
  });

  it('a bare CR line ending ("# a\\r# b") is a line break in CommonMark; both headings demoted', () => {
    const out = demote('# a\r# b');
    expect(scan(out).headings.filter((h) => h.level <= 2)).toEqual([]);
  });

  it('a fence opened inside a list item does not make demote treat later headings as code', () => {
    // CommonMark: list item holding a fenced block; "# After" is a real top-level H1.
    const md = '- ```\n  # in code\n  ```\n\n# After';
    const out = demote(md);
    expect(out).toContain('  # in code'); // fenced content untouched
    expect(out).toContain('### After');
  });

  it('an unclosed fence inside a list item does not cause an extra top-level fence', () => {
    // The list item's fence ends with the item. A column-0 "```" appended by demote
    // would open a new top-level fence that swallows everything after the block.
    const md = '- item\n\n  ```\n  code';
    const out = demote(md);
    expect(out).not.toMatch(/\n(`{3,}|~{3,})$/);
  });

  it('a fence-like line inside an HTML comment is not a fence (no appended closer)', () => {
    // HTML block type 2 runs until "-->"; the "```" inside is raw HTML, not a fence.
    const md = '<!--\n```\n-->';
    expect(demote(md)).toBe(md);
  });

  it('setext underline after a paragraph line starting with "#" (not an ATX heading) is converted', () => {
    // "#tag" is paragraph text (no space after #), so "#tag\n===" is <h1>#tag</h1>.
    expect(scan(demote('#tag\n===')).headings.filter((h) => h.level <= 2)).toEqual([]);
    expect(scan(demote('#tag\n---')).headings.filter((h) => h.level <= 2)).toEqual([]);
  });

  it('setext underline after a paragraph consisting of "=" is converted', () => {
    // "=" cannot be an underline without a paragraph, so it is paragraph text: <h1>=</h1>.
    expect(scan(demote('=\n===')).headings.filter((h) => h.level <= 2)).toEqual([]);
  });

  it('CRLF fences are recognised: content untouched, unclosed fence closed', () => {
    const crlf = '```\r\n# in code\r\n```\r\n# out';
    expect(codeBlocks(demote(crlf))).toEqual(codeBlocks(crlf));
    expect(depths(demote(crlf))).toEqual([3]);
    const s = scan(`${demote('```\r\nunclosed\r\n')}\n\n## SENTINEL`);
    expect(s.headings.map((h) => h.text)).toContain('SENTINEL');
  });

  it.each([
    ['backtick run that is not a fence (info has a backtick)', '``` a `b`\n==='],
    ['pipe-leading paragraph without a table delimiter row', '|a\n==='],
  ])('setext underline after a paragraph line: %s', (_name, md) => {
    expect(scan(demote(md)).headings.filter((h) => h.level <= 2)).toEqual([]);
  });

  it('demotes ATX headings with 0-3 leading spaces, caps at 6 and leaves #tag and code alone', () => {
    expect(depths(demote('   # x'))).toEqual([3]);
    expect(depths(demote('#### x'))).toEqual([6]);
    expect(depths(demote('##### x'))).toEqual([6]);
    expect(depths(demote('###### x'))).toEqual([6]);
    expect(depths(demote('#tag'))).toEqual([]);
    expect(plain(parseMd(demote('#tag')))).toBe('#tag');
    expect(codeBlocks(demote('    # code'))).toEqual([[null, null, '# code']]);
    expect(depths(demote('#'))).toEqual([3]);
    expect(depths(demote('#\tx'))).toEqual([3]);
  });

  it('handles CRLF: fences close, setext converts, headings demote', () => {
    const md = '# A\r\n```\r\n# in\r\n```\r\nT\r\n===\r\n';
    const out = demote(md);
    expect(out).toContain('### A');
    expect(codeBlocks(out)).toEqual([[null, null, '# in']]);
    expect(out).toContain('### T');
    expect(scan(out).headings.filter((h) => h.level <= 2)).toEqual([]);
  });

  it('closing fence: same char, at least as long, no info string, up to 3 spaces', () => {
    const cases: [string, [string | null, string | null, string][], number[]][] = [
      ['````\n```\n# x\n````\n# y', [[null, null, '```\n# x']], [3]],
      ['~~~\n```\n# x\n~~~ \n# y', [[null, null, '```\n# x']], [3]],
      ['```\n# x\n``` js\n# y', [[null, null, '# x\n``` js\n# y']], []],
      ['```\n# x\n    ```\n# y', [[null, null, '# x\n    ```\n# y']], []],
    ];
    for (const [md, code, heads] of cases) {
      expect(codeBlocks(md), md).toEqual(code);
      expect(codeBlocks(demote(md)), md).toEqual(code);
      expect(depths(demote(md)), md).toEqual(heads);
    }
  });

  it('tilde fence info may contain backticks', () => {
    const md = '~~~ a`b\n# x\n~~~\n# y';
    expect(codeBlocks(demote(md))).toEqual([['a`b', null, '# x']]);
    expect(depths(demote(md))).toEqual([3]);
  });
});

// ------------------------------------------------------------------ full export

function h1Count(md: string): number {
  // Top-level oracle plus naive container stripping ("> ", "- ", "  ").
  let n = scan(md).headings.filter((h) => h.level === 1).length;
  const stripped = md
    .split('\n')
    .map((l) => l.replace(/^(?: {0,3}>)+ ?/, '').replace(/^ {0,3}(?:[-*+]|\d+[.)]) +/, ''))
    .join('\n');
  n = Math.max(n, scan(stripped).headings.filter((h) => h.level === 1).length);
  return n;
}

describe('verify8 export: exactly one H1', () => {
  it('task notes "===" do not turn the task line into a setext H1', () => {
    t = makeDomain();
    const p = seedProject(t.d);
    const task = p.phases[0]!.tasks[0]!;
    t.d.roadmap.updateTask(task.id, { notes: '===' }, UI);
    const md = t.d.export.build(p.id).markdown;
    // "- [ ] #1 Schematic\n  ===" is an <h1> inside the list item.
    expect(md).not.toMatch(/\n- \[ \] #\d+ Schematic\n {2}=+\n/);
  });

  it('task notes starting with a setext-like line after an indented paragraph', () => {
    t = makeDomain();
    const p = seedProject(t.d);
    const task = p.phases[0]!.tasks[0]!;
    t.d.roadmap.updateTask(task.id, { notes: '=\nmore' }, UI);
    const md = t.d.export.build(p.id).markdown;
    expect(md).not.toMatch(/Schematic\n {2}=+\n/);
  });

  it('hostile top-level content in every field yields one H1 (oracle) and keeps all sections', () => {
    const rand = rng(424242);
    for (let i = 0; i < 40; i++) {
      t?.cleanup();
      t = makeDomain();
      const g = () => genTopLevel(rand).trim() || 'x';
      const p = seedProject(t.d, {
        description: g(),
        phases: [{ title: 'P', description: g(), tasks: ['T1', 'T2'] }],
      });
      t.d.projects.update(p.id, { internalDocs: g() }, UI);
      t.d.diary.addNote(p.id, { body: g() }, UI);
      t.d.diary.addNote(p.id, { body: g() }, UI);
      const md = t.d.export.build(p.id).markdown;
      const s = scan(md);
      const h1 = s.headings.filter((h) => h.level === 1);
      expect(
        h1.map((h) => h.text),
        md,
      ).toEqual(['Spot Welder']);
      const h2 = s.headings.filter((h) => h.level === 2).map((h) => h.text);
      expect(h2, md).toEqual([
        'Project',
        'Roadmap',
        'Documentation',
        'Materials',
        'Files',
        'Diary',
      ]);
    }
  });

  it.each([
    ['block quote ATX', '> # Evil'],
    ['list ATX', '- # Evil'],
    ['block quote setext', '> Evil\n> ==='],
    ['list setext', '- Evil\n  ==='],
    ['indented continuation setext', 'Evil\n    more\n==='],
    ['bare CR', 'ok\r# Evil'],
  ])('diary body with %s yields exactly one H1', (_name, body) => {
    t = makeDomain();
    const p = seedProject(t.d);
    t.d.diary.addNote(p.id, { body }, UI);
    expect(h1Count(t.d.export.build(p.id).markdown)).toBe(1);
  });

  it('a diary body with a fence inside a list item does not swallow later diary entries', () => {
    t = makeDomain();
    const p = seedProject(t.d);
    t.d.diary.addNote(p.id, { body: '- item\n\n  ```\n  unclosed' }, UI);
    t.clock.advance(1000);
    t.d.diary.addNote(p.id, { body: 'LATER' }, UI);
    const md = t.d.export.build(p.id).markdown;
    // A column-0 fence after the indented list-item fence opens a new top-level fence
    // (the list item closes first), which then swallows "LATER" and the rest.
    expect(md).not.toMatch(/\n {2}unclosed\n```\n/);
  });

  it('a diary body with "```" inside an HTML comment does not swallow later entries', () => {
    t = makeDomain();
    const p = seedProject(t.d);
    t.d.diary.addNote(p.id, { body: '<!--\n```\n-->' }, UI);
    t.clock.advance(1000);
    t.d.diary.addNote(p.id, { body: 'LATER' }, UI);
    const md = t.d.export.build(p.id).markdown;
    // In CommonMark the comment is raw HTML; any fence line demote adds after "-->"
    // opens a real fence that runs to the end of the document.
    expect(md).not.toMatch(/-->\n```\n/);
  });
});

describe('verify8 export: link URLs and labels', () => {
  const FORBIDDEN = /[()\s<>]/u;
  const urls = [
    'https://example.com/a b',
    'https://example.com/(x)',
    'https://example.com/<y>',
    'https://example.com/café/日本',
    'https://example.com/\u{1F600}',
    'https://example.com/a b',
    'https://example.com/a　b',
    'https://example.com/a b',
    'https://example.com/a b',
    'https://example.com/a\tb',
    'https://example.com/?q=a)b(c',
    'https://example.com/#frag)',
  ];

  // Revised 2026-11-25 (D53): labels are now escaped by the serializer instead of having
  // `[`/`]` stripped, and the export's own lists use `*`. The checks parse the Markdown
  // with a real parser: the link must exist with the exact label text and a destination
  // without raw (, ), whitespace, < or >.
  const links = (md: string): { label: string; url: string }[] => {
    const out: { label: string; url: string }[] = [];
    const walk = (n: Nodes) => {
      if (n.type === 'link') out.push({ label: plain(n), url: n.url });
      if ('children' in n) for (const c of n.children) walk(c);
    };
    walk(parseMd(md));
    return out;
  };

  it.each(urls.map((u) => [u]))(
    'project link %j: destination has no raw (, ), whitespace, <, >',
    (u) => {
      t = makeDomain();
      let p: ReturnType<typeof seedProject>;
      try {
        p = seedProject(t.d, { links: [{ label: 'L [x] ]y[', url: u }] });
      } catch {
        return; // URL rejected by validation: nothing to export
      }
      const md = t.d.export.build(p.id).markdown;
      const line = md.split('\n').find((l) => l.startsWith('* Link: '));
      expect(line).toBeDefined();
      const m = /^\* Link: \[(.*)\]\((.*)\)$/.exec(line!);
      expect(m, line).not.toBeNull();
      expect(m![2]).not.toMatch(FORBIDDEN);
      expect(links(line!)).toEqual([{ label: 'L [x] ]y[', url: m![2] }]);
    },
  );

  it.each(urls.map((u) => [u]))(
    'material link %j: destination has no raw (, ), whitespace, <, >',
    (u) => {
      t = makeDomain();
      const p = seedProject(t.d);
      try {
        t.d.materials.add(p.id, { name: 'N [a] | b', quantity: 1, link: u }, UI);
      } catch {
        return;
      }
      const md = t.d.export.build(p.id).markdown;
      const row = md.split('\n').find((l) => l.startsWith('| [N'));
      expect(row, md).toBeDefined();
      const m = /^\| \[(.*)\]\(([^)]*)\) \|/.exec(row!);
      expect(m, row).not.toBeNull();
      expect(m![2]).not.toMatch(FORBIDDEN);
      expect(links(md).filter((l) => l.label.startsWith('N '))).toEqual([
        { label: 'N [a] | b', url: m![2] },
      ]);
      // Row still has 4 columns.
      expect(row!.replace(/\\\|/g, '').split('|').length - 1).toBe(5);
    },
  );
});
