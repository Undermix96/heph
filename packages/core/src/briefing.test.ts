import { eq } from 'drizzle-orm';
import { afterEach, describe, expect, it } from 'vitest';
import { UI } from './context.js';
import { claudeSessions, projectRepos } from './db/schema.js';
import type { Domain } from './domain.js';
import { badgeLabel } from './format.js';
import {
  CLAUDE,
  expectDomainError,
  insertLiveSession,
  seedProject,
  taskIds,
} from './test/fixtures.js';
import { makeDomain, type TestDomain } from './test/helpers.js';
import { DAY_MS } from './util.js';

let t: TestDomain;
afterEach(() => t?.cleanup());

function setup() {
  t = makeDomain();
  const p = seedProject(t.d);
  return { ...t, p };
}

/** Inserts a claude_sessions row linking `sessionId` to a project (or to none). */
function linkSession(d: Domain, sessionId: string, projectId: number | null, ended = false) {
  const now = d.now();
  d.db
    .insert(claudeSessions)
    .values({
      sessionId,
      projectId,
      repo: null,
      startedAt: now,
      lastHeartbeatAt: now,
      endedAt: ended ? now : null,
      createdAt: now,
      updatedAt: now,
    })
    .run();
}

/** The lines of a `## Heading` section, up to the next `## `. */
function section(text: string, heading: string): string {
  const start = text.indexOf(`## ${heading}`);
  if (start < 0) return '';
  const rest = text.slice(start + 3);
  const end = rest.indexOf('\n## ');
  return end < 0 ? rest : rest.slice(0, end);
}

describe('briefing: resolve', () => {
  it('resolves by project id, numeric string and slug', () => {
    const { d, p } = setup();
    expect(d.briefing.resolve({ project: p.id })).toBe(p.id);
    expect(d.briefing.resolve({ project: String(p.id) })).toBe(p.id);
    expect(d.briefing.resolve({ project: p.slug })).toBe(p.id);
  });

  it('an unknown project is not_found', () => {
    const { d } = setup();
    expectDomainError(() => d.briefing.resolve({ project: 'nope' }), 'not_found');
    expectDomainError(() => d.briefing.resolve({ project: 9999 }), 'not_found');
  });

  it('project wins over repo, repo wins over session', () => {
    const { d, p } = setup();
    const other = d.projects.create({ name: 'Other', repos: ['me/other'] }, UI);
    linkSession(d, 'sess-x', p.id);
    expect(d.briefing.resolve({ project: p.id, repo: 'me/other', sessionId: 'sess-x' })).toBe(p.id);
    expect(d.briefing.resolve({ repo: 'me/other', sessionId: 'sess-x' })).toBe(other.id);
  });

  it('an empty project string falls through to repo', () => {
    const { d } = setup();
    const other = d.projects.create({ name: 'Other', repos: ['me/other'] }, UI);
    expect(d.briefing.resolve({ project: '', repo: 'me/other' })).toBe(other.id);
  });

  it('resolves a repo case-insensitively and trimmed', () => {
    const { d } = setup();
    const other = d.projects.create({ name: 'Other', repos: ['Me/Other-Repo'] }, UI);
    expect(d.briefing.resolve({ repo: 'me/other-repo' })).toBe(other.id);
    expect(d.briefing.resolve({ repo: '  ME/OTHER-REPO ' })).toBe(other.id);
  });

  it('an unknown repo is not_found and suggests create_project / link_repo', () => {
    const { d } = setup();
    const e = expectDomainError(() => d.briefing.resolve({ repo: 'me/unknown' }), 'not_found');
    expect(e.message).toContain('me/unknown');
    expect(e.message).toContain('create_project');
    expect(e.message).toContain('link_repo');
    // A repo given without owner is never a slug lookup.
    const e2 = expectDomainError(() => d.briefing.resolve({ repo: 'spot-welder' }), 'not_found');
    expect(e2.message).toContain('create_project');
  });

  it('an unknown repo does not fall back to the session', () => {
    const { d, p } = setup();
    linkSession(d, 'sess-x', p.id);
    expectDomainError(
      () => d.briefing.resolve({ repo: 'me/unknown', sessionId: 'sess-x' }),
      'not_found',
    );
  });

  it('resolves via a claude_sessions row linked to a project', () => {
    const { d, p } = setup();
    linkSession(d, 'sess-linked', p.id);
    expect(d.briefing.resolve({ sessionId: 'sess-linked' })).toBe(p.id);
  });

  it('an unknown or unlinked session, or nothing at all, is a validation error', () => {
    const { d } = setup();
    linkSession(d, 'sess-unlinked', null);
    for (const target of [{ sessionId: 'sess-unknown' }, { sessionId: 'sess-unlinked' }, {}]) {
      const e = expectDomainError(() => d.briefing.resolve(target), 'validation');
      expect(e.message).toContain('project');
      expect(e.message).toContain('repo');
    }
  });
});

