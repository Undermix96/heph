import { schema } from '@heph/core';
import { eq } from 'drizzle-orm';
import { describe, expect, it } from 'vitest';
import { type Mcp, seedProject, startMcp, useMcpCleanup } from '../test/mcp.js';

useMcpCleanup();

const UI = { source: 'ui' } as const;

/** Inserts a live Claude Code session row (hooks are not wired yet). */
function insertSession(m: Mcp, projectId: number, sessionId: string, repo: string | null = null) {
  const now = m.t.clock.now;
  m.d.db
    .insert(schema.claudeSessions)
    .values({
      sessionId,
      projectId,
      repo,
      startedAt: now,
      lastHeartbeatAt: now,
      createdAt: now,
      updatedAt: now,
    })
    .run();
}

describe('get_briefing', () => {
  it('resolves the project by id, slug and linked repo', async () => {
    const m = await startMcp();
    const s = await seedProject(m, { repos: ['Me/Welder'], tags: ['hw'] });
    const byId = await m.ok('get_briefing', { project: s.id });
    const bySlug = await m.ok('get_briefing', { project: s.slug });
    const byNumericString = await m.ok('get_briefing', { project: String(s.id) });
    const byRepo = await m.ok('get_briefing', { repo: 'me/welder' });
    for (const b of [byId, bySlug, byNumericString, byRepo]) {
      expect(b).toContain('# Briefing: Spot Welder');
      expect(b).toContain(`Project #${s.id} \`${s.slug}\``);
      expect(b).toContain('## Next task');
      expect(b).toContain(`#${s.tasks.schematic.id} Schematic`);
      expect(b).toContain('## Rules');
    }
    expect(byId).toContain('Tags: hw');
    // Lookup is case-insensitive; the display keeps the case as given.
    expect(byId).toContain('Repos: Me/Welder');
  });

  it('echoes the session id into the rules', async () => {
    const m = await startMcp();
    const s = await seedProject(m);
    const b = await m.ok('get_briefing', { project: s.id, session_id: 'sess-42' });
    expect(b).toContain('Pass session_id "sess-42" to every write tool.');
  });

  it('project wins over repo when both are given', async () => {
    const m = await startMcp();
    const a = await seedProject(m, { name: 'Alpha', repos: ['me/alpha'] });
    await seedProject(m, { name: 'Beta', repos: ['me/beta'] });
    const b = await m.ok('get_briefing', { project: a.id, repo: 'me/beta' });
    expect(b).toContain('# Briefing: Alpha');
  });

  it('unknown repo is a tool error with a create_project hint', async () => {
    const m = await startMcp();
    const r = await m.call('get_briefing', { repo: 'me/unknown' });
    expect(r.isError).toBe(true);
    expect(r.text).toContain('Error (not_found)');
    expect(r.text).toContain('create_project with repos: ["me/unknown"]');
    expect(r.text).toContain('link_repo');
  });

  it('unknown project id / slug is a not_found tool error', async () => {
    const m = await startMcp();
    expect((await m.call('get_briefing', { project: 999 })).text).toContain('not_found');
    expect((await m.call('get_briefing', { project: 'nope' })).isError).toBe(true);
  });

  it('neither project nor repo is a tool error that explains what to pass', async () => {
    const m = await startMcp();
    await seedProject(m);
    const r = await m.call('get_briefing', {});
    expect(r.isError).toBe(true);
    expect(r.text).toContain('Error (validation)');
    expect(r.text).toContain('list_projects');
    const withUnknownSession = await m.call('get_briefing', { session_id: 'never-seen' });
    expect(withUnknownSession.isError).toBe(true);
  });

  it('falls back to the project of a known Claude session and shows it live', async () => {
    const m = await startMcp();
    await seedProject(m, { name: 'Alpha' });
    const b = await seedProject(m, { name: 'Beta' });
    insertSession(m, b.id, 'live-session-123456', 'me/beta');
    const text = await m.ok('get_briefing', { session_id: 'live-session-123456' });
    expect(text).toContain('# Briefing: Beta');
    expect(text).toContain('**Live:** Claude session live-ses on me/beta since');
  });

  it('shows the status note, write lock, materials and proposals', async () => {
    const m = await startMcp();
    const s = await seedProject(m);
    await m.ok('set_status', {
      project: s.id,
      status: 'awaiting_manual_test',
      note: 'Weld two coins',
    });
    await m.ok('add_material', { project: s.id, name: 'Copper strip', price: 4.5 });
    await m.ok('delete_task', { task_id: s.tasks.bom.id, reason: 'Duplicate' });
    m.d.projects.update(s.id, { claudeWriteEnabled: false }, UI);
    const b = await m.ok('get_briefing', { project: s.id });
    expect(b).toContain('**What the user must test:**');
    expect(b).toContain('Weld two coins');
    expect(b).toContain('Claude write access is disabled');
    expect(b).toContain('## Materials pending');
    expect(b).toContain('Copper strip');
    expect(b).toContain('## Proposals');
    expect(b).toContain('delete_task · pending since');
    expect(b).toContain('Duplicate');
  });

  it('an empty roadmap warns that no next step is defined', async () => {
    const m = await startMcp();
    await m.ok('create_project', { name: 'Empty' });
    const b = await m.ok('get_briefing', { project: 'empty' });
    expect(b).toContain('No next step defined');
  });
});

