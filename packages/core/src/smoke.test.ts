import { describe, expect, it } from 'vitest';
import { UI } from './context.js';
import { makeDomain } from './test/helpers.js';

describe('domain smoke', () => {
  it('creates a project, completes tasks and gates destructive agent writes', () => {
    const { d } = makeDomain();
    const p = d.projects.create(
      {
        name: 'Saldatrice à punti',
        tags: ['DIY', 'electronics'],
        repos: ['me/spot-welder'],
        phases: [
          { title: 'Design', tasks: ['Schema', 'BOM'] },
          { title: 'Build', tasks: ['Case'] },
        ],
      },
      UI,
    );
    expect(p.slug).toBe('saldatrice-a-punti');
    expect(p.tags).toEqual(['diy', 'electronics']);
    expect(p.nextTask?.title).toBe('Schema');
    const [schemaTask] = p.phases[0]!.tasks;
    const r = d.roadmap.completeTask(schemaTask!.id, { source: 'claude_code', sessionId: 's1' });
    expect(r.nextTask?.title).toBe('BOM');
    expect(d.projects.get('me/spot-welder').progress).toMatchObject({ done: 1, total: 3 });

    const gated = d.projects.setStatus(p.id, { status: 'completed' }, { source: 'claude_code' });
    expect(gated.applied).toBe(false);
    expect(d.projects.get(p.id).lifecycleStatus).toBe('in_development');
    const proposal = d.proposals.list(p.id, 'pending')[0]!;
    d.proposals.approve(proposal.id, { note: 'ok' }, UI);
    expect(d.projects.get(p.id).lifecycleStatus).toBe('completed');

    const kinds = d.diary.list(p.id).map((e) => e.eventKind);
    expect(kinds).toContain('task_completed');
    expect(kinds).toContain('proposal_decided');
    expect(d.search.search({ q: 'saldatr' })[0]?.kind).toBe('project');
  });
});
