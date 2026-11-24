import { schema } from '@heph/core';
import { describe, expect, it } from 'vitest';
import { type Mcp, seedProject, startMcp, useMcpCleanup } from '../test/mcp.js';

useMcpCleanup();

const UI = { source: 'ui' } as const;

const titles = (m: Mcp, projectId: number) => m.d.roadmap.phasesOf(projectId).map((p) => p.title);
const taskTitles = (m: Mcp, projectId: number) =>
  m.d.roadmap.phasesOf(projectId).map((p) => p.tasks.map((t) => t.title));

describe('phases', () => {
  it('add_phase appends by default and lands at a 1-based position', async () => {
    const m = await startMcp();
    const s = await seedProject(m);
    expect(await m.ok('add_phase', { project: s.id, title: 'Test' })).toMatch(
      /^Added phase #\d+ "Test" at position 3\.$/,
    );
    expect(await m.ok('add_phase', { project: s.slug, title: 'Research', position: 1 })).toMatch(
      /at position 1\.$/,
    );
    await m.ok('add_phase', { project: s.id, title: 'Middle', position: 3, description: 'Mid' });
    expect(titles(m, s.id)).toEqual(['Research', 'Design', 'Middle', 'Build', 'Test']);
    expect(m.d.roadmap.phasesOf(s.id)[2]!.description).toBe('Mid');
  });

  it('add_phase with a position past the end appends', async () => {
    const m = await startMcp();
    const s = await seedProject(m);
    expect(await m.ok('add_phase', { project: s.id, title: 'Far', position: 99 })).toContain(
      'at position 3.',
    );
    expect(titles(m, s.id)).toEqual(['Design', 'Build', 'Far']);
    await m.ok('add_task', { phase_id: s.design.id, title: 'Far task', position: 50 });
    expect(taskTitles(m, s.id)[0]).toEqual(['Schematic', 'BOM', 'Far task']);
  });

  it('update_phase renames, describes and sets the status', async () => {
    const m = await startMcp();
    const s = await seedProject(m);
    const text = await m.ok('update_phase', {
      phase_id: s.build.id,
      title: 'Assembly',
      description: 'Put it together',
      status: 'in_progress',
    });
    expect(text).toBe(`Phase #${s.build.id} "Assembly" · in_progress · 0/2.`);
    const ph = m.d.roadmap.getPhase(s.build.id);
    expect(ph.title).toBe('Assembly');
    expect(ph.description).toBe('Put it together');
    expect(ph.status).toBe('in_progress');

    await m.ok('update_phase', { phase_id: s.build.id, status: 'done' });
    expect(m.d.roadmap.getPhase(s.build.id).status).toBe('done');
    expect((await m.call('update_phase', { phase_id: s.build.id, status: 'nope' })).isError).toBe(
      true,
    );
    expect((await m.call('update_phase', { phase_id: 9999, title: 'x' })).text).toContain(
      'not_found',
    );
  });

  it('move_phase moves to a 1-based position and prints the new order', async () => {
    const m = await startMcp();
    const s = await seedProject(m);
    await m.ok('add_phase', { project: s.id, title: 'Test' });
    const text = await m.ok('move_phase', { phase_id: s.build.id, position: 1 });
    expect(text).toMatch(
      new RegExp(
        `^Phases now:\\n1\\. Build #${s.build.id}\\n2\\. Design #${s.design.id}\\n3\\. Test #\\d+$`,
      ),
    );
    expect(titles(m, s.id)).toEqual(['Build', 'Design', 'Test']);
    await m.ok('move_phase', { phase_id: s.build.id, position: 3 });
    expect(titles(m, s.id)).toEqual(['Design', 'Test', 'Build']);
    expect((await m.call('move_phase', { phase_id: s.build.id, position: 0 })).isError).toBe(true);
  });
});

