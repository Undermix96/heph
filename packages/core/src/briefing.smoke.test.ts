import { describe, expect, it } from 'vitest';
import { UI } from './context.js';
import { makeDomain } from './test/helpers.js';

const CLAUDE = { source: 'claude_code' as const, sessionId: 'sess-1234abcd' };

describe('briefing + restructure smoke', () => {
  it('renders a briefing and round-trips a restructure proposal', () => {
    const { d } = makeDomain();
    const p = d.projects.create(
      {
        name: 'Spot welder',
        repos: ['me/spot-welder'],
        tags: ['diy'],
        phases: [
          { title: 'Design', tasks: ['Schematic', 'BOM'] },
          { title: 'Build', tasks: ['Case', 'Wiring'] },
        ],
      },
      UI,
    );
    d.roadmap.completeTask(p.phases[0]!.tasks[0]!.id, CLAUDE);
    d.diary.addNote(p.id, { body: 'Finished the schematic.\nNext: BOM.' }, CLAUDE);
    d.materials.add(p.id, { name: 'Capacitor 1F', quantity: 2, price: 12.5 }, UI);

    const res = d.restructure.restructure(
      p.id,
      {
        reason: 'Split build',
        operations: [
          { op: 'add_phase', ref: 'test', title: 'Testing' },
          { op: 'add_task', phase: 'test', title: 'Weld test strips' },
          { op: 'delete_task', taskId: p.phases[1]!.tasks[1]!.id },
        ],
      },
      CLAUDE,
    );
    expect(res.applied).toBe(false);
    if (res.applied) return;
    // Nothing changed yet.
    expect(d.projects.get(p.id).phases).toHaveLength(2);
    expect(res.proposal.payload.after).toContain('3. Testing');

    const text = d.briefing.build({ repo: 'me/spot-welder', sessionId: CLAUDE.sessionId });
    expect(text).toContain('## Next task');
    expect(text).toContain('BOM');
    expect(text).toContain('restructure_roadmap · pending');
    expect(text).toContain('session_id "sess-1234abcd"');
    console.log(text);

    d.proposals.approve(res.proposal.id, {}, UI);
    const after = d.projects.get(p.id);
    expect(after.phases.map((x) => x.title)).toEqual(['Design', 'Build', 'Testing']);
    expect(after.phases[1]!.tasks.map((t) => t.title)).toEqual(['Case']);
    expect(d.diary.list(p.id).map((e) => e.eventKind)).toContain('roadmap_restructured');
  });
});
