// Independent verification of the project export, round 12. Invented data only.
// Focus: criterion 2 (whole-document invariant, D53) with hostile text in EVERY field,
// including the export's own fixed fields; cross-segment definitions; fallback rates
// (criterion 3); robustness of the writer on deeply nested input.
import type {
  DiaryEntryView,
  MaterialView,
  PhaseView,
  ProjectDetail,
  ProjectExportJson,
} from '@heph/schema';
import type { Nodes, Root } from 'mdast';
import { fromMarkdown } from 'mdast-util-from-markdown';
import { gfmFromMarkdown, gfmToMarkdown } from 'mdast-util-gfm';
import { toMarkdown } from 'mdast-util-to-markdown';
import { gfm } from 'micromark-extension-gfm';
import { afterEach, describe, expect, it } from 'vitest';
import { UI } from './context.js';
import { demote } from './export.js';
import { renderMarkdown } from './export-md.js';
import { seedProject } from './test/fixtures.js';
import { makeDomain, type TestDomain } from './test/helpers.js';

let t: TestDomain | undefined;
afterEach(() => {
  t?.cleanup();
  t = undefined;
});

const BS = String.fromCharCode(92);
const SECTIONS = ['Project', 'Roadmap', 'Documentation', 'Materials', 'Files', 'Diary'];

function parse(md: string): Root {
  return fromMarkdown(md, { extensions: [gfm()], mdastExtensions: [gfmFromMarkdown()] });
}
function plain(n: Nodes): string {
  if ('value' in n && typeof n.value === 'string') return n.value;
  return 'children' in n ? n.children.map((c) => plain(c as Nodes)).join('') : '';
}
const ws = (s: string) => s.replace(/\0/g, '�').replace(/\s+/g, ' ').trim();

function rng(seed: number) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let r = Math.imul(a ^ (a >>> 15), 1 | a);
    r = (r + Math.imul(r ^ (r >>> 7), 61 | r)) ^ r;
    return ((r ^ (r >>> 14)) >>> 0) / 4294967296;
  };
}

// ------------------------------------------------------------------ synthetic export

type Str = (key: string) => string;

/** A synthetic ProjectExportJson: every string field comes from `s`, bypassing input validation. */
function synthetic(s: Str, nPh = 2, nT = 2, nD = 2): ProjectExportJson {
  let id = 100;
  const phases = Array.from({ length: nPh }, (_, i) => ({
    position: i,
    title: s('phaseTitle'),
    status: 'active',
    progress: { done: 0, total: nT, ratio: 0 },
    description: s('phaseDesc'),
    tasks: Array.from({ length: nT }, (_, j) => ({
      id: id++,
      title: s('taskTitle'),
      notes: s('taskNotes'),
      done: j % 2 === 0,
    })),
  })) as unknown as PhaseView[];
  const project = {
    name: s('name'),
    slug: 'slug',
    lifecycleStatus: 'active',
    statusNote: s('statusNote'),
    progress: { done: 1, total: 2, ratio: 0.5 },
    nextTask: { id: 7, title: s('nextTitle') },
    tags: [s('tag1'), s('tag2')],
    repos: ['o/r'],
    links: [{ label: s('linkLabel'), url: s('linkUrl') }],
    createdAt: '2026-01-01T00:00:00.000Z',
    description: s('description'),
    phases,
  } as unknown as ProjectDetail;
  const diary = Array.from({ length: nD }, (_, i) => ({
    id: i,
    type: 'note',
    eventKind: null,
    source: 'ui',
    occurredAt: `2026-02-0${i + 1}T00:00:00.000Z`,
    body: s('diary'),
    files: [{ id: 1, originalName: s('fname') }],
  })) as unknown as DiaryEntryView[];
  const materials = [
    {
      name: s('matName'),
      link: s('matLink'),
      quantity: 2,
      unit: s('unit'),
      price: 100,
      currency: s('cur'),
      status: 'needed',
    },
    {
      name: s('matName'),
      link: null,
      quantity: 1,
      unit: null,
      price: null,
      currency: 'EUR',
      status: 'needed',
    },
  ] as unknown as MaterialView[];
  return {
    format: 'heph-project-export',
    version: 1,
    exportedAt: '2026-11-25T00:00:00.000Z',
    project,
    docs: {
      projectId: 1,
      source: s('docsSource') === 'repo' ? 'repo' : 'internal',
      internal: s('docs'),
      repos: [
        {
          fullName: 'o/r',
          docsPath: s('docsPath'),
          content: s('repoDocs'),
        },
      ],
    } as unknown as ProjectExportJson['docs'],
    diary,
    materials,
    files: [
      { id: 1, caption: s('caption'), originalName: s('fname'), exportPath: 'files/1-a.bin' },
      { id: 2, caption: '', originalName: s('fname'), exportPath: null },
    ] as unknown as ProjectExportJson['files'],
    proposals: [],
  };
}

