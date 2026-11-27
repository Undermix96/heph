import fs from 'node:fs';
import { schema } from '@heph/core';
import { describe, expect, it } from 'vitest';
import { type Mcp, seedProject, startMcp, useMcpCleanup } from '../test/mcp.js';

useMcpCleanup();

const UI = { source: 'ui' } as const;

/** Stores a small text file through the domain and returns its id. */
async function storeFile(m: Mcp, projectId: number, name = 'notes.txt', body = 'hello') {
  const tempPath = m.d.files.tempPath();
  fs.writeFileSync(tempPath, body);
  const f = await m.d.files.ingest(
    projectId,
    { tempPath, originalName: name, declaredMime: 'text/plain' },
    UI,
  );
  return f.id;
}

const audit = (m: Mcp) => m.d.db.select().from(schema.changeLog).all();

describe('create_project / update_project', () => {
  it('create_project registers the project and returns its briefing', async () => {
    const m = await startMcp();
    const text = await m.ok('create_project', {
      name: 'Bench PSU',
      description: 'Adjustable supply',
      tags: ['hw', 'power'],
      repos: ['me/psu'],
      links: [{ label: 'Datasheet', url: 'https://example.com/ds.pdf' }],
      phases: [{ title: 'Design', description: 'Paper first', tasks: ['Pick regulator'] }],
      status: 'on_hold',
      status_note: 'Waiting for the LM317',
      session_id: 'create-session',
    });
    expect(text).toMatch(/^Created project #\d+ `bench-psu`\./);
    expect(text).toContain('# Briefing: Bench PSU');
    expect(text).toContain('Pick regulator');
    expect(text).toContain('Pass session_id "create-session"');
    const p = m.d.projects.get('bench-psu');
    expect(p.tags.sort()).toEqual(['hw', 'power']);
    expect(p.repos).toEqual(['me/psu']);
    expect(p.docsSource).toBe('repo');
    expect(p.lifecycleStatus).toBe('on_hold');
    expect(p.statusNote).toBe('Waiting for the LM317');
    expect(p.links).toEqual([
      expect.objectContaining({ label: 'Datasheet', url: 'https://example.com/ds.pdf' }),
    ]);
    expect(p.phases[0]!.description).toBe('Paper first');
    const created = m.d.diary
      .list(p.id, { limit: 50 })
      .find((e) => e.eventKind === 'project_created');
    expect(created?.source).toBe('claude_code');
    expect(created?.sessionId).toBe('create-session');
  });

  it('create_project without repos uses internal docs; duplicate repo is a tool error', async () => {
    const m = await startMcp();
    await m.ok('create_project', { name: 'Lamp', repos: ['me/lamp'] });
    expect(m.d.projects.get('lamp').repos).toEqual(['me/lamp']);
    await m.ok('create_project', { name: 'Notes' });
    expect(m.d.projects.get('notes').docsSource).toBe('internal');
    const dup = await m.call('create_project', { name: 'Lamp 2', repos: ['me/lamp'] });
    expect(dup.isError).toBe(true);
  });

  it('create_project refuses a terminal status (only open statuses are accepted)', async () => {
    const m = await startMcp();
    const r = await m.call('create_project', { name: 'Done Already', status: 'completed' });
    expect(r.isError).toBe(true);
    expect(r.text).toContain('Input validation error');
  });

  it('update_project changes name and description and replaces tags and links', async () => {
    const m = await startMcp();
    const s = await seedProject(m, {
      tags: ['a', 'b'],
      links: [{ label: 'Old', url: 'https://old.example' }],
    });
    const text = await m.ok('update_project', {
      project: s.slug,
      name: 'Spot Welder Mk2',
      description: 'Now with a foot pedal',
      tags: ['c'],
      links: [{ label: 'New', url: 'https://new.example' }],
    });
    expect(text).toBe(`Updated project #${s.id} \`${s.slug}\`.`);
    const p = m.d.projects.get(s.id);
    expect(p.name).toBe('Spot Welder Mk2');
    expect(p.slug).toBe(s.slug);
    expect(p.description).toBe('Now with a foot pedal');
    expect(p.tags).toEqual(['c']);
    expect(p.links.map((l) => l.label)).toEqual(['New']);

    await m.ok('update_project', { project: s.id, tags: [] });
    expect(m.d.projects.get(s.id).tags).toEqual([]);
    expect(m.d.projects.get(s.id).name).toBe('Spot Welder Mk2');
  });

  it('update_project with an invalid link URL is rejected', async () => {
    const m = await startMcp();
    const s = await seedProject(m);
    const r = await m.call('update_project', {
      project: s.id,
      links: [{ label: 'x', url: 'not a url' }],
    });
    expect(r.isError).toBe(true);
  });
});

describe('link_repo', () => {
  it('links a repo, then it resolves the briefing; linking it elsewhere is a tool error', async () => {
    const m = await startMcp();
    const a = await seedProject(m, { name: 'Alpha' });
    const b = await seedProject(m, { name: 'Beta' });
    const text = await m.ok('link_repo', {
      project: a.id,
      repo: 'me/alpha',
      docs_path: 'docs/DECISIONS.md',
      show_commits: false,
    });
    expect(text).toBe(
      `Linked me/alpha to #${a.id} \`${a.slug}\`. Repos: me/alpha. Docs path: docs/DECISIONS.md.`,
    );
    const repo = m.d.projects.get(a.id).repoDetails[0]!;
    expect(repo.docsPath).toBe('docs/DECISIONS.md');
    expect(repo.showCommits).toBe(false);
    expect(await m.ok('get_briefing', { repo: 'me/alpha' })).toContain('# Briefing: Alpha');

    const conflict = await m.call('link_repo', { project: b.id, repo: 'me/alpha' });
    expect(conflict.isError).toBe(true);
    expect(conflict.text).toMatch(/^Error \(\w+\): /);
    expect(m.d.projects.get(b.id).repos).toEqual([]);
    // Same repo with a different case is the same repo.
    expect((await m.call('link_repo', { project: b.id, repo: 'Me/Alpha' })).isError).toBe(true);
  });

  it('rejects a malformed repo name', async () => {
    const m = await startMcp();
    const s = await seedProject(m);
    const r = await m.call('link_repo', { project: s.id, repo: 'no-slash-here' });
    expect(r.isError).toBe(true);
    expect(m.d.projects.get(s.id).repos).toEqual([]);
  });
});

describe('log_progress', () => {
  it('without a session id stores a note from claude_code', async () => {
    const m = await startMcp();
    const s = await seedProject(m);
    const text = await m.ok('log_progress', { project: s.id, body: '  Soldered the board  ' });
    const id = Number(/Diary entry #(\d+) saved \(note\)\./.exec(text)?.[1]);
    const e = m.d.diary.get(id);
    expect(e.type).toBe('note');
    expect(e.source).toBe('claude_code');
    expect(e.sessionId).toBeNull();
    expect(e.body).toBe('Soldered the board');
  });

  it('with session_id stores a session entry with the session id', async () => {
    const m = await startMcp();
    const s = await seedProject(m);
    const text = await m.ok('log_progress', {
      project: s.slug,
      body: 'Wired the trigger',
      session_id: 'sess-0001',
    });
    expect(text).toMatch(/Diary entry #\d+ saved \(session\)\./);
    const id = Number(/#(\d+)/.exec(text)?.[1]);
    const e = m.d.diary.get(id);
    expect(e.type).toBe('session');
    expect(e.sessionId).toBe('sess-0001');
    expect(e.projectId).toBe(s.id);
  });

  it('attaches files given in file_ids', async () => {
    const m = await startMcp();
    const s = await seedProject(m);
    const f1 = await storeFile(m, s.id, 'a.txt');
    const f2 = await storeFile(m, s.id, 'b.txt');
    const text = await m.ok('log_progress', {
      project: s.id,
      body: 'See files',
      file_ids: [f1, f2],
    });
    expect(text).toContain('2 file(s)');
    const id = Number(/#(\d+)/.exec(text)?.[1]);
    expect(
      m.d.diary
        .get(id)
        .files.map((f) => f.id)
        .sort(),
    ).toEqual([f1, f2].sort());
    expect(m.d.files.get(f1).diaryEntryId).toBe(id);
  });

  it('refuses files from another project and unknown file ids', async () => {
    const m = await startMcp();
    const a = await seedProject(m, { name: 'Alpha' });
    const b = await seedProject(m, { name: 'Beta' });
    const foreign = await storeFile(m, b.id);
    const before = m.d.diary.list(a.id, { limit: 200 }).length;
    expect(
      (await m.call('log_progress', { project: a.id, body: 'x', file_ids: [foreign] })).isError,
    ).toBe(true);
    expect(
      (await m.call('log_progress', { project: a.id, body: 'x', file_ids: [9999] })).isError,
    ).toBe(true);
    expect(m.d.diary.list(a.id, { limit: 200 }).length).toBe(before);
  });

  it('unknown project and empty body are errors', async () => {
    const m = await startMcp();
    expect((await m.call('log_progress', { project: 'ghost', body: 'x' })).text).toContain(
      'not_found',
    );
    expect((await m.call('log_progress', { project: 1, body: '' })).isError).toBe(true);
  });
});

describe('set_status', () => {
  it('applies the open statuses directly with their note', async () => {
    const m = await startMcp();
    const s = await seedProject(m);
    expect(
      await m.ok('set_status', { project: s.id, status: 'on_hold', note: 'Waiting for parts' }),
    ).toBe(`Status of #${s.id} \`${s.slug}\` is now on_hold (Waiting for parts).`);
    expect(m.d.projects.get(s.id).lifecycleStatus).toBe('on_hold');

    await m.ok('set_status', {
      project: s.id,
      status: 'awaiting_manual_test',
      note: 'Weld two nickel strips',
      session_id: 's-9',
    });
    const p = m.d.projects.get(s.id);
    expect(p.lifecycleStatus).toBe('awaiting_manual_test');
    expect(p.statusNote).toBe('Weld two nickel strips');
    expect(p.attentionGroup).toBe(1);
    const ev = m.d.diary.list(s.id, { limit: 5 }).find((e) => e.eventKind === 'status_changed');
    expect(ev?.sessionId).toBe('s-9');

    expect(await m.ok('set_status', { project: s.id, status: 'in_development' })).toBe(
      `Status of #${s.id} \`${s.slug}\` is now in_development.`,
    );
    expect(m.d.projects.get(s.id).statusNote).toBe('');
  });

  it('awaiting_manual_test without a note is a tool error and changes nothing', async () => {
    const m = await startMcp();
    const s = await seedProject(m);
    for (const note of [undefined, '   ']) {
      const r = await m.call('set_status', { project: s.id, status: 'awaiting_manual_test', note });
      expect(r.isError).toBe(true);
      expect(r.text).toContain('Error (validation)');
    }
    expect(m.d.projects.get(s.id).lifecycleStatus).toBe('in_development');
  });

  it('completed / abandoned without confirmed become proposals', async () => {
    const m = await startMcp();
    const s = await seedProject(m);
    for (const status of ['completed', 'abandoned']) {
      const text = await m.ok('set_status', { project: s.id, status, reason: 'All done' });
      expect(text).toMatch(/^Not applied: created proposal #\d+ \(set_status\)\./);
      expect(text).toContain('confirmed: true');
    }
    expect(m.d.projects.get(s.id).lifecycleStatus).toBe('in_development');
    const props = m.d.proposals.list(s.id, 'pending');
    expect(props).toHaveLength(2);
    expect(props.map((p) => p.payload.status).sort()).toEqual(['abandoned', 'completed']);
    expect(props[0]!.reason).toBe('All done');
    expect(props[0]!.createdBy).toBe('claude_code');
  });

  it('confirmed: true applies completed and records the confirmation', async () => {
    const m = await startMcp();
    const s = await seedProject(m);
    const text = await m.ok('set_status', {
      project: s.id,
      status: 'completed',
      note: 'Shipped',
      confirmed: true,
    });
    expect(text).toBe(`Status of #${s.id} \`${s.slug}\` is now completed (Shipped).`);
    expect(m.d.projects.get(s.id).lifecycleStatus).toBe('completed');
    expect(m.d.proposals.list(s.id)).toHaveLength(0);
    const ev = m.d.diary.list(s.id, { limit: 5 }).find((e) => e.eventKind === 'status_changed');
    expect(JSON.stringify(ev?.data)).toContain('confirmed');
  });

  it('confirmed: false is the same as omitting it', async () => {
    const m = await startMcp();
    const s = await seedProject(m);
    const text = await m.ok('set_status', { project: s.id, status: 'abandoned', confirmed: false });
    expect(text).toContain('Not applied: created proposal #');
    expect(m.d.projects.get(s.id).lifecycleStatus).toBe('in_development');
  });
});

describe('update_docs', () => {
  it('replaces internal docs of an internal-docs project', async () => {
    const m = await startMcp();
    const s = await seedProject(m);
    const body = '# Decisions\n\n- Use M3 screws';
    expect(await m.ok('update_docs', { project: s.id, body })).toBe(
      `Internal docs of \`${s.slug}\` updated (${body.length} chars).`,
    );
    expect(m.d.projects.get(s.id).internalDocs).toBe(body);
    await m.ok('update_docs', { project: s.id, body: '' });
    expect(m.d.projects.get(s.id).internalDocs).toBe('');
  });

  it('on a repo-docs project is a tool error pointing to DECISIONS.md', async () => {
    const m = await startMcp();
    const s = await seedProject(m, { repos: ['me/welder'] });
    const r = await m.call('update_docs', { project: s.id, body: 'x' });
    expect(r.isError).toBe(true);
    expect(r.text).toContain('Error (validation)');
    expect(r.text).toContain('DECISIONS.md');
    expect(m.d.projects.get(s.id).internalDocs).toBe('');
  });
});

describe('materials', () => {
  it('add_material defaults to to_buy and prints the price in the settings currency', async () => {
    const m = await startMcp();
    const s = await seedProject(m);
    const text = await m.ok('add_material', {
      project: s.id,
      name: 'Nickel strip',
      quantity: 2,
      unit: 'm',
      price: 3.5,
      link: 'https://shop.example/nickel',
      notes: '0.15 mm',
      phase_id: s.build.id,
    });
    expect(text).toMatch(
      /^Added #\d+ Nickel strip × 2 m · to_buy · 3\.50 [A-Z]{3} · https:\/\/shop\.example\/nickel · 0\.15 mm$/,
    );
    const [mat] = m.d.materials.list(s.id);
    expect(mat).toMatchObject({
      name: 'Nickel strip',
      quantity: 2,
      unit: 'm',
      price: 3.5,
      status: 'to_buy',
      phaseId: s.build.id,
    });
  });

  it('update_material changes price and status, and clears fields with null', async () => {
    const m = await startMcp();
    const s = await seedProject(m);
    await m.ok('add_material', { project: s.id, name: 'Fuse', price: 1, unit: 'pcs' });
    const id = m.d.materials.list(s.id)[0]!.id;
    const text = await m.ok('update_material', { material_id: id, price: 1.25, status: 'ordered' });
    expect(text).toMatch(/^Updated #\d+ Fuse × 1 pcs · ordered · 1\.25 /);
    expect(m.d.materials.get(id)).toMatchObject({ price: 1.25, status: 'ordered' });

    await m.ok('update_material', { material_id: id, status: 'arrived', price: null, unit: null });
    expect(m.d.materials.get(id)).toMatchObject({ price: null, unit: null, status: 'arrived' });
    expect(await m.ok('update_material', { material_id: id, name: 'Fuse 10A' })).toContain(
      'Fuse 10A',
    );
    expect(m.d.materials.get(id).status).toBe('arrived');
  });

  it('invalid status and unknown material are errors', async () => {
    const m = await startMcp();
    const s = await seedProject(m);
    expect(
      (await m.call('add_material', { project: s.id, name: 'x', status: 'stolen' })).isError,
    ).toBe(true);
    expect((await m.call('update_material', { material_id: 999, status: 'used' })).text).toContain(
      'not_found',
    );
  });

  it('a material phase from another project is refused', async () => {
    const m = await startMcp();
    const a = await seedProject(m, { name: 'Alpha' });
    const b = await seedProject(m, { name: 'Beta' });
    const r = await m.call('add_material', { project: a.id, name: 'x', phase_id: b.design.id });
    expect(r.isError).toBe(true);
    expect(m.d.materials.list(a.id)).toHaveLength(0);
  });
});

describe('Claude write access disabled', () => {
  it('every write tool is refused as forbidden; reads keep working', async () => {
    const m = await startMcp();
    const s = await seedProject(m, { repos: ['me/welder'] });
    await m.ok('add_material', { project: s.id, name: 'Wire' });
    const matId = m.d.materials.list(s.id)[0]!.id;
    m.d.projects.update(s.id, { claudeWriteEnabled: false }, UI);
    const before = JSON.stringify(m.d.projects.get(s.id).phases);
    const auditBefore = audit(m).length;

    const writes: [string, Record<string, unknown>][] = [
      ['update_project', { project: s.id, name: 'Hacked' }],
      ['link_repo', { project: s.id, repo: 'me/other' }],
      ['log_progress', { project: s.id, body: 'x' }],
      ['set_status', { project: s.id, status: 'on_hold', note: 'x' }],
      ['set_status', { project: s.id, status: 'completed', confirmed: true }],
      ['add_phase', { project: s.id, title: 'x' }],
      ['update_phase', { phase_id: s.design.id, title: 'x' }],
      ['move_phase', { phase_id: s.design.id, position: 2 }],
      ['add_task', { phase_id: s.design.id, title: 'x' }],
      ['update_task', { task_id: s.tasks.bom.id, title: 'x' }],
      ['move_task', { task_id: s.tasks.bom.id, position: 1 }],
      ['complete_task', { task_id: s.tasks.schematic.id }],
      ['reopen_task', { task_id: s.tasks.schematic.id }],
      ['set_next_task', { project: s.id, task_id: s.tasks.wiring.id }],
      ['delete_phase', { phase_id: s.build.id }],
      ['delete_phase', { phase_id: s.build.id, confirmed: true }],
      ['delete_task', { task_id: s.tasks.bom.id }],
      ['delete_task', { task_id: s.tasks.bom.id, confirmed: true }],
      [
        'restructure_roadmap',
        { project: s.id, operations: [{ op: 'add_phase', title: 'x' }], confirmed: true },
      ],
      ['restructure_roadmap', { project: s.id, operations: [{ op: 'add_phase', title: 'x' }] }],
      ['add_material', { project: s.id, name: 'x' }],
      ['update_material', { material_id: matId, status: 'used' }],
      ['request_upload', { project: s.id }],
    ];
    for (const [name, args] of writes) {
      const r = await m.call(name, args);
      expect(r.isError, name).toBe(true);
      expect(r.text, name).toContain('Error (forbidden)');
    }
    const p = m.d.projects.get(s.id);
    expect(p.name).toBe('Spot Welder');
    expect(p.lifecycleStatus).toBe('in_development');
    expect(JSON.stringify(p.phases)).toBe(before);
    expect(m.d.proposals.list(s.id)).toHaveLength(0);
    expect(m.d.materials.list(s.id)).toHaveLength(1);
    expect(audit(m).length).toBe(auditBefore);

    // Reads still work.
    expect(await m.ok('get_briefing', { project: s.id })).toContain('read only');
    expect(await m.ok('get_project', { project: s.id })).toContain('Claude write access DISABLED');
    await m.ok('get_diary', { project: s.id });
    await m.ok('get_docs', { project: s.id });
    await m.ok('list_projects');
    await m.ok('needs_attention');
    await m.ok('search', { query: 'Schematic' });
    await m.ok('list_proposals', { project: s.id });
  });

  it('update_docs on an internal-docs project is forbidden too', async () => {
    const m = await startMcp();
    const s = await seedProject(m);
    m.d.projects.update(s.id, { claudeWriteEnabled: false }, UI);
    const r = await m.call('update_docs', { project: s.id, body: 'x' });
    expect(r.isError).toBe(true);
    expect(r.text).toContain('Error (forbidden)');
    expect(m.d.projects.get(s.id).internalDocs).toBe('');
  });

  it('other projects stay writable', async () => {
    const m = await startMcp();
    const a = await seedProject(m, { name: 'Alpha' });
    const b = await seedProject(m, { name: 'Beta' });
    m.d.projects.update(a.id, { claudeWriteEnabled: false }, UI);
    await m.ok('log_progress', { project: b.id, body: 'fine' });
    await m.ok('create_project', { name: 'Gamma' });
  });
});

describe('allowClaudeConfirm disabled', () => {
  it('confirmed destructive changes still become proposals', async () => {
    const m = await startMcp();
    const s = await seedProject(m);
    m.d.settings.update({ allowClaudeConfirm: false }, UI);

    const del = await m.ok('delete_task', { task_id: s.tasks.bom.id, confirmed: true });
    expect(del).toMatch(/^Not applied: created proposal #\d+ \(delete_task\)/);
    expect(m.d.roadmap.getTask(s.tasks.bom.id).title).toBe('BOM');

    const delPhase = await m.ok('delete_phase', { phase_id: s.build.id, confirmed: true });
    expect(delPhase).toContain('(delete_phase)');
    expect(m.d.roadmap.getPhase(s.build.id).title).toBe('Build');

    const status = await m.ok('set_status', {
      project: s.id,
      status: 'completed',
      confirmed: true,
    });
    expect(status).toContain('(set_status)');
    expect(m.d.projects.get(s.id).lifecycleStatus).toBe('in_development');

    const rs = await m.ok('restructure_roadmap', {
      project: s.id,
      operations: [{ op: 'delete_phase', phase_id: s.design.id }],
      confirmed: true,
    });
    expect(rs).toContain('(restructure_roadmap)');
    expect(m.d.roadmap.phasesOf(s.id)).toHaveLength(2);

    expect(m.d.proposals.list(s.id, 'pending')).toHaveLength(4);
    // Non-destructive writes are unaffected.
    await m.ok('set_status', { project: s.id, status: 'on_hold', note: 'x' });
    expect(m.d.projects.get(s.id).lifecycleStatus).toBe('on_hold');
  });
});

describe('write attribution', () => {
  it('writes are attributed to claude_code with the session id in the audit log', async () => {
    const m = await startMcp();
    const s = await seedProject(m);
    await m.ok('update_task', { task_id: s.tasks.bom.id, notes: 'x', session_id: 'audit-1' });
    const row = audit(m).at(-1)!;
    expect(row.source).toBe('claude_code');
    expect(row.sessionId).toBe('audit-1');
  });
});