describe('list_projects', () => {
  it('lists open projects and filters by status, tag and include_closed', async () => {
    const m = await startMcp();
    const a = await seedProject(m, { name: 'Alpha', tags: ['hw'] });
    const b = await seedProject(m, { name: 'Beta', tags: ['sw'] });
    const c = await seedProject(m, { name: 'Gamma', tags: ['hw'] });
    await m.ok('set_status', { project: b.id, status: 'on_hold', note: 'Waiting for parts' });
    await m.ok('set_status', { project: c.id, status: 'completed', confirmed: true });

    const all = await m.ok('list_projects');
    expect(all).toContain('2 project(s):');
    expect(all).toContain(`#${a.id} \`${a.slug}\` **Alpha**`);
    expect(all).toContain('**Beta**');
    expect(all).not.toContain('**Gamma**');
    expect(all).toContain('next #');

    const withClosed = await m.ok('list_projects', { include_closed: true });
    expect(withClosed).toContain('3 project(s):');
    expect(withClosed).toContain('**Gamma**');

    const onHold = await m.ok('list_projects', { status: 'on_hold' });
    expect(onHold).toContain('1 project(s):');
    expect(onHold).toContain('**Beta**');

    const hw = await m.ok('list_projects', { tag: 'hw' });
    expect(hw).toContain('**Alpha**');
    expect(hw).not.toContain('**Beta**');
    expect(hw).toContain('[hw]');

    const completed = await m.ok('list_projects', { status: 'completed' });
    expect(completed).toContain('**Gamma**');

    expect(await m.ok('list_projects', { tag: 'nothing' })).toBe('No projects match.');
  });

  it('says so when there are no projects', async () => {
    const m = await startMcp();
    expect(await m.ok('list_projects')).toBe('No projects match.');
  });
});