/** Independent oracle of the whole-document invariant (criterion 2). */
function problems(x: ProjectExportJson, md: string): string[] {
  const errs: string[] = [];
  const kids = parse(md).children;
  const all = (d: number) => {
    const out: { top: boolean; t: string }[] = [];
    const walk = (n: Nodes, top: boolean) => {
      if (n.type === 'heading' && n.depth === d) out.push({ top, t: ws(plain(n)) });
      if ('children' in n) for (const c of n.children) walk(c as Nodes, false);
    };
    for (const k of kids) walk(k, true);
    return out;
  };
  const h1 = all(1);
  if (h1.length !== 1 || !h1[0]!.top) errs.push(`h1 ${JSON.stringify(h1)}`);
  const h2 = all(2);
  if (JSON.stringify(h2.map((z) => z.t)) !== JSON.stringify(SECTIONS) || h2.some((z) => !z.top))
    errs.push(`h2 ${JSON.stringify(h2)}`);
  const at = (name: string) =>
    kids.findIndex((k) => k.type === 'heading' && k.depth === 2 && ws(plain(k)) === name);
  const rs = at('Roadmap');
  const ds = at('Documentation');
  const di = at('Diary');
  const heads = x.project.phases.map((ph) =>
    ws(`${ph.position + 1}. ${ph.title} (${ph.status}, ${ph.progress.done}/${ph.progress.total})`),
  );
  const isHead = (k: Nodes | undefined, text: string | undefined) =>
    k?.type === 'heading' && k.depth === 3 && ws(plain(k)) === text;
  let pos = rs + 1;
  x.project.phases.forEach((ph, i) => {
    let k = pos;
    while (k < ds && !isHead(kids[k], heads[i])) k++;
    if (k >= ds) {
      errs.push(`phase heading ${i} missing`);
      return;
    }
    let end = k + 1;
    while (end < ds && !isHead(kids[end], heads[i + 1])) end++;
    if (ph.tasks.length) {
      const last = kids[end - 1];
      if (last?.type !== 'list') errs.push(`phase ${i}: last block is ${last?.type}`);
      else {
        if (last.children.length !== ph.tasks.length)
          errs.push(`phase ${i}: ${last.children.length} items for ${ph.tasks.length} tasks`);
        last.children.forEach((li, j) => {
          const task = ph.tasks[j];
          if (!task) return;
          const first = li.children[0];
          const txt = first ? ws(plain(first)) : '';
          if (txt !== `#${task.id}` && !txt.startsWith(`#${task.id} `))
            errs.push(`task ${task.id}: ${JSON.stringify(txt.slice(0, 40))}`);
          if (li.checked !== task.done) errs.push(`task ${task.id}: checked ${li.checked}`);
        });
      }
    }
    pos = end;
  });
  const want = x.diary.map(
    (e) => `${e.occurredAt} · ${e.eventKind ? `${e.type}/${e.eventKind}` : e.type} · ${e.source}`,
  );
  const got = kids
    .slice(di + 1)
    .filter((k) => k.type === 'heading' && k.depth === 3)
    .map((k) => ws(plain(k)))
    .filter((s) => want.includes(s));
  if (JSON.stringify(got) !== JSON.stringify(want)) errs.push(`diary ${JSON.stringify(got)}`);
  return errs;
}