describe('tasks', () => {
  it('add_task appends by default and lands at a 1-based position', async () => {
    const m = await startMcp();
    const s = await seedProject(m);
    expect(await m.ok('add_task', { phase_id: s.design.id, title: 'Review' })).toMatch(
      new RegExp(`^Added task #\\d+ "Review" to phase #${s.design.id} at position 3\\.$`),
    );
    await m.ok('add_task', { phase_id: s.design.id, title: 'Research', position: 1 });
    await m.ok('add_task', {
      phase_id: s.design.id,
      title: 'Simulate',
      position: 3,
      notes: 'LTspice',
      link: 'https://github.com/me/welder/issues/1',
    });
    expect(taskTitles(m, s.id)[0]).toEqual(['Research', 'Schematic', 'Simulate', 'BOM', 'Review']);
    const sim = m.d.roadmap.phasesOf(s.id)[0]!.tasks[2]!;
    expect(sim.notes).toBe('LTspice');
    expect(sim.link).toBe('https://github.com/me/welder/issues/1');
    expect((await m.call('add_task', { phase_id: 9999, title: 'x' })).text).toContain('not_found');
    expect(
      (await m.call('add_task', { phase_id: s.design.id, title: 'x', link: 'nope' })).isError,
    ).toBe(true);
  });

  it('update_task changes title, notes and clears the link with null', async () => {
    const m = await startMcp();
    const s = await seedProject(m);
    await m.ok('update_task', {
      task_id: s.tasks.bom.id,
      title: 'Bill of materials',
      notes: 'Mouser',
      link: 'https://example.com/bom',
    });
    let t = m.d.roadmap.getTask(s.tasks.bom.id);
    expect(t).toMatchObject({
      title: 'Bill of materials',
      notes: 'Mouser',
      link: 'https://example.com/bom',
    });
    expect(await m.ok('update_task', { task_id: t.id, link: null })).toBe(
      `Task #${t.id} "Bill of materials" updated.`,
    );
    t = m.d.roadmap.getTask(s.tasks.bom.id);
    expect(t.link).toBeNull();
    expect(t.notes).toBe('Mouser');
  });

  it('move_task within a phase and across phases', async () => {
    const m = await startMcp();
    const s = await seedProject(m);
    expect(await m.ok('move_task', { task_id: s.tasks.bom.id, position: 1 })).toBe(
      `Task #${s.tasks.bom.id} is now 1.1 in "Design".`,
    );
    expect(taskTitles(m, s.id)).toEqual([
      ['BOM', 'Schematic'],
      ['Case', 'Wiring'],
    ]);
    expect(
      await m.ok('move_task', { task_id: s.tasks.schematic.id, phase_id: s.build.id, position: 2 }),
    ).toBe(`Task #${s.tasks.schematic.id} is now 2.2 in "Build".`);
    expect(taskTitles(m, s.id)).toEqual([['BOM'], ['Case', 'Schematic', 'Wiring']]);
    expect(m.d.roadmap.getTask(s.tasks.schematic.id).phaseId).toBe(s.build.id);
    // Positions are renumbered without gaps.
    expect(m.d.roadmap.phasesOf(s.id)[1]!.tasks.map((t) => t.position)).toEqual([0, 1, 2]);
  });

  it('move_task into a phase of another project is a tool error', async () => {
    const m = await startMcp();
    const a = await seedProject(m, { name: 'Alpha' });
    const b = await seedProject(m, { name: 'Beta' });
    const r = await m.call('move_task', {
      task_id: a.tasks.bom.id,
      phase_id: b.design.id,
      position: 1,
    });
    expect(r.isError).toBe(true);
    expect(r.text).toContain('same project');
    expect(m.d.roadmap.getTask(a.tasks.bom.id).phaseId).toBe(a.design.id);
  });

  it('complete_task returns the next task, then says when none is left', async () => {
    const m = await startMcp();
    await m.ok('create_project', {
      name: 'Tiny',
      phases: [{ title: 'Only', tasks: ['One', 'Two'] }],
    });
    const [one, two] = m.d.projects.get('tiny').phases[0]!.tasks;
    expect(await m.ok('complete_task', { task_id: one!.id, session_id: 'c-1' })).toBe(
      `Task #${one!.id} "One" done. Next task: #${two!.id} Two (phase "Only").`,
    );
    expect(m.d.roadmap.getTask(one!.id).done).toBe(true);
    const ev = m.d.diary.list('tiny', { limit: 5 }).find((e) => e.eventKind === 'task_completed');
    expect(ev?.sessionId).toBe('c-1');
    const last = await m.ok('complete_task', { task_id: two!.id });
    expect(last).toContain('No next step is defined now');
    // Completing again is idempotent.
    expect(await m.ok('complete_task', { task_id: two!.id })).toContain(
      `Task #${two!.id} "Two" done.`,
    );
    expect(
      m.d.diary.list('tiny', { limit: 50 }).filter((e) => e.eventKind === 'task_completed'),
    ).toHaveLength(2);
  });

  it('reopen_task marks the task not done and it becomes next again', async () => {
    const m = await startMcp();
    const s = await seedProject(m);
    await m.ok('complete_task', { task_id: s.tasks.schematic.id });
    expect(await m.ok('reopen_task', { task_id: s.tasks.schematic.id })).toBe(
      `Task #${s.tasks.schematic.id} "Schematic" reopened.`,
    );
    const t = m.d.roadmap.getTask(s.tasks.schematic.id);
    expect(t.done).toBe(false);
    expect(t.doneAt).toBeNull();
    expect(m.d.roadmap.nextTaskOf(s.id)?.id).toBe(s.tasks.schematic.id);
  });

  it('set_next_task overrides the next step and null returns to the default', async () => {
    const m = await startMcp();
    const s = await seedProject(m);
    expect(await m.ok('set_next_task', { project: s.id, task_id: s.tasks.wiring.id })).toBe(
      `Next task: #${s.tasks.wiring.id} Wiring (set explicitly).`,
    );
    expect(m.d.roadmap.nextTaskOf(s.id)).toMatchObject({ id: s.tasks.wiring.id, overridden: true });
    expect(await m.ok('get_briefing', { project: s.id })).toContain(
      `#${s.tasks.wiring.id} Wiring (phase 2. Build, set explicitly)`,
    );
    expect(await m.ok('set_next_task', { project: s.slug, task_id: null })).toBe(
      `Next task: #${s.tasks.schematic.id} Schematic (default).`,
    );
    expect(m.d.roadmap.nextTaskOf(s.id)?.overridden).toBe(false);
  });

  it('set_next_task refuses done tasks and tasks of another project', async () => {
    const m = await startMcp();
    const a = await seedProject(m, { name: 'Alpha' });
    const b = await seedProject(m, { name: 'Beta' });
    await m.ok('complete_task', { task_id: a.tasks.bom.id });
    expect(
      (await m.call('set_next_task', { project: a.id, task_id: a.tasks.bom.id })).isError,
    ).toBe(true);
    const foreign = await m.call('set_next_task', { project: a.id, task_id: b.tasks.bom.id });
    expect(foreign.isError).toBe(true);
    expect(foreign.text).toContain('another project');
  });

  it('completing the overridden next task falls back to the default', async () => {
    const m = await startMcp();
    const s = await seedProject(m);
    await m.ok('set_next_task', { project: s.id, task_id: s.tasks.wiring.id });
    const text = await m.ok('complete_task', { task_id: s.tasks.wiring.id });
    expect(text).toContain(`Next task: #${s.tasks.schematic.id} Schematic`);
  });
});

