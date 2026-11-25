import type {
  DiaryEntryView,
  MaterialView,
  PhaseView,
  ProjectDocsView,
  ProjectExportJson,
} from '@heph/schema';
import type {
  BlockContent,
  Heading,
  List,
  ListItem,
  Nodes,
  PhrasingContent,
  Root,
  RootContent,
  Table,
  TableCell,
} from 'mdast';
import { fromMarkdown } from 'mdast-util-from-markdown';
import { gfmFromMarkdown, gfmToMarkdown } from 'mdast-util-gfm';
import { toMarkdown as serialize, type Options as WriteOptions } from 'mdast-util-to-markdown';
import { gfm } from 'micromark-extension-gfm';

/**
 * Markdown of the project export (D53). The document is built as mdast nodes (the
 * export's own structure plus the parsed user Markdown), never by joining strings, so
 * the writer sees every context (lists next to lists, notes inside list items).
 *
 * "Do not break": nothing is trusted to the writer. The document is written in segments
 * that each start with one of the export's own headings; every segment is re-parsed
 * with a sentinel heading after it and must have exactly the intended structure, or its
 * user fields fall back to "all raw HTML as code", then to their source verbatim in a
 * code block (see `renderSegment`). Do not join user Markdown as strings, and do not
 * add a segment that does not start with an export heading.
 */

type ExportFile = ProjectExportJson['files'][number];
type Blocks = RootContent[];
type Mode = 'normal' | 'strict' | 'verbatim';

const WRITE: WriteOptions = {
  extensions: [gfmToMarkdown({ tablePipeAlign: false })],
  bullet: '*',
  bulletOther: '-',
  fence: '`',
  fences: true,
  rule: '-',
  setext: false,
};

const SENTINEL = 'heph-export-sentinel';

/** How user fields of a segment are turned into blocks. */
type Field = (md: string) => Blocks;
/**
 * A piece of the document that starts with one of the export's own headings (or is the
 * whole `demote` input) and is written and checked on its own.
 */
type Segment = (field: Field) => Blocks;

const FIELD: Record<Mode, Field> = {
  normal: (md) => parseUser(md, false),
  strict: (md) => parseUser(md, true),
  verbatim: (md) => asVerbatim(md),
};

export function renderMarkdown(x: ProjectExportJson): string {
  const segments: Segment[] = [
    ...projectSegments(x),
    ...roadmapSegments(x.project.phases),
    ...docsSegments(x.docs),
    materialsSegment(x.materials),
    filesSegment(x.files),
    ...diarySegments(x.diary, x.files),
  ];
  return `${segments.map(renderSegment).join('\n\n')}\n`;
}

/**
 * User Markdown as it would appear at the top level of the export: headings two levels
 * down (at most 6), risky raw HTML as code, with the same check and fallbacks.
 */
export function demote(md: string): string {
  return renderSegment((field) => field(md));
}

/**
 * Writes a segment and re-parses it with a sentinel heading after it. The result is
 * kept only when the re-parse has exactly the intended structure (so the segment adds
 * no heading and swallows nothing after it); otherwise its user fields are retried with
 * all raw HTML as code, then verbatim. Every segment after the first starts with an
 * ATX heading, which no closed block can absorb, so checking segments one by one is
 * as strong as checking the whole document, and the cost of the (superlinear) parser
 * stays bounded by the largest segment instead of the whole project (D53).
 */
function renderSegment(segment: Segment): string {
  let md = '';
  for (const mode of ['normal', 'strict', 'verbatim'] as const) {
    try {
      const blocks = segment(FIELD[mode]);
      md = write({ type: 'root', children: blocks }).trimEnd();
      const probe: Root = { type: 'root', children: [...blocks, heading(2, SENTINEL)] };
      if (same(parseMd(`${md}\n\n## ${SENTINEL}`), probe)) return md;
    } catch (err) {
      // A writer or parser failure (e.g. stack overflow) falls through to the next mode;
      // the verbatim mode only writes flat code blocks and plain text.
      if (mode === 'verbatim') throw err;
    }
  }
  return md;
}

// ------------------------------------------------------------ document