const FIXED = [
  'name',
  'statusNote',
  'nextTitle',
  'tag1',
  'tag2',
  'linkLabel',
  'linkUrl',
  'phaseTitle',
  'taskTitle',
  'fname',
  'matName',
  'matLink',
  'unit',
  'cur',
  'caption',
  'docsPath',
];
const USER = ['description', 'phaseDesc', 'taskNotes', 'docs', 'diary', 'repoDocs'];

const FRAG = [
  '# h',
  '## h',
  '#',
  '\n',
  '\r',
  '\r\n',
  '&#10;',
  '&#13;',
  '&#x0A;',
  '&NewLine;',
  '&#35;',
  '&amp;',
  BS,
  '`',
  '```',
  '~~~',
  '<!--',
  '-->',
  '<pre>',
  '</pre>',
  '<div>',
  '<br>',
  '<details>',
  '*',
  '-',
  '+',
  '1.',
  '1)',
  '> ',
  '[x]',
  '[ ]',
  '[^1]',
  '[^1]:',
  '[a]:',
  '[a]',
  ']',
  '(',
  ')',
  '|',
  '---',
  '===',
  '    ',
  '\t',
  ' ',
  'www.x.com',
  'http://a.b/c',
  '<http://x>',
  '!',
  '_',
  '~~',
  '\u0000',
  '\u000b',
  '\f',
  ' ',
  ' ',
  '<',
  '>',
  '"',
  ':',
  'word',
  '<script>',
  '&',
  '&#0;',
  BS + '#',
  'a #',
  ' #',
  '<!',
  '<?',
  '?>',
  '<![CDATA[',
  ']]>',
  '- [ ]',
  '* [x]',
  `${BS}\n`,
  '  \n',
  '﻿',
  '\ud800',
];
const LINES = [
  '# H1',
  '## H2',
  'Setext',
  '===',
  '---',
  '- a',
  '* b',
  '1. d',
  '2) e',
  '- [ ] t',
  '* [x] t',
  '> q',
  '> # qh',
  '    code',
  '\tcode',
  '```',
  '~~~',
  '<!--',
  '-->',
  '<pre>',
  '</pre>',
  '<div>',
  '</div>',
  '<details>',
  '</details>',
  'a<br>b',
  '<?x',
  '<![CDATA[',
  '| a | b |',
  '|---|---|',
  '| c | d |',
  '[d]: /u',
  '[d]: /u "t',
  '[^f]: note',
  '    indented fn',
  '[^f]',
  '[d]',
  'x&#10;# H',
  'x&NewLine;## H',
  '&#13;## y',
  '&Tab;# t',
  '  - nested',
  '   # three',
  '  > lazy',
  'lazy',
  '',
  '',
  'x  ',
  `x${BS}`,
  '<a href="x">',
  '<span',
  '`code',
  '~~s~~',
  '<x@y.z>',
  '\u0000',
];

function genFrag(r: () => number): string {
  let s = '';
  const n = 1 + Math.floor(r() * 10);
  for (let i = 0; i < n; i++) s += FRAG[Math.floor(r() * FRAG.length)];
  return s;
}
function genLines(r: () => number): string {
  const pre = ['  ', '   ', '> ', '- ', '1. ', '    ', '\t', '>', '* '];
  const out: string[] = [];
  const n = 1 + Math.floor(r() * 10);
  for (let i = 0; i < n; i++) {
    let l = LINES[Math.floor(r() * LINES.length)]!;
    if (r() < 0.3) l = pre[Math.floor(r() * pre.length)] + l;
    if (r() < 0.2) l += LINES[Math.floor(r() * LINES.length)];
    out.push(l);
  }
  return out.join(r() < 0.1 ? '\r\n' : '\n');
}