describe('delete_phase / delete_task', () => {
  it('without confirmed they create proposals and change nothing', async () => {
    const m = await startMcp();
    const s = await seedProject(m);
    const t = await m.ok('delete_task', {
      task_id: s.tasks.bom.id,
      reason: 'Not needed',
      session_id: 'p-1',
    });
    expect(t).toMatch(/^Not applied: created proposal #\d+ \(delete_task\)\./);
    const p = await m.ok('delete_phase', { phase_id: s.build.id });
    expect(p).toMatch(/^Not applied: created proposal #\d+ \(delete_phase\)\./);
    expect(taskTitles(m, s.id)).toEqual([
      ['Schematic', 'BOM'],
      ['Case', 'Wiring'],
    ]);
    const props = m.d.proposals.list(s.id, 'pending').sort((a, b) => a.id - b.id);
    expect(props.map((x) => x.kind)).toEqual(['delete_task', 'delete_phase']);
    expect(props[0]!.reason).toBe('Not needed');
    expect(props[0]!.sessionId).toBe('p-1');
    expect(props[0]!.payload).toMatchObject({ taskId: s.tasks.bom.id });
    expect(props[1]!.payload).toMatchObject({ phaseId: s.build.id });

    // Approving in the UI applies them.
    m.d.proposals.approve(props[0]!.id, {}, UI);
    m.d.proposals.approve(props[1]!.id, {}, UI);
    expect(taskTitles(m, s.id)).toEqual([['Schematic']]);
  });

  it('with confirmed they are applied and recorded as confirmed', async () => {
    const m = await startMcp();
    const s = await seedProject(m);
    expect(await m.ok('delete_task', { task_id: s.tasks.bom.id, confirmed: true })).toBe(
      `Task #${s.tasks.bom.id} deleted.`,
    );
    expect(await m.ok('delete_phase', { phase_id: s.build.id, confirmed: true })).toBe(
      `Phase #${s.build.id} deleted.`,
    );
    expect(taskTitles(m, s.id)).toEqual([['Schematic']]);
    expect(m.d.proposals.list(s.id)).toHaveLength(0);
    const log = m.d.db.select().from(schema.changeLog).all();
    const deletes = log.filter((r) => r.action === 'delete' || r.action.startsWith('delete'));
    expect(deletes.length).toBeGreaterThan(0);
    expect(deletes.every((r) => r.confirmed)).toBe(true);
    expect(
      (await m.call('delete_task', { task_id: s.tasks.bom.id, confirmed: true })).text,
    ).toContain('not_found');
  });

  it('unknown ids are not_found even without confirmed (no proposal created)', async () => {
    const m = await startMcp();
    const s = await seedProject(m);
    expect((await m.call('delete_task', { task_id: 9999 })).isError).toBe(true);
    expect((await m.call('delete_phase', { phase_id: 9999 })).isError).toBe(true);
    expect(m.d.proposals.list(s.id)).toHaveLength(0);
  });
});

describe('restructure_roadmap', () => {
  const ops = (s: Awaited<ReturnType<typeof seedProject>>) => [
    { op: 'add_phase', ref: 'test', title: 'Test', position: 1 },
    { op: 'add_task', phase: 'test', title: 'Smoke test' },
    { op: 'add_task', phase: 'test', title: 'Burn-in', position: 1 },
    { op: 'move_task', task_id: s.tasks.case.id, phase: 'test', position: 3 },
    { op: 'update_phase', phase: s.design.id, title: 'Schematic design' },
    { op: 'update_task', task_id: s.tasks.bom.id, title: 'Bill of materials' },
    { op: 'delete_task', task_id: s.tasks.wiring.id },
    { op: 'move_phase', phase: s.build.id, position: 1 },
  ];
  const expected = {
    titles: ['Build', 'Test', 'Schematic design'],
    tasks: [[], ['Burn-in', 'Smoke test', 'Case'], ['Schematic', 'Bill of materials']],
  };

  it('without confirmed creates a proposal whose text shows the proposed outline', async () => {
    const m = await startMcp();
    const s = await seedProject(m);
    const text = await m.ok('restructure_roadmap', {
      project: s.id,
      operations: ops(s),
      reason: 'Add a test phase',
      session_id: 'r-1',
    });
    expect(text).toMatch(/^Not applied: created proposal #\d+ \(restructure_roadmap\)\./);
    expect(text).toContain('Proposed roadmap:');
    const outline = text.slice(text.indexOf('Proposed roadmap:'));
    expect(outline).toContain('1. Build');
    expect(outline).toContain('2. Test');
    expect(outline).toContain('   2.1 [ ] Burn-in');
    expect(outline).toContain('   2.2 [ ] Smoke test');
    expect(outline).toContain('   2.3 [ ] Case');
    expect(outline).toContain('3. Schematic design');
    expect(outline).toContain('   3.2 [ ] Bill of materials');
    expect(outline).not.toContain('Wiring');

    // Nothing changed.
    expect(titles(m, s.id)).toEqual(['Design', 'Build']);
    expect(taskTitles(m, s.id)).toEqual([
      ['Schematic', 'BOM'],
      ['Case', 'Wiring'],
    ]);
    const [prop] = m.d.proposals.list(s.id, 'pending');
    expect(prop!.kind).toBe('restructure_roadmap');
    expect(prop!.reason).toBe('Add a test phase');
    expect(prop!.sessionId).toBe('r-1');
    expect(prop!.payload.before).toEqual([
      '1. Design',
      '   1.1 [ ] Schematic',
      '   1.2 [ ] BOM',
      '2. Build',
      '   2.1 [ ] Case',
      '   2.2 [ ] Wiring',
    ]);

    // Approving applies the stored batch.
    m.d.proposals.approve(prop!.id, {}, UI);
    expect(titles(m, s.id)).toEqual(expected.titles);
    expect(taskTitles(m, s.id)).toEqual(expected.tasks);
  });

  it('with confirmed applies the batch atomically and prints the new roadmap', async () => {
    const m = await startMcp();
    const s = await seedProject(m);
    const text = await m.ok('restructure_roadmap', {
      project: s.slug,
      operations: ops(s),
      confirmed: true,
    });
    expect(text.split('\n')[0]).toBe('Roadmap restructured:');
    expect(text).toContain('1. **Build**');
    expect(text).toMatch(/2\. \*\*Test\*\* #\d+ · todo · 0\/3/);
    expect(text).toMatch(/- \[ \] 2\.1 #\d+ Burn-in/);
    expect(text).toContain(`- [ ] 2.3 #${s.tasks.case.id} Case`);
    expect(titles(m, s.id)).toEqual(expected.titles);
    expect(taskTitles(m, s.id)).toEqual(expected.tasks);
    expect(m.d.proposals.list(s.id)).toHaveLength(0);
    const ev = m.d.diary
      .list(s.id, { limit: 5 })
      .find((e) => e.eventKind === 'roadmap_restructured');
    expect(ev?.body).toContain('8 operations');
    expect(JSON.stringify(ev?.data)).toContain('confirmed');
  });

  it('positions in operations are 1-based', async () => {
    const m = await startMcp();
    const s = await seedProject(m);
    await m.ok('restructure_roadmap', {
      project: s.id,
      confirmed: true,
      operations: [
        { op: 'add_phase', title: 'First', position: 1 },
        { op: 'add_phase', title: 'Second', position: 2 },
        { op: 'add_task', phase: s.design.id, title: 'Top', position: 1 },
        { op: 'add_task', phase: s.design.id, title: 'Second task', position: 2 },
        { op: 'move_task', task_id: s.tasks.wiring.id, position: 1 },
      ],
    });
    expect(titles(m, s.id)).toEqual(['First', 'Second', 'Design', 'Build']);
    expect(taskTitles(m, s.id)).toEqual([
      [],
      [],
      ['Top', 'Second task', 'Schematic', 'BOM'],
      ['Wiring', 'Case'],
    ]);
  });

  it('refs: unknown or duplicate refs are errors naming operations[i]', async () => {
    const m = await startMcp();
    const s = await seedProject(m);
    const unknownRef = await m.call('restructure_roadmap', {
      project: s.id,
      confirmed: true,
      operations: [
        { op: 'add_phase', ref: 'a', title: 'A' },
        { op: 'add_task', phase: 'b', title: 'x' },
      ],
    });
    expect(unknownRef.isError).toBe(true);
    expect(unknownRef.text).toContain('operations[1]');
    expect(unknownRef.text).toContain('"b"');

    const dup = await m.call('restructure_roadmap', {
      project: s.id,
      operations: [
        { op: 'add_phase', ref: 'a', title: 'A' },
        { op: 'add_phase', ref: 'a', title: 'B' },
      ],
    });
    expect(dup.isError).toBe(true);
    expect(dup.text).toContain('operations[1]');
    expect(titles(m, s.id)).toEqual(['Design', 'Build']);
    expect(m.d.proposals.list(s.id)).toHaveLength(0);
  });

  it('invalid ids are errors naming operations[i], with or without confirmed, and nothing changes', async () => {
    const m = await startMcp();
    const a = await seedProject(m, { name: 'Alpha' });
    const b = await seedProject(m, { name: 'Beta' });
    const cases: [number, Record<string, unknown>][] = [
      [2, { op: 'delete_task', task_id: 9999 }],
      [2, { op: 'delete_phase', phase_id: 9999 }],
      [2, { op: 'update_phase', phase: 9999, title: 'x' }],
      [2, { op: 'move_phase', phase: b.design.id, position: 1 }],
      [2, { op: 'add_task', phase: b.design.id, title: 'x' }],
      [2, { op: 'move_task', task_id: b.tasks.bom.id, position: 1 }],
      [2, { op: 'update_task', task_id: b.tasks.bom.id, title: 'x' }],
      [2, { op: 'move_task', task_id: a.tasks.bom.id, phase: b.design.id, position: 1 }],
    ];
    for (const [i, bad] of cases) {
      for (const confirmed of [true, false]) {
        const r = await m.call('restructure_roadmap', {
          project: a.id,
          confirmed,
          operations: [
            { op: 'add_phase', title: 'Will be rolled back' },
            { op: 'delete_task', task_id: a.tasks.schematic.id },
            bad,
          ],
        });
        expect(r.isError, JSON.stringify(bad)).toBe(true);
        expect(r.text, JSON.stringify(bad)).toContain(`operations[${i}]`);
      }
    }
    expect(titles(m, a.id)).toEqual(['Design', 'Build']);
    expect(taskTitles(m, a.id)[0]).toEqual(['Schematic', 'BOM']);
    expect(taskTitles(m, b.id)[0]).toEqual(['Schematic', 'BOM']);
    expect(m.d.proposals.list(null)).toHaveLength(0);
  });

  it('a task deleted earlier in the batch cannot be used later', async () => {
    const m = await startMcp();
    const s = await seedProject(m);
    const r = await m.call('restructure_roadmap', {
      project: s.id,
      confirmed: true,
      operations: [
        { op: 'delete_task', task_id: s.tasks.bom.id },
        { op: 'update_task', task_id: s.tasks.bom.id, title: 'x' },
      ],
    });
    expect(r.isError).toBe(true);
    expect(r.text).toContain('operations[1]');
    expect(taskTitles(m, s.id)[0]).toEqual(['Schematic', 'BOM']);
  });

  it('schema errors in operations are input validation errors', async () => {
    const m = await startMcp();
    const s = await seedProject(m);
    for (const op of [
      { op: 'add_phase' },
      { op: 'move_phase', phase: s.design.id, position: 0 },
      { op: 'delete_task' },
      { op: 'add_task', phase: s.design.id, title: '' },
    ]) {
      const r = await m.call('restructure_roadmap', { project: s.id, operations: [op] });
      expect(r.isError, JSON.stringify(op)).toBe(true);
      expect(r.text).toContain('Input validation error');
    }
  });
});