function projectSegments(x: ProjectExportJson): Segment[] {
  const p = x.project;
  const facts: PhrasingContent[][] = [
    [text('Slug: '), { type: 'inlineCode', value: p.slug }],
    [text(`Status: ${p.lifecycleStatus}${p.statusNote.trim() ? ` (${p.statusNote})` : ''}`)],
    [
      text(
        `Progress: ${p.progress.done}/${p.progress.total} (${Math.round(p.progress.ratio * 100)}%)`,
      ),
    ],
    [text(`Next task: ${p.nextTask ? `#${p.nextTask.id} ${p.nextTask.title}` : 'none'}`)],
  ];
  if (p.tags.length) facts.push([text(`Tags: ${p.tags.join(', ')}`)]);
  if (p.repos.length) facts.push([text(`Repos: ${p.repos.join(', ')}`)]);
  for (const l of p.links) facts.push([text('Link: '), link(l.label, l.url)]);
  facts.push([text(`Created: ${p.createdAt}`)]);
  return [
    () => [heading(1, p.name), para(`Exported from Hephaestus on ${x.exportedAt}.`)],
    (field) => [
      heading(2, 'Project'),
      list(facts.map((f) => item([{ type: 'paragraph', children: f }]))),
      ...field(p.description),
    ],
  ];
}

function roadmapSegments(phases: PhaseView[]): Segment[] {
  if (phases.length === 0) return [() => [heading(2, 'Roadmap'), para('No phases.')]];
  return [
    () => [heading(2, 'Roadmap')],
    ...phases.map(
      (ph): Segment =>
        (field) => {
          const out: Blocks = [
            heading(
              3,
              `${ph.position + 1}. ${ph.title} (${ph.status}, ${ph.progress.done}/${ph.progress.total})`,
            ),
            ...field(ph.description),
          ];
          if (ph.tasks.length) {
            out.push(
              list(
                ph.tasks.map((t) =>
                  item(
                    [para(`#${t.id} ${t.title}`), ...(field(t.notes) as BlockContent[])],
                    t.done,
                  ),
                ),
              ),
            );
          }
          return out;
        },
    ),
  ];
}

function docsSegments(docs: ProjectDocsView): Segment[] {
  if (docs.source === 'internal') {
    return [
      (field) => {
        const body = field(docs.internal);
        return [heading(2, 'Documentation'), ...(body.length ? body : [para('Empty.')])];
      },
    ];
  }
  if (docs.repos.length === 0) {
    return [() => [heading(2, 'Documentation'), para('Repo docs, but no linked repo.')]];
  }
  return [
    () => [heading(2, 'Documentation')],
    ...docs.repos.map(
      (r): Segment =>
        (field) => {
          const body = r.content ? field(r.content) : [];
          return [
            heading(3, `${r.fullName}: ${r.docsPath}`),
            ...(body.length ? body : [para('Not synced yet.')]),
          ];
        },
    ),
  ];
}

function materialsSegment(materials: MaterialView[]): Segment {
  return () => {
    const out: Blocks = [heading(2, 'Materials')];
    if (materials.length === 0) return [...out, para('None.')];
    const cell = (c: PhrasingContent[]): TableCell => ({ type: 'tableCell', children: c });
    const row = (cells: PhrasingContent[][]) => ({
      type: 'tableRow' as const,
      children: cells.map(cell),
    });
    const table: Table = {
      type: 'table',
      align: [null, null, null, null],
      children: [
        row([[text('Name')], [text('Quantity')], [text('Price')], [text('Status')]]),
        ...materials.map((m) =>
          row([
            [m.link ? link(m.name, m.link) : text(m.name)],
            [text(`${m.quantity}${m.unit ? ` ${m.unit}` : ''}`)],
            m.price === null ? [] : [text(`${m.price} ${m.currency}`)],
            [text(m.status)],
          ]),
        ),
      ],
    };
    return [...out, table];
  };
}

function filesSegment(files: ExportFile[]): Segment {
  return () => {
    const out: Blocks = [heading(2, 'Files')];
    if (files.length === 0) return [...out, para('None.')];
    return [...out, list(files.map((f) => item([{ type: 'paragraph', children: [fileRef(f)] }])))];
  };
}

function diarySegments(diary: DiaryEntryView[], files: ExportFile[]): Segment[] {
  if (diary.length === 0) return [() => [heading(2, 'Diary'), para('Empty.')]];
  const byId = new Map(files.map((f) => [f.id, f]));
  return [
    () => [heading(2, 'Diary')],
    ...diary.map(
      (e): Segment =>
        (field) => {
          const kind = e.eventKind ? `${e.type}/${e.eventKind}` : e.type;
          const out: Blocks = [
            heading(3, `${e.occurredAt} · ${kind} · ${e.source}`),
            ...field(e.body),
          ];
          if (e.files.length) {
            out.push(
              list(
                e.files.map((f) => {
                  const full = byId.get(f.id);
                  return item([
                    { type: 'paragraph', children: [full ? fileRef(full) : text(f.originalName)] },
                  ]);
                }),
              ),
            );
          }
          return out;
        },
    ),
  ];
}

function fileRef(f: ExportFile): PhrasingContent {
  const label = f.caption || f.originalName;
  return f.exportPath
    ? link(label, f.exportPath)
    : text(`${label} (missing on disk, not exported)`);
}

// ------------------------------------------------------------ user Markdown

function asVerbatim(md: string): Blocks {
  const src = normalize(md);
  return src ? [{ type: 'code', lang: 'markdown', meta: null, value: src }] : [];
}

function normalize(md: string): string {
  // Only blank lines go: leading spaces of the first line are meaningful (indented code).
  // NUL becomes U+FFFD as the parser would, so code values compare equal after re-parse.
  return md
    .replace(/\r\n?/g, '\n')
    .replace(/\0/g, '�')
    .replace(/^(?:[ \t]*\n)+/, '')
    .trimEnd();
}

function parseUser(md: string, strict: boolean): Blocks {
  const src = normalize(md);
  if (!src) return [];
  const tree = parseMd(src);
  // The writer recurses per nesting level and is superlinear in nested emphasis, so
  // deeply nested input goes verbatim instead of overflowing the stack or blocking (D53).
  if (nestingDepth(tree) > MAX_NESTING) return asVerbatim(src);
  rewrite(tree, strict);
  return tree.children;
}

const MAX_NESTING = 32;

/** Deepest node nesting, computed without recursion. */
function nestingDepth(root: Root): number {
  let max = 0;
  const stack: [Nodes, number][] = [[root, 0]];
  while (stack.length) {
    const [n, d] = stack.pop() as [Nodes, number];
    if (d > max) max = d;
    if (max > MAX_NESTING) return max;
    if ('children' in n) for (const c of n.children) stack.push([c as Nodes, d + 1]);
  }
  return max;
}

/** Parents whose `html` children are HTML blocks; anywhere else `html` is inline. */
const FLOW_PARENTS = new Set(['root', 'blockquote', 'listItem', 'footnoteDefinition']);

/**
 * Moves headings down two levels (at most 6) and turns risky raw HTML into code: an
 * HTML block that never ends would swallow what follows, and inline HTML spanning lines
 * is re-indented by the writer. `strict` turns every raw HTML node into code.
 */
function rewrite(node: Nodes, strict: boolean): void {
  if (!('children' in node)) return;
  const kids = node.children as Nodes[];
  const flow = FLOW_PARENTS.has(node.type);
  for (let i = 0; i < kids.length; i++) {
    const child = kids[i] as Nodes;
    if (child.type === 'heading') child.depth = Math.min(6, child.depth + 2) as Heading['depth'];
    if (child.type === 'html') {
      if (flow && (strict || !htmlBlockEnds(child.value))) {
        kids[i] = { type: 'code', lang: 'html', meta: null, value: child.value };
      } else if (!flow && (strict || child.value.includes('\n'))) {
        kids[i] = { type: 'inlineCode', value: child.value };
      }
      continue;
    }
    rewrite(child, strict);
  }
}

/** Whether an HTML block of CommonMark types 1–5 contains its end condition. */
function htmlBlockEnds(html: string): boolean {
  const v = html.trimStart();
  if (v.startsWith('<!--')) return v.includes('-->', 2);
  if (v.startsWith('<?')) return v.includes('?>', 1);
  if (v.startsWith('<![CDATA[')) return v.includes(']]>');
  if (/^<![A-Za-z]/.test(v)) return v.includes('>');
  // Type 1 ends at any of the four end tags, written exactly (CommonMark 0.31).
  if (/^<(pre|script|style|textarea)(?=[\s>]|$)/i.test(v)) {
    return /<\/(pre|script|style|textarea)>/i.test(v);
  }
  return true;
}

// ------------------------------------------------------------ write, parse, compare

function write(tree: Root): string {
  return serialize(tree, WRITE);
}

function parseMd(md: string): Root {
  return fromMarkdown(md, { extensions: [gfm()], mdastExtensions: [gfmFromMarkdown()] });
}

/** Same document structure and text (positions, spread, URLs and whitespace runs aside). */
function same(a: Root, b: Root): boolean {
  return JSON.stringify(sig(a)) === JSON.stringify(sig(b));
}

function sig(n: Nodes): unknown {
  const out: unknown[] = [n.type];
  switch (n.type) {
    case 'heading':
      out.push(n.depth);
      break;
    case 'list':
      out.push(n.ordered ?? false, n.ordered ? (n.start ?? 1) : null);
      break;
    case 'listItem':
      out.push(n.checked ?? null);
      break;
    case 'code':
      out.push(n.lang ?? null, n.value);
      break;
    case 'inlineCode':
    case 'html':
      out.push(squash(n.value));
      break;
    case 'image':
      out.push(squash(n.alt ?? ''));
      break;
    case 'definition':
    case 'footnoteDefinition':
    case 'imageReference':
    case 'footnoteReference':
      out.push(n.identifier);
      break;
  }
  if ('children' in n) {
    const kids: unknown[] = [];
    let run: string | null = null;
    for (const c of inlineLinks(n.children as Nodes[])) {
      if (c.type === 'text') {
        run = (run ?? '') + c.value;
        continue;
      }
      if (run !== null && squash(run)) kids.push(['text', squash(run)]);
      run = null;
      kids.push(sig(c));
    }
    if (run !== null && squash(run)) kids.push(['text', squash(run)]);
    out.push(kids);
  } else if (n.type === 'text') {
    out.push(squash(n.value));
  }
  return out;
}

/**
 * Links and link references are compared as their text: GFM turns URLs in plain text
 * into links, and a `[x]` becomes a reference when another field defines `x`. Neither
 * can change the block structure the check is about.
 */
function inlineLinks(nodes: Nodes[]): Nodes[] {
  return nodes.flatMap((c) =>
    c.type === 'link' || c.type === 'linkReference' ? inlineLinks(c.children as Nodes[]) : [c],
  );
}

function squash(s: string): string {
  return s
    .replace(/\0/g, '�') // the parser replaces NUL with U+FFFD
    .replace(/[[\]]/g, '') // brackets of link references
    .replace(/\s+/g, ' ')
    .trim();
}

// ------------------------------------------------------------ node helpers

function oneLine(s: string): string {
  return s.replace(/\s+/g, ' ').trim();
}

function text(value: string): PhrasingContent {
  // Keep a trailing space: "Slug: " is followed by inline code.
  return {
    type: 'text',
    value: value.replace(/\0/g, '�').replace(/\s+/g, ' ').replace(/^ /, ''),
  };
}

function para(value: string): BlockContent {
  return { type: 'paragraph', children: [text(oneLine(value))] };
}

function heading(depth: Heading['depth'], value: string): Heading {
  return { type: 'heading', depth, children: [text(oneLine(value))] };
}

function link(label: string, url: string): PhrasingContent {
  return { type: 'link', url: mdUrl(url), children: [text(oneLine(label))] };
}

function list(children: ListItem[]): List {
  return { type: 'list', ordered: false, spread: false, children };
}

function item(children: BlockContent[], checked: boolean | null = null): ListItem {
  return { type: 'listItem', spread: false, checked, children };
}

/** Percent-encodes what would end or split a Markdown link destination. */
function mdUrl(url: string): string {
  return url.replace(/[()\s<>]/g, (ch) =>
    ch.charCodeAt(0) < 128
      ? `%${ch.charCodeAt(0).toString(16).toUpperCase().padStart(2, '0')}`
      : encodeURIComponent(ch),
  );
}