describe('verify12 whole-document invariant with hostile fixed fields (renderMarkdown)', () => {
  it('600 synthetic exports with hostile names, titles, labels, URLs, units, captions, paths', () => {
    const r = rng(12_001);
    const fails: string[] = [];
    for (let i = 0; i < 600 && fails.length < 3; i++) {
      const v: Record<string, string> = {};
      for (const k of FIXED) if (r() < 0.6) v[k] = genFrag(r);
      for (const k of USER) if (r() < 0.6) v[k] = genLines(r);
      v.docsSource = r() < 0.5 ? 'repo' : 'internal';
      const x = synthetic((k) => v[k] ?? k);
      const md = renderMarkdown(x);
      const p = problems(x, md);
      if (p.length) fails.push(`${JSON.stringify(v)}\n${p.join('; ')}`);
    }
    expect(fails).toEqual([]);
  }, 120_000);

  // A definition `[x]: ...` in one segment and a checked task `* [x] ...` in another:
  // the task marker must win over a link reference when the file is read as a whole.
  it.each([
    ['link definition [x]', '[x]: /u'],
    ['link definition [X]', '[X]: /u "t"'],
    ['footnote definition [^x]', '[^x]: y'],
  ])('%s in the description keeps checked task items', (_n, def) => {
    const x = synthetic((k) => (k === 'description' ? def : k));
    expect(problems(x, renderMarkdown(x))).toEqual([]);
  });
});

// ------------------------------------------------------------------ deep nesting (bug)

// mdast-util-to-markdown recurses once per nesting level: a field of about 2 KB of nested
// list markers or block-quote markers overflows the stack. The exception escapes
// renderSegment (no fallback catches it), so the whole export fails (HTTP 500).
describe('verify12 deeply nested user Markdown', () => {
  it.each([
    ['1000 nested list items on one line (2 KB)', `${'- '.repeat(1000)}x`],
    ['2000 nested block quotes (2 KB)', `${'>'.repeat(2000)} x`],
  ])('demote does not throw: %s', (_n, md) => {
    expect(() => demote(md)).not.toThrow();
  });

  it('a project description of 1000 nested list markers still exports', () => {
    t = makeDomain();
    const p = seedProject(t.d, { description: `${'- '.repeat(1000)}x` });
    expect(() => t!.d.export.build(p.id)).not.toThrow();
  });

  // The writer is superlinear in emphasis nesting: 1000 `*` on each side (2 KB) took about
  // 8 s on this machine (2026-11-25), 2000 about 25 s; a 200 KB field is allowed.
  it('2 KB of nested emphasis is exported in under 2 s', () => {
    const md = `${'*'.repeat(1000)}x${'*'.repeat(1000)}`;
    const t0 = performance.now();
    demote(md);
    expect(performance.now() - t0).toBeLessThan(2000);
  }, 60_000);
});

// ------------------------------------------------------------------ fallback rates

const WRITE = {
  extensions: [gfmToMarkdown({ tablePipeAlign: false })],
  bullet: '*' as const,
  bulletOther: '-' as const,
  fence: '`' as const,
  fences: true,
  rule: '-' as const,
  setext: false,
};

/** Test-only model of the "normal" mode of D53: parse, demote headings, write. */
function normalCandidate(md: string): string {
  const src = md
    .replace(/\r\n?/g, '\n')
    .replace(/\0/g, '�')
    .replace(/^(?:[ \t]*\n)+/, '')
    .trimEnd();
  if (!src) return '';
  const tree = parse(src);
  const walk = (n: Nodes) => {
    if (n.type === 'heading') n.depth = Math.min(6, n.depth + 2) as 1;
    if ('children' in n) for (const c of n.children) walk(c as Nodes);
  };
  walk(tree);
  return toMarkdown(tree, WRITE).trimEnd();
}