describe('sessions.projectFor', () => {
  it('returns the linked project, or null when unknown or unlinked', () => {
    const { d, p } = setup();
    linkSession(d, 'a', p.id);
    linkSession(d, 'b', null);
    expect(d.sessions.projectFor('a')).toBe(p.id);
    expect(d.sessions.projectFor('b')).toBeNull();
    expect(d.sessions.projectFor('missing')).toBeNull();
  });

  it('still maps an ended session to its project', () => {
    const { d, p } = setup();
    linkSession(d, 'ended', p.id, true);
    expect(d.sessions.projectFor('ended')).toBe(p.id);
  });

  it('returns null once the project is deleted (FK set null)', () => {
    const { d, p } = setup();
    linkSession(d, 'a', p.id);
    d.projects.delete(p.id, UI);
    expect(d.sessions.projectFor('a')).toBeNull();
  });
});

describe('briefing: build', () => {
  it('header has id, slug, badge, status and progress', () => {
    const { d, p } = setup();
    d.roadmap.completeTask(p.phases[0]!.tasks[0]!.id, UI);
    const proj = d.projects.get(p.id);
    const text = d.briefing.build({ project: p.id });
    expect(text.startsWith('# Briefing: Spot Welder\n')).toBe(true);
    const header = text.split('\n')[2]!;
    expect(header).toContain(`Project #${p.id}`);
    expect(header).toContain('`spot-welder`');
    expect(header).toContain(`**${badgeLabel(proj.badge)}**`);
    expect(header).toContain('status `in_development`');
    expect(header).toContain('progress 1/4 (25%)');
    expect(header).toContain('last activity just now (2026-11-24T12:00:00.000Z)');
  });

  it('shows tags and description', () => {
    const { d } = setup();
    const q = d.projects.create(
      { name: 'Tagged', tags: ['diy', 'electronics'], description: 'Line one\n\nline two' },
      UI,
    );
    const text = d.briefing.build({ project: q.id });
    expect(text).toContain('Tags: diy, electronics');
    expect(text).toContain('Line one line two');
  });

  it('labels the status note for awaiting_manual_test and on_hold', () => {
    const { d, p } = setup();
    d.projects.setStatus(
      p.id,
      { status: 'awaiting_manual_test', note: 'Weld two strips\nCheck' },
      UI,
    );
    let text = d.briefing.build({ project: p.id });
    expect(text).toContain('**What the user must test:**');
    expect(text).toContain('> Weld two strips\n> Check');

    d.projects.setStatus(p.id, { status: 'on_hold', note: 'Waiting for parts' }, UI);
    text = d.briefing.build({ project: p.id });
    expect(text).toContain('**On hold because:**');
    expect(text).toContain('> Waiting for parts');
    expect(text).not.toContain('What the user must test');

    d.projects.setStatus(p.id, { status: 'in_development', note: 'Plain note' }, UI);
    text = d.briefing.build({ project: p.id });
    expect(text).toContain('**Status note:**');
    expect(text).not.toContain('On hold because');

    d.projects.setStatus(p.id, { status: 'in_development', note: '' }, UI);
    text = d.briefing.build({ project: p.id });
    expect(text).not.toContain('**Status note:**');
  });

  it('shows the live session line (short id, repo-less, testing marker)', () => {
    const { d, p } = setup();
    let text = d.briefing.build({ project: p.id });
    expect(text).not.toContain('**Live:**');
    insertLiveSession(d, p.id, { sessionId: 'abcdef1234567890', isTesting: true });
    text = d.briefing.build({ project: p.id });
    expect(text).toContain(
      '**Live:** Claude session abcdef12 since 2026-11-24T12:00:00.000Z (running tests)',
    );
  });

  it('omits expired sessions from the live line', () => {
    const { d, p, clock } = setup();
    insertLiveSession(d, p.id, { sessionId: 'old-session-id' });
    clock.advance(DAY_MS);
    expect(d.briefing.build({ project: p.id })).not.toContain('**Live:**');
  });

  it('shows the write-disabled notice', () => {
    const { d, p } = setup();
    expect(d.briefing.build({ project: p.id })).not.toContain('write access is disabled');
    d.projects.update(p.id, { claudeWriteEnabled: false }, UI);
    expect(d.briefing.build({ project: p.id })).toContain(
      '**Claude write access is disabled for this project: read only.**',
    );
  });

  it('next task: computed default, then an explicit override', () => {
    const { d, p } = setup();
    const [[schematic], [, wiring]] = taskIds(d, p.id) as [number[], number[]];
    let next = section(d.briefing.build({ project: p.id }), 'Next task');
    expect(next).toContain(`#${schematic} Schematic (phase 1. Design)`);
    expect(next).not.toContain('set explicitly');

    d.roadmap.updateTask(wiring!, { notes: 'Use 10 AWG\nTwist pairs' }, UI);
    d.roadmap.setNextTask(p.id, wiring!, UI);
    next = section(d.briefing.build({ project: p.id }), 'Next task');
    expect(next).toContain(`#${wiring} Wiring (phase 2. Build, set explicitly)`);
    expect(next).toContain('> Use 10 AWG\n> Twist pairs');
  });

  it('warns when there is no next step and no phases', () => {
    const { d } = setup();
    const q = d.projects.create({ name: 'Empty' }, UI);
    const text = d.briefing.build({ project: q.id });
    expect(section(text, 'Next task')).toContain('⚠ No next step defined');
    expect(section(text, 'Roadmap')).toContain('No phases yet');
  });

  it('warns when every task is done; done phases are marked ✓', () => {
    const { d, p } = setup();
    for (const id of taskIds(d, p.id).flat()) d.roadmap.completeTask(id, UI);
    const text = d.briefing.build({ project: p.id });
    expect(section(text, 'Next task')).toContain('⚠ No next step defined');
    const roadmap = section(text, 'Roadmap');
    expect(roadmap).toContain(`1. Design #${p.phases[0]!.id} · done · 2/2 ✓`);
    expect(roadmap).toContain(`2. Build #${p.phases[1]!.id} · done · 2/2 ✓`);
    expect(roadmap).not.toContain('(current)');
    expect(roadmap).not.toContain('- [');
  });

  it('roadmap: current phase shows all tasks with ← next; other phases only open tasks', () => {
    const { d } = setup();
    const q = d.projects.create(
      {
        name: 'Three',
        phases: [
          { title: 'A', tasks: ['a1', 'a2'] },
          { title: 'B', tasks: ['b1', 'b2', 'b3'] },
          { title: 'C', tasks: ['c1', 'c2'] },
        ],
      },
      UI,
    );
    const [[a1, a2], [b1, b2, b3], [c1, c2]] = taskIds(d, q.id) as number[][] as [
      number[],
      number[],
      number[],
    ];
    d.roadmap.completeTask(a1!, UI);
    d.roadmap.completeTask(a2!, UI);
    d.roadmap.completeTask(b1!, UI);
    d.roadmap.completeTask(c1!, UI);
    const phases = d.roadmap.phasesOf(q.id);
    const roadmap = section(d.briefing.build({ project: q.id }), 'Roadmap');
    const lines = roadmap.split('\n');
    expect(lines).toContain(`1. A #${phases[0]!.id} · done · 2/2 ✓`);
    expect(lines).toContain(`**2. B #${phases[1]!.id} · in_progress · 1/3** (current)`);
    expect(lines).toContain(`   - [x] #${b1} b1`);
    expect(lines).toContain(`   - [ ] #${b2} b2 ← next`);
    expect(lines).toContain(`   - [ ] #${b3} b3`);
    expect(lines).toContain(`3. C #${phases[2]!.id} · in_progress · 1/2`);
    expect(lines).toContain(`   - [ ] #${c2} c2`);
    expect(roadmap).not.toContain(`#${c1} c1`);
    expect(roadmap).not.toContain(`#${a1} a1`);
    expect(roadmap.match(/← next/g)).toHaveLength(1);
  });

  it('roadmap: an override outside the current phase is marked ← next', () => {
    const { d, p } = setup();
    const wiring = taskIds(d, p.id)[1]![1]!;
    d.roadmap.setNextTask(p.id, wiring, UI);
    const roadmap = section(d.briefing.build({ project: p.id }), 'Roadmap');
    // Override lives in phase 2 (not current): it is still marked.
    expect(roadmap).toContain(`   - [ ] #${wiring} Wiring ← next`);
    expect(roadmap.match(/← next/g)).toHaveLength(1);
  });

  it('roadmap: truncates after 40 tasks', () => {
    const { d } = setup();
    const many = Array.from({ length: 30 }, (_, i) => `t${String(i + 1).padStart(2, '0')}`);
    const q = d.projects.create(
      {
        name: 'Big',
        phases: [
          { title: 'P1', tasks: many },
          { title: 'P2', tasks: many.map((x) => `u-${x}`) },
        ],
      },
      UI,
    );
    const roadmap = section(d.briefing.build({ project: q.id }), 'Roadmap');
    const taskLines = roadmap.split('\n').filter((l) => l.startsWith('   - ['));
    expect(taskLines).toHaveLength(40);
    expect(roadmap).toContain('t30');
    expect(roadmap).toContain('u-t10');
    expect(roadmap).not.toContain('u-t11');
    expect(roadmap).toContain('   … 20 more tasks (get_project for the full roadmap)');
    // Phase headers are always listed.
    expect(roadmap).toContain('2. P2 #');
  });

  it('roadmap: exactly 40 tasks are not truncated', () => {
    const { d } = setup();
    const many = Array.from({ length: 40 }, (_, i) => `t${i + 1}`);
    const q = d.projects.create({ name: 'Forty', phases: [{ title: 'P1', tasks: many }] }, UI);
    const roadmap = section(d.briefing.build({ project: q.id }), 'Roadmap');
    expect(roadmap.split('\n').filter((l) => l.startsWith('   - ['))).toHaveLength(40);
    expect(roadmap).not.toContain('more tasks');
  });

  it('diary: only the last 10 entries, newest first', () => {
    const { d, p, clock } = setup();
    for (let i = 1; i <= 12; i++) {
      clock.advance(60_000);
      d.diary.addNote(p.id, { body: `note-${String(i).padStart(2, '0')}` }, CLAUDE);
    }
    const diary = section(d.briefing.build({ project: p.id }), 'Recent diary');
    expect(diary).toContain('Recent diary (last 10)');
    const lines = diary.split('\n').filter((l) => l.startsWith('- '));
    expect(lines).toHaveLength(10);
    expect(lines[0]).toContain('note-12');
    expect(lines[0]).toContain('claude (session sess-1)');
    expect(lines[9]).toContain('note-03');
    expect(diary).not.toContain('note-02');
    expect(diary).not.toContain('note-01');
    expect(diary).not.toContain('project_created');
  });

  it('diary: a fresh project lists its project_created event', () => {
    const { d, p } = setup();
    const diary = section(d.briefing.build({ project: p.id }), 'Recent diary');
    expect(diary).toContain('project_created');
  });

  it('materials: only to_buy and ordered are listed', () => {
    const { d, p } = setup();
    d.materials.add(p.id, { name: 'Capacitor', quantity: 2, unit: 'pcs', price: 12.5 }, UI);
    d.materials.add(p.id, { name: 'Copper strip', status: 'ordered' }, UI);
    d.materials.add(p.id, { name: 'Arrived thing', status: 'arrived' }, UI);
    d.materials.add(p.id, { name: 'Used thing', status: 'used' }, UI);
    const text = d.briefing.build({ project: p.id });
    const mats = section(text, 'Materials pending');
    expect(mats).toMatch(/Capacitor × 2 pcs · to_buy · 12\.50 /);
    expect(mats).toContain('Copper strip × 1 · ordered');
    expect(text).not.toContain('Arrived thing');
    expect(text).not.toContain('Used thing');
  });

  it('materials: the section is omitted when nothing is pending', () => {
    const { d, p } = setup();
    d.materials.add(p.id, { name: 'Arrived thing', status: 'arrived' }, UI);
    expect(d.briefing.build({ project: p.id })).not.toContain('## Materials pending');
  });

  it('proposals: pending always, decided only within 7 days with the user note', () => {
    const { d, p, clock } = setup();
    const [[schematic, bom], [caseId]] = taskIds(d, p.id) as [number[], number[]];
    expect(d.briefing.build({ project: p.id })).not.toContain('## Proposals');

    const pending = d.roadmap.deleteTask(schematic!, CLAUDE, 'Not needed anymore')!;
    const approved = d.roadmap.deleteTask(bom!, CLAUDE)!;
    const rejected = d.roadmap.deleteTask(caseId!, CLAUDE)!;
    clock.advance(DAY_MS);
    d.proposals.approve(approved.id, { note: 'Fine, drop it' }, UI);
    d.proposals.reject(rejected.id, {}, UI);

    let props = section(d.briefing.build({ project: p.id }), 'Proposals');
    expect(props).toContain(
      `- #${pending.id} delete_task · pending since 2026-11-24T12:00:00.000Z · Not needed anymore`,
    );
    expect(props).toContain(
      `- #${approved.id} delete_task · **approved** 2026-11-25T12:00:00.000Z · user note: Fine, drop it`,
    );
    expect(props).toContain(
      `- #${rejected.id} delete_task · **rejected** 2026-11-25T12:00:00.000Z`,
    );
    expect(props).not.toMatch(new RegExp(`#${rejected.id} .*user note`));

    clock.advance(7 * DAY_MS - 1);
    props = section(d.briefing.build({ project: p.id }), 'Proposals');
    expect(props).toContain(`#${approved.id} `);

    clock.advance(1);
    props = section(d.briefing.build({ project: p.id }), 'Proposals');
    expect(props).toContain(`#${pending.id} delete_task · pending`);
    expect(props).not.toContain(`#${approved.id} `);
    expect(props).not.toContain(`#${rejected.id} `);
  });

  it('proposals: the section disappears when only old decided ones remain', () => {
    const { d, p, clock } = setup();
    const prop = d.roadmap.deletePhase(p.phases[0]!.id, CLAUDE)!;
    d.proposals.reject(prop.id, { note: 'no' }, UI);
    expect(d.briefing.build({ project: p.id })).toContain('## Proposals');
    clock.advance(8 * DAY_MS);
    expect(d.briefing.build({ project: p.id })).not.toContain('## Proposals');
  });

  it('docs: internal empty and non-empty', () => {
    const { d, p } = setup();
    let docs = section(d.briefing.build({ project: p.id }), 'Documentation');
    expect(docs).toContain('Internal docs are empty: record decisions with update_docs.');
    const body = '# Decisions\n\nUse 12 V.';
    d.projects.update(p.id, { internalDocs: body }, UI);
    const text = d.briefing.build({ project: p.id });
    docs = section(text, 'Documentation');
    expect(docs).toContain(
      `Internal docs (${body.length} chars): read with get_docs, edit with update_docs.`,
    );
    expect(section(text, 'Rules')).toContain('with update_docs');
  });

  it('docs: repo synced / not synced, and the rule names the docs path', () => {
    const { d, clock } = setup();
    const q = d.projects.create({ name: 'Repo project', repos: ['Me/Thing'] }, UI);
    const repo = q.repoDetails[0]!;
    let text = d.briefing.build({ project: q.id });
    expect(section(text, 'Documentation')).toContain(
      `- \`${repo.docsPath}\` in ${repo.fullName} (not synced yet)`,
    );
    expect(text).toContain(`Repos: ${q.repos.join(', ')}`);
    expect(section(text, 'Rules')).toContain(`in ${repo.docsPath} in the repo, in English`);

    d.db
      .update(projectRepos)
      .set({ docsUpdatedAt: clock.now })
      .where(eq(projectRepos.id, repo.id))
      .run();
    clock.advance(2 * 3_600_000);
    text = d.briefing.build({ project: q.id });
    expect(section(text, 'Documentation')).toContain(
      `- \`${repo.docsPath}\` in ${repo.fullName} (synced 2 h ago)`,
    );
  });

  it('docs: repo source without a linked repo', () => {
    const { d } = setup();
    const q = d.projects.create({ name: 'No repo', docsSource: 'repo' }, UI);
    const text = d.briefing.build({ project: q.id });
    expect(section(text, 'Documentation')).toContain('no repo is linked yet (link_repo)');
    expect(section(text, 'Rules')).toContain('in DECISIONS.md in the repo');
  });

  it('links are listed', () => {
    const { d } = setup();
    const q = d.projects.create(
      { name: 'Linked', links: [{ label: 'Datasheet', url: 'https://example.com/ds.pdf' }] },
      UI,
    );
    expect(d.briefing.build({ project: q.id })).toContain(
      'Links: [Datasheet](https://example.com/ds.pdf)',
    );
  });

  it('rules: content language Italian by default, English after the setting changes', () => {
    const { d, p } = setup();
    let rules = section(d.briefing.build({ project: p.id }), 'Rules');
    expect(rules).toContain('- Diary entries (log_progress): write them in Italian.');
    expect(rules).toContain('always in English');
    d.settings.update({ contentLanguage: 'en' }, UI);
    rules = section(d.briefing.build({ project: p.id }), 'Rules');
    expect(rules).toContain('- Diary entries (log_progress): write them in English.');
    expect(rules).not.toContain('Italian');
  });

  it('rules: names the session id when given, generic hint otherwise', () => {
    const { d, p } = setup();
    let rules = section(d.briefing.build({ project: p.id, sessionId: 'sess-42' }), 'Rules');
    expect(rules).toContain('- Pass session_id "sess-42" to every write tool.');
    rules = section(d.briefing.build({ project: p.id }), 'Rules');
    expect(rules).not.toContain('session_id "');
    expect(rules).toContain('Pass your Claude Code session id as session_id');
  });

  it('builds via a linked session and names that session', () => {
    const { d, p } = setup();
    linkSession(d, 'sess-linked', p.id);
    const text = d.briefing.build({ sessionId: 'sess-linked' });
    expect(text).toContain(`Project #${p.id}`);
    expect(text).toContain('session_id "sess-linked"');
  });

  it('section order is stable', () => {
    const { d, p } = setup();
    d.materials.add(p.id, { name: 'Wire' }, UI);
    d.roadmap.deleteTask(p.phases[0]!.tasks[0]!.id, CLAUDE);
    const text = d.briefing.build({ project: p.id });
    const order = [
      '## Next task',
      '## Roadmap',
      '## Recent diary',
      '## Materials pending',
      '## Proposals',
      '## Documentation',
      '## Rules',
    ].map((h) => text.indexOf(h));
    expect(order.every((x) => x >= 0)).toBe(true);
    expect([...order].sort((a, b) => a - b)).toEqual(order);
  });
});

describe('briefing: repo given as a git remote URL', () => {
  it.each([
    'https://github.com/Me/Spot-Welder.git',
    'https://github.com/me/spot-welder',
    'git@github.com:me/spot-welder.git',
    'ssh://git@github.com/me/spot-welder.git',
  ])('resolves %s', (url) => {
    const t = makeDomain();
    const p = t.d.projects.create({ name: 'Welder', repos: ['me/spot-welder'] }, UI);
    expect(t.d.briefing.resolve({ repo: url })).toBe(p.id);
  });

  it('links repos given as URLs and suggests owner/name for unknown ones', () => {
    const t = makeDomain();
    const p = t.d.projects.create({ name: 'X', repos: ['git@github.com:me/x.git'] }, UI);
    expect(p.repos).toEqual(['me/x']);
    expect(() => t.d.briefing.resolve({ repo: 'https://github.com/me/other.git' })).toThrow(
      /repos: \["me\/other"\]/,
    );
  });
});