describe('needs_attention', () => {
  it('groups open projects under numbered headings in dashboard order', async () => {
    const m = await startMcp();
    const testing = await seedProject(m, { name: 'Testing' });
    await seedProject(m, { name: 'Active' });
    await m.ok('create_project', { name: 'No Steps' });
    const hold = await seedProject(m, { name: 'Holding' });
    const done = await seedProject(m, { name: 'Finished' });
    await m.ok('set_status', {
      project: testing.id,
      status: 'awaiting_manual_test',
      note: 'Press the pedal',
    });
    await m.ok('set_status', { project: hold.id, status: 'on_hold', note: 'Parts' });
    await m.ok('set_status', { project: done.id, status: 'completed', confirmed: true });

    const text = await m.ok('needs_attention');
    const h1 = text.indexOf('## 1. Awaiting a manual test from the user');
    const h3 = text.indexOf('## 3. Stalled or without a next step');
    const h4 = text.indexOf('## 4. Active');
    const h5 = text.indexOf('## 5. On hold');
    expect(h1).toBeGreaterThanOrEqual(0);
    expect(h3).toBeGreaterThan(h1);
    expect(h4).toBeGreaterThan(h3);
    expect(h5).toBeGreaterThan(h4);
    expect(text).toContain('  - to test: Press the pedal');
    expect(text.indexOf('**Testing**')).toBeGreaterThan(h1);
    expect(text.indexOf('**Testing**')).toBeLessThan(h3);
    expect(text.indexOf('**No Steps**')).toBeGreaterThan(h3);
    expect(text.indexOf('**No Steps**')).toBeLessThan(h4);
    expect(text.indexOf('**Active**')).toBeGreaterThan(h4);
    expect(text.indexOf('**Holding**')).toBeGreaterThan(h5);
    expect(text).not.toContain('**Finished**');
    expect(text).not.toContain('## 2.');
  });

  it('puts a project with a live Claude session under group 2', async () => {
    const m = await startMcp();
    const s = await seedProject(m, { name: 'Working' });
    await seedProject(m, { name: 'Idle' });
    insertSession(m, s.id, 'sess-live');
    const text = await m.ok('needs_attention');
    const h2 = text.indexOf('## 2. Claude is working on it now');
    const h4 = text.indexOf('## 4. Active');
    expect(h2).toBeGreaterThanOrEqual(0);
    expect(text.indexOf('**Working**')).toBeGreaterThan(h2);
    expect(text.indexOf('**Working**')).toBeLessThan(h4);
    expect(text.indexOf('**Idle**')).toBeGreaterThan(h4);
  });

  it('says so when no project is open', async () => {
    const m = await startMcp();
    expect(await m.ok('needs_attention')).toBe('No open projects.');
  });
});