function mode(md: string): 'normal' | 'strict' | 'verbatim' | 'other' {
  const out = demote(md);
  const top = parse(out).children;
  if (top.length === 1 && top[0]!.type === 'code' && top[0]!.lang === 'markdown') return 'verbatim';
  if (out === normalCandidate(md)) return 'normal';
  // An HTML conversion of the normal mode (unclosed block / multi-line inline HTML) or strict.
  return /```html|`<[^`]*`/.test(out) ? 'strict' : 'other';
}

const NORMAL_DOCS = [
  'Plain prose paragraph with *emphasis*, **strong**, `code` and a [link](https://e.com).',
  '# Title\n\nIntro.\n\n## Section\n\nText.\n\n### Sub\n\nMore.',
  '- one\n- two\n  - nested\n- three\n\n1. first\n2. second',
  '- [ ] open task\n- [x] done task',
  '| Part | Qty |\n| --- | ---: |\n| Resistor | 4 |\n| LED | 2 |',
  '```js\nconst a = 1;\n```\n\n    indented code\n\n~~~\ntilde fence\n~~~',
  '> A quote\n> with two lines\n>\n> - and a list',
  'Line one<br>line two<br/>line three',
  '<details>\n<summary>More</summary>\n\nHidden **text**.\n\n</details>',
  'Footnote[^1].\n\n[^1]: The note.',
  'Ref [link][r] here.\n\n[r]: https://e.com "Title"',
  'Auto https://e.com and www.e.com and <x@y.z>.',
  '---\n\nAfter a rule. ~~struck~~ and ![img](a.png "t").',
  'Hard break  \nnext line\\\nthird line.',
  'Setext\n======\n\nOther\n------',
  'Text with <kbd>Ctrl</kbd> and <sub>2</sub> and <!-- a comment -->.',
];

describe('verify12 fallback rates (criterion 3)', () => {
  it('normal, non-hostile Markdown never falls back', () => {
    const modes = NORMAL_DOCS.map((d) => [d, mode(d)]);
    const all = NORMAL_DOCS.join('\n\n');
    modes.push([all.slice(0, 40), mode(all)]);
    expect(modes.filter(([, m]) => m !== 'normal')).toEqual([]);
  });

  it('reports strict / verbatim rates on hostile generated input', () => {
    const r = rng(12_003);
    const n = { normal: 0, strict: 0, verbatim: 0, other: 0 };
    for (let i = 0; i < 3000; i++) n[mode(genLines(r))]++;
    console.log(`[verify12 fallback rates, 3000 hostile line-based inputs] ${JSON.stringify(n)}`);
    expect(n.other).toBe(0);
    expect(n.verbatim).toBeLessThan(150);
  }, 120_000);
});

// ------------------------------------------------------------------ round trip

function shape(n: Nodes): unknown {
  const o: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(n)) {
    if (k === 'position' || k === 'spread' || (k === 'depth' && n.type === 'heading')) continue;
    o[k] = k === 'children' ? (v as Nodes[]).map(shape) : v;
  }
  return o;
}

describe('verify12 round trip of normal Markdown (criterion 4)', () => {
  it.each(NORMAL_DOCS.map((d) => [d.slice(0, 30), d]))('%s', (_n, md) => {
    expect(shape(parse(demote(md)))).toEqual(shape(parse(md)));
  });
});

// ------------------------------------------------------------------ spec note

// D53 moves user headings down exactly two levels, so a user `# ...` becomes a top-level
// depth-3 heading, like a phase or diary heading. Recorded as a finding, not as a failing
// test: a reader that counts depth-3 headings counts it too.
describe('verify12 user H1 at the phase-heading level (observation)', () => {
  it('a phase description "# 2. Fake (done, 9/9)" yields an extra top-level depth-3 heading', () => {
    t = makeDomain();
    const p = seedProject(t.d, {
      phases: [{ title: 'Real', description: '# 2. Fake (done, 9/9)', tasks: ['A'] }],
    });
    t.d.diary.addNote(p.id, { body: '# 2026-01-01T00:00:00.000Z · note · ui' }, UI);
    const kids = parse(t.d.export.build(p.id).markdown).children;
    const h3 = kids.filter((k) => k.type === 'heading' && k.depth === 3).map((k) => plain(k));
    expect(h3).toContain('2. Fake (done, 9/9)');
    expect(h3).toContain('2026-01-01T00:00:00.000Z · note · ui');
  });
});
