import { afterEach, describe, expect, it } from 'vitest';
import { SYSTEM, UI } from './context.js';
import { CLAUDE, CLAUDE_CONFIRMED, expectDomainError, seedProject } from './test/fixtures.js';
import { makeDomain, type TestDomain } from './test/helpers.js';

let t: TestDomain;
afterEach(() => t?.cleanup());

function setup() {
  t = makeDomain();
  const p = seedProject(t.d);
  return { ...t, p };
}

describe('proposals', () => {
  it('approving a set_status proposal applies it and stores the decision note', () => {
    const { d, p, clock } = setup();
    const r = d.projects.setStatus(p.id, { status: 'abandoned', note: 'Superseded' }, CLAUDE);
    if (r.applied) throw new Error('expected a proposal');
    clock.advance(5000);
    const decided = d.proposals.approve(r.proposal.id, { note: '  Agreed  ' }, UI);
    expect(decided).toMatchObject({
      state: 'approved',
      decisionNote: 'Agreed',
      decidedAt: clock.now,
    });
    const proj = d.projects.get(p.id);
    expect(proj.lifecycleStatus).toBe('abandoned');
    expect(proj.statusNote).toBe('Superseded');
    expect(proj.pendingProposals).toBe(0);
    const ev = d.diary.list(p.id).find((e) => e.eventKind === 'proposal_decided');
    expect(ev?.body).toContain('approved');
    expect(ev?.body).toContain('Agreed');
    expect(ev?.source).toBe('ui');
  });

  it('approving delete_task and delete_phase proposals applies them', () => {
    const { d, p } = setup();
    const [design, build] = p.phases;
    const taskProposal = d.roadmap.deleteTask(design!.tasks[0]!.id, CLAUDE);
    const phaseProposal = d.roadmap.deletePhase(build!.id, CLAUDE);
    expect(d.proposals.list(p.id, 'pending')).toHaveLength(2);
    d.proposals.approve(taskProposal!.id, {}, UI);
    d.proposals.approve(phaseProposal!.id, {}, UI);
    const phases = d.roadmap.phasesOf(p.id);
    expect(phases.map((x) => x.title)).toEqual(['Design']);
    expect(phases[0]!.tasks.map((x) => x.title)).toEqual(['BOM']);
    expect(d.proposals.list(p.id, 'approved')).toHaveLength(2);
  });

  it('rejecting changes nothing and stores the note; empty notes become null', () => {
    const { d, p } = setup();
    const prop = d.roadmap.deletePhase(p.phases[0]!.id, CLAUDE)!;
    const rejected = d.proposals.reject(prop.id, { note: 'Keep it' }, UI);
    expect(rejected).toMatchObject({ state: 'rejected', decisionNote: 'Keep it' });
    expect(d.roadmap.phasesOf(p.id)).toHaveLength(2);
    const prop2 = d.roadmap.deletePhase(p.phases[0]!.id, CLAUDE)!;
    expect(d.proposals.reject(prop2.id, { note: '   ' }, UI).decisionNote).toBeNull();
    const prop3 = d.roadmap.deletePhase(p.phases[0]!.id, CLAUDE)!;
    expect(d.proposals.reject(prop3.id, {}, UI).decisionNote).toBeNull();
  });

  it('a second decision is a conflict', () => {
    const { d, p } = setup();
    const a = d.roadmap.deleteTask(p.phases[0]!.tasks[0]!.id, CLAUDE)!;
    d.proposals.approve(a.id, {}, UI);
    expectDomainError(() => d.proposals.approve(a.id, {}, UI), 'conflict');
    expectDomainError(() => d.proposals.reject(a.id, {}, UI), 'conflict');
    const b = d.roadmap.deleteTask(p.phases[0]!.tasks[1]!.id, CLAUDE)!;
    d.proposals.reject(b.id, {}, UI);
    expectDomainError(() => d.proposals.approve(b.id, {}, UI), 'conflict');
    expect(d.roadmap.getTask(p.phases[0]!.tasks[1]!.id).id).toBeDefined();
  });

  it('only the user can decide', () => {
    const { d, p } = setup();
    const a = d.roadmap.deleteTask(p.phases[0]!.tasks[0]!.id, CLAUDE)!;
    for (const ctx of [CLAUDE, CLAUDE_CONFIRMED, SYSTEM, { source: 'github' as const }]) {
      expectDomainError(() => d.proposals.approve(a.id, {}, ctx), 'forbidden');
      expectDomainError(() => d.proposals.reject(a.id, {}, ctx), 'forbidden');
    }
    expect(d.proposals.get(a.id).state).toBe('pending');
  });

  it('unknown proposals are not_found', () => {
    const { d } = setup();
    expectDomainError(() => d.proposals.approve(999, {}, UI), 'not_found');
    expectDomainError(() => d.proposals.get(999), 'not_found');
  });

  it('a failing apply leaves the proposal pending', () => {
    const { d, p } = setup();
    const taskId = p.phases[0]!.tasks[0]!.id;
    const prop = d.roadmap.deleteTask(taskId, CLAUDE)!;
    d.roadmap.deleteTask(taskId, UI);
    expectDomainError(() => d.proposals.approve(prop.id, {}, UI), 'not_found');
    expect(d.proposals.get(prop.id).state).toBe('pending');
  });

  it('restructure_roadmap proposals cannot be applied yet', () => {
    const { d, p } = setup();
    const prop = d.proposals.create(p.id, 'restructure_roadmap', {}, 'rework', CLAUDE);
    expectDomainError(() => d.proposals.approve(prop.id, {}, UI), 'unsupported');
    expect(d.proposals.get(prop.id).state).toBe('pending');
    // It can still be rejected.
    expect(d.proposals.reject(prop.id, {}, UI).state).toBe('rejected');
  });

  it('lists proposals newest first, filtered by project and state', () => {
    const { d, p, clock } = setup();
    const other = seedProject(d, { name: 'Other' });
    const a = d.roadmap.deleteTask(p.phases[0]!.tasks[0]!.id, CLAUDE)!;
    clock.advance(1000);
    const b = d.roadmap.deleteTask(p.phases[0]!.tasks[1]!.id, CLAUDE)!;
    const c = d.roadmap.deleteTask(other.phases[0]!.tasks[0]!.id, CLAUDE)!;
    d.proposals.reject(c.id, {}, UI);
    expect(d.proposals.list(p.id).map((x) => x.id)).toEqual([b.id, a.id]);
    expect(d.proposals.list(null, 'pending').map((x) => x.id)).toEqual([b.id, a.id]);
    expect(d.proposals.list(other.slug, 'rejected').map((x) => x.id)).toEqual([c.id]);
    expect(d.proposals.list(null)).toHaveLength(3);
  });
});