describe('get_project', () => {
  it('prints every phase and task with ids, 1.1 numbering, materials and pending proposals', async () => {
    const m = await startMcp();
    const s = await seedProject(m, {
      repos: ['me/welder'],
      links: [{ label: 'Forum', url: 'https://example.com/forum' }],
      description: 'A capacitive spot welder.',
    });
    await m.ok('update_task', { task_id: s.tasks.case.id, notes: 'Use the 3D printer' });
    await m.ok('complete_task', { task_id: s.tasks.schematic.id });
    await m.ok('add_material', {
      project: s.id,
      name: 'Capacitor',
      quantity: 4,
      unit: 'pcs',
      price: 2.25,
    });
    await m.ok('delete_phase', { phase_id: s.build.id, reason: 'Out of scope' });

    const text = await m.ok('get_project', { project: s.slug });
    expect(text).toContain('# Spot Welder');
    expect(text).toContain(`Project #${s.id} \`${s.slug}\``);
    expect(text).toContain('A capacitive spot welder.');
    expect(text).toContain('Repos: me/welder #');
    expect(text).toContain('[Forum](https://example.com/forum)');
    expect(text).toContain(`1. **Design** #${s.design.id} · in_progress · 1/2`);
    expect(text).toContain(`2. **Build** #${s.build.id} · todo · 0/2`);
    expect(text).toMatch(new RegExp(`- \\[x\\] 1\\.1 #${s.tasks.schematic.id} Schematic · done `));
    expect(text).toContain(`- [ ] 1.2 #${s.tasks.bom.id} BOM ← next`);
    expect(text).toContain(`- [ ] 2.1 #${s.tasks.case.id} Case`);
    expect(text).toContain(`- [ ] 2.2 #${s.tasks.wiring.id} Wiring`);
    expect(text).toContain('notes: Use the 3D printer');
    expect(text).toContain('## Materials (1)');
    expect(text).toMatch(/- #\d+ Capacitor × 4 pcs · to_buy · 2\.25 /);
    expect(text).toContain('## Pending proposals');
    expect(text).toMatch(/- #\d+ delete_phase · pending · project #\d+ · reason: Out of scope/);
    expect(text).toContain('Files: 0');
  });

  it('unknown project is a not_found tool error', async () => {
    const m = await startMcp();
    const r = await m.call('get_project', { project: 'ghost' });
    expect(r.isError).toBe(true);
    expect(r.text).toContain('Error (not_found)');
  });
});

describe('get_diary', () => {
  it('pages back with the printed before/before_id cursor without gaps or duplicates', async () => {
    const m = await startMcp();
    const s = await seedProject(m);
    for (let i = 1; i <= 7; i++) {
      await m.ok('log_progress', { project: s.id, body: `Entry number ${i}` });
      if (i % 3 === 0) m.t.clock.advance(1000);
    }
    const total = m.d.diary.list(s.id, { limit: 200 }).length;
    const seen: number[] = [];
    let args: Record<string, unknown> = { project: s.id, limit: 3 };
    for (let page = 0; page < 20; page++) {
      const text = await m.ok('get_diary', args);
      if (text === 'No diary entries.') break;
      const ids = [...text.matchAll(/ #(\d+): /g)].map((x) => Number(x[1]));
      seen.push(...ids);
      const more = /More: call again with before=(\d+), before_id=(\d+)\./.exec(text);
      if (!more) break;
      args = { project: s.id, limit: 3, before: Number(more[1]), before_id: Number(more[2]) };
    }
    expect(new Set(seen).size).toBe(seen.length);
    expect(seen.length).toBe(total);
    expect([...seen].sort((a, b) => b - a)).toEqual(seen);
  });

  it('filters by type and source, and prints the session', async () => {
    const m = await startMcp();
    const s = await seedProject(m);
    await m.ok('log_progress', { project: s.id, body: 'Plain note' });
    await m.ok('log_progress', {
      project: s.id,
      body: 'From a session',
      session_id: 'abcdef123456',
    });
    m.d.diary.addNote(s.id, { body: 'Written in the UI' }, UI);

    const sessions = await m.ok('get_diary', { project: s.id, type: 'session' });
    expect(sessions).toContain('From a session');
    expect(sessions).toContain('(session abcdef12)');
    expect(sessions).not.toContain('Plain note');

    const notes = await m.ok('get_diary', { project: s.id, type: 'note' });
    expect(notes).toContain('Plain note');
    expect(notes).toContain('Written in the UI');

    const ui = await m.ok('get_diary', { project: s.id, source: 'ui' });
    expect(ui).toContain('Written in the UI');
    expect(ui).not.toContain('Plain note');

    expect(await m.ok('get_diary', { project: s.id, source: 'github' })).toBe('No diary entries.');
    // Fewer entries than the limit: no "More" hint.
    expect(await m.ok('get_diary', { project: s.id, limit: 200 })).not.toContain('More:');
  });
});

describe('search', () => {
  it('finds tasks, diary and projects and marks matches in bold', async () => {
    const m = await startMcp();
    const s = await seedProject(m);
    await m.ok('log_progress', { project: s.id, body: 'Ordered the capacitor bank today' });
    await m.ok('add_task', { phase_id: s.build.id, title: 'Capacitor bank enclosure' });

    const r = await m.ok('search', { query: 'capac' });
    expect(r).toMatch(/- diary #\d+ in `spot-welder` \(#\d+\)/);
    expect(r).toMatch(/- task #\d+ in `spot-welder`/);
    expect(r).toContain('**capacitor**');

    const onlyTasks = await m.ok('search', { query: 'capacitor', kinds: ['task'] });
    expect(onlyTasks).toContain('- task #');
    expect(onlyTasks).not.toContain('- diary #');

    const scoped = await m.ok('search', { query: 'capacitor', project: s.slug, limit: 1 });
    expect(scoped.split('\n')).toHaveLength(1);
  });

  it('reports no results and scopes by project', async () => {
    const m = await startMcp();
    const a = await seedProject(m, { name: 'Alpha' });
    await seedProject(m, { name: 'Beta' });
    await m.ok('log_progress', { project: 'beta', body: 'Unique zebra word' });
    expect(await m.ok('search', { query: 'zebra' })).toContain('beta');
    expect(await m.ok('search', { query: 'zebra', project: a.id })).toBe('No results.');
    expect(await m.ok('search', { query: 'xylophone' })).toBe('No results.');
  });

  it('survives FTS syntax, quotes, HTML and unicode in the query', async () => {
    const m = await startMcp();
    const s = await seedProject(m);
    await m.ok('log_progress', {
      project: s.id,
      body: 'Saldatura <b>ok</b> & "pulita" — perfetto',
    });
    for (const q of [
      '"',
      '***',
      'AND OR NOT',
      'NEAR(',
      "'; drop table projects; --",
      'col:value',
      '(((',
      '-',
      '😀',
      '<script>',
    ]) {
      const r = await m.call('search', { query: q });
      expect(r.isError, q).toBe(false);
      expect(r.text.length, q).toBeGreaterThan(0);
    }
    const hit = await m.ok('search', { query: 'pulita' });
    expect(hit).toContain('**pulita**');
    // Snippet HTML escapes are turned back into plain characters for the agent.
    expect(hit).toContain('<b>ok</b>');
    expect(m.d.projects.list().length).toBe(1);
  });

  it('unknown project in search is a tool error', async () => {
    const m = await startMcp();
    const r = await m.call('search', { query: 'x', project: 'ghost' });
    expect(r.isError).toBe(true);
  });
});

describe('get_docs', () => {
  it('returns internal docs, or a hint when they are empty', async () => {
    const m = await startMcp();
    const s = await seedProject(m);
    expect(await m.ok('get_docs', { project: s.id })).toBe(
      'Internal docs are empty (write them with update_docs).',
    );
    await m.ok('update_docs', { project: s.id, body: '## Use 18650 cells\n\nBecause.' });
    const docs = await m.ok('get_docs', { project: s.id });
    expect(docs).toContain('# Internal docs: Spot Welder');
    expect(docs).toContain('## Use 18650 cells');
  });

  it('repo docs: not synced yet, then the cached content', async () => {
    const m = await startMcp();
    const s = await seedProject(m, { repos: ['me/welder'] });
    const before = await m.ok('get_docs', { project: s.id });
    expect(before).toContain('# me/welder: DECISIONS.md');
    expect(before).toContain('Not synced yet');

    m.d.db
      .update(schema.projectRepos)
      .set({ docsContent: '## Decision A', docsUpdatedAt: m.t.clock.now })
      .where(eq(schema.projectRepos.projectId, s.id))
      .run();
    const after = await m.ok('get_docs', { project: s.id });
    expect(after).toContain('# me/welder: DECISIONS.md');
    expect(after).toContain('## Decision A');
    expect(after).not.toContain('Not synced yet');
  });

  it('several repos are separated', async () => {
    const m = await startMcp();
    const s = await seedProject(m, { repos: ['me/a', 'me/b'] });
    const text = await m.ok('get_docs', { project: s.id });
    expect(text).toContain('# me/a: DECISIONS.md');
    expect(text).toContain('# me/b: DECISIONS.md');
    expect(text).toContain('---');
  });
});

describe('list_proposals', () => {
  it('lists proposals, filters by state and shows the decision note', async () => {
    const m = await startMcp();
    const s = await seedProject(m);
    expect(await m.ok('list_proposals')).toBe('No proposals.');
    await m.ok('delete_task', { task_id: s.tasks.bom.id, reason: 'Merged into Schematic' });
    await m.ok('delete_task', { task_id: s.tasks.wiring.id });
    const [first, second] = m.d.proposals.list(s.id).sort((a, b) => a.id - b.id);
    m.d.proposals.reject(first!.id, { note: 'Keep the BOM separate' }, UI);

    const all = await m.ok('list_proposals', { project: s.id });
    expect(all.split('\n')).toHaveLength(2);
    expect(all).toContain(`#${first!.id} delete_task · rejected`);
    expect(all).toContain('user note: Keep the BOM separate');
    expect(all).toContain('reason: Merged into Schematic');

    const pending = await m.ok('list_proposals', { state: 'pending' });
    expect(pending).toContain(`#${second!.id} delete_task · pending`);
    expect(pending).not.toContain(`#${first!.id} `);

    const rejected = await m.ok('list_proposals', { project: s.slug, state: 'rejected' });
    expect(rejected).toContain(`#${first!.id}`);
    expect(await m.ok('list_proposals', { state: 'approved' })).toBe('No proposals.');

    m.d.proposals.approve(second!.id, { note: 'Fine' }, UI);
    const approved = await m.ok('list_proposals', { state: 'approved' });
    expect(approved).toContain(`#${second!.id} delete_task · approved`);
    expect(approved).toContain('user note: Fine');
    expect(() => m.d.roadmap.getTask(s.tasks.wiring.id)).toThrow();
  });
});
