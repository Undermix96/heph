import { afterEach, describe, expect, it } from 'vitest';
import { SYSTEM, UI } from './context.js';
import { CLAUDE, CLAUDE_CONFIRMED, expectDomainError, seedProject } from './test/fixtures.js';
import { makeDomain, type TestDomain } from './test/helpers.js';
import { DAY_MS, iso, toMs } from './util.js';

let t: TestDomain;
afterEach(() => t?.cleanup());

function setup() {
  t = makeDomain();
  return t;
}

describe('projects: slugs', () => {
  it('generates a slug from the name, stripping diacritics and punctuation', () => {
    const { d } = setup();
    const p = d.projects.create({ name: '  Lampada à LED: v2!  ' }, UI);
    expect(p.slug).toBe('lampada-a-led-v2');
  });

  it('falls back to "project" when the name has no slug characters', () => {
    const { d } = setup();
    expect(d.projects.create({ name: '!!!' }, UI).slug).toBe('project');
  });

  it('truncates long slugs to 60 characters without a trailing dash', () => {
    const { d } = setup();
    const p = d.projects.create({ name: `${'a'.repeat(59)} bcd` }, UI);
    expect(p.slug.length).toBeLessThanOrEqual(60);
    expect(p.slug.endsWith('-')).toBe(false);
  });

  it('makes generated slugs unique with a numeric suffix', () => {
    const { d } = setup();
    const a = d.projects.create({ name: 'Garden' }, UI);
    const b = d.projects.create({ name: 'Garden' }, UI);
    const c = d.projects.create({ name: 'garden!' }, UI);
    expect([a.slug, b.slug, c.slug]).toEqual(['garden', 'garden-2', 'garden-3']);
  });

  it('rejects an explicit slug that is already used', () => {
    const { d } = setup();
    d.projects.create({ name: 'Garden' }, UI);
    expectDomainError(() => d.projects.create({ name: 'Other', slug: 'garden' }, UI), 'conflict');
  });

  it('rejects an invalid explicit slug', () => {
    const { d } = setup();
    expectDomainError(() => d.projects.create({ name: 'X', slug: 'Not Valid' }, UI), 'validation');
  });

  it('renames the slug on update and rejects a taken one', () => {
    const { d } = setup();
    const a = d.projects.create({ name: 'Alpha' }, UI);
    d.projects.create({ name: 'Beta' }, UI);
    expect(d.projects.update(a.id, { slug: 'alpha-two' }, UI).slug).toBe('alpha-two');
    expect(d.projects.get('alpha-two').id).toBe(a.id);
    expectDomainError(() => d.projects.update(a.id, { slug: 'beta' }, UI), 'conflict');
    // Setting the same slug again is a no-op, not a conflict.
    expect(d.projects.update(a.id, { slug: 'alpha-two' }, UI).slug).toBe('alpha-two');
  });

  it('never generates all-digit slugs (they would clash with ids)', () => {
    const { d } = setup();
    const p = d.projects.create({ name: '1984' }, UI);
    expect(p.slug).toBe('p-1984');
    expect(d.projects.get(p.slug).id).toBe(p.id);
  });
});

describe('projects: resolution', () => {
  it('resolves by numeric id, numeric string, slug and repo full name', () => {
    const { d } = setup();
    const p = d.projects.create({ name: 'Spot Welder', repos: ['Me/Spot-Welder'] }, UI);
    expect(d.projects.get(p.id).id).toBe(p.id);
    expect(d.projects.get(String(p.id)).id).toBe(p.id);
    expect(d.projects.get('spot-welder').id).toBe(p.id);
    expect(d.projects.get('me/spot-welder').id).toBe(p.id);
    expect(d.projects.get('ME/SPOT-WELDER').id).toBe(p.id);
    expect(d.projects.get('  me/spot-welder ').id).toBe(p.id);
    expect(p.repos).toEqual(['Me/Spot-Welder']);
  });

  it('throws not_found for unknown refs', () => {
    const { d } = setup();
    expectDomainError(() => d.projects.get(999), 'not_found');
    expectDomainError(() => d.projects.get('nope'), 'not_found');
    expectDomainError(() => d.projects.get('nobody/nothing'), 'not_found');
  });

  it('rejects linking a repo already linked to another project', () => {
    const { d } = setup();
    const a = d.projects.create({ name: 'A', repos: ['me/shared'] }, UI);
    const b = d.projects.create({ name: 'B' }, UI);
    const err = expectDomainError(() => d.projects.linkRepo(b.id, 'Me/Shared', UI), 'conflict');
    expect(err.message).toContain(a.slug);
    expectDomainError(() => d.projects.create({ name: 'C', repos: ['me/shared'] }, UI), 'conflict');
    // The failed create was rolled back entirely.
    expect(d.projects.list().map((p) => p.name)).toEqual(expect.not.arrayContaining(['C']));
  });

  it('linking the same repo twice to the same project is idempotent', () => {
    const { d } = setup();
    const a = d.projects.create({ name: 'A', repos: ['me/a'] }, UI);
    const r = d.projects.linkRepo(a.id, 'me/a', UI);
    expect(r.repos).toEqual(['me/a']);
  });

  it('links, updates and unlinks repos; docsSource defaults to repo when repos exist', () => {
    const { d } = setup();
    const withRepo = d.projects.create({ name: 'A', repos: ['me/a'] }, UI);
    const without = d.projects.create({ name: 'B' }, UI);
    expect(withRepo.docsSource).toBe('repo');
    expect(without.docsSource).toBe('internal');
    const linked = d.projects.linkRepo(
      without.id,
      { fullName: 'me/b', docsPath: 'docs/DECISIONS.md' },
      UI,
    );
    const repo = linked.repoDetails[0]!;
    expect(repo.docsPath).toBe('docs/DECISIONS.md');
    expect(repo.showCommits).toBe(true);
    const upd = d.projects.updateRepo(repo.id, { showCommits: false }, UI);
    expect(upd.repoDetails[0]!.showCommits).toBe(false);
    expect(d.projects.unlinkRepo(repo.id, UI).repos).toEqual([]);
    expectDomainError(() => d.projects.get('me/b'), 'not_found');
  });

  it('rejects malformed repo names', () => {
    const { d } = setup();
    const p = d.projects.create({ name: 'A' }, UI);
    expectDomainError(() => d.projects.linkRepo(p.id, 'not a repo', UI), 'validation');
  });
});

describe('projects: tags', () => {
  it('normalizes tags (trim, lowercase, dedupe) and sorts them', () => {
    const { d } = setup();
    const p = d.projects.create({ name: 'A', tags: [' Wood ', 'DIY', 'diy', 'wood'] }, UI);
    expect(p.tags).toEqual(['diy', 'wood']);
  });

  it('replaces tags on update and drops tags no project uses', () => {
    const { d } = setup();
    const a = d.projects.create({ name: 'A', tags: ['diy', 'wood'] }, UI);
    d.projects.create({ name: 'B', tags: ['diy'] }, UI);
    expect(d.projects.allTags()).toEqual([
      { name: 'diy', count: 2 },
      { name: 'wood', count: 1 },
    ]);
    d.projects.update(a.id, { tags: ['metal'] }, UI);
    expect(d.projects.allTags()).toEqual([
      { name: 'diy', count: 1 },
      { name: 'metal', count: 1 },
    ]);
    d.projects.update(a.id, { tags: [] }, UI);
    expect(d.projects.get(a.id).tags).toEqual([]);
    expect(d.projects.allTags().map((x) => x.name)).toEqual(['diy']);
  });

  it('cleans orphan tags on the next tag write after a project is deleted', () => {
    const { d } = setup();
    const a = d.projects.create({ name: 'A', tags: ['solo'] }, UI);
    d.projects.delete(a.id, UI);
    d.projects.create({ name: 'B', tags: ['other'] }, UI);
    expect(d.projects.allTags().map((x) => x.name)).toEqual(['other']);
  });

  it('drops tags only a deleted project used', () => {
    const { d } = setup();
    const a = d.projects.create({ name: 'A', tags: ['solo'] }, UI);
    d.projects.delete(a.id, UI);
    expect(d.projects.allTags()).toEqual([]);
  });

  it('filters the list by tag, case-insensitively', () => {
    const { d } = setup();
    d.projects.create({ name: 'A', tags: ['diy'] }, UI);
    d.projects.create({ name: 'B', tags: ['code'] }, UI);
    expect(d.projects.list({ tag: 'DIY' }).map((p) => p.name)).toEqual(['A']);
  });
});

describe('projects: create / update / delete', () => {
  it('creates phases, tasks, links and a project_created diary event', () => {
    const { d } = setup();
    const p = seedProject(d, { links: [{ label: 'Docs', url: 'https://example.com/docs' }] });
    expect(p.phases.map((x) => x.title)).toEqual(['Design', 'Build']);
    expect(p.phases[0]!.tasks.map((x) => x.title)).toEqual(['Schematic', 'BOM']);
    expect(p.progress).toEqual({ done: 0, total: 4, ratio: 0 });
    expect(p.currentPhase?.title).toBe('Design');
    expect(p.links).toEqual([
      { id: expect.any(Number), label: 'Docs', url: 'https://example.com/docs' },
    ]);
    const created = d.diary.list(p.id).filter((e) => e.eventKind === 'project_created');
    expect(created).toHaveLength(1);
    expect(p.lifecycleStatus).toBe('in_development');
  });

  it('cannot be created directly as completed or abandoned', () => {
    const { d } = setup();
    expectDomainError(
      () => d.projects.create({ name: 'A', lifecycleStatus: 'completed' }, UI),
      'validation',
    );
  });

  it('only the user can toggle Claude write access', () => {
    const { d } = setup();
    const p = d.projects.create({ name: 'A' }, UI);
    expectDomainError(
      () => d.projects.update(p.id, { claudeWriteEnabled: false }, CLAUDE),
      'forbidden',
    );
    expectDomainError(
      () => d.projects.update(p.id, { claudeWriteEnabled: false }, SYSTEM),
      'forbidden',
    );
    expect(d.projects.update(p.id, { claudeWriteEnabled: false }, UI).claudeWriteEnabled).toBe(
      false,
    );
  });

  it('agent cannot edit internal docs of a repo-docs project', () => {
    const { d } = setup();
    const p = d.projects.create({ name: 'A', repos: ['me/a'] }, UI);
    expectDomainError(() => d.projects.update(p.id, { internalDocs: '# x' }, CLAUDE), 'validation');
    expect(d.projects.update(p.id, { internalDocs: '# x' }, UI).internalDocs).toBe('# x');
    const q = d.projects.create({ name: 'B' }, UI);
    expect(d.projects.update(q.id, { internalDocs: '# y' }, CLAUDE).internalDocs).toBe('# y');
  });

  it('only the user can delete a project', () => {
    const { d } = setup();
    const p = seedProject(d);
    expectDomainError(() => d.projects.delete(p.id, CLAUDE_CONFIRMED), 'forbidden');
    d.projects.delete(p.id, UI);
    expectDomainError(() => d.projects.get(p.id), 'not_found');
  });
});

describe('projects: claudeWriteEnabled', () => {
  it('blocks every claude_code write but not UI writes', () => {
    const { d } = setup();
    const p = seedProject(d);
    d.projects.update(p.id, { claudeWriteEnabled: false }, UI);
    const taskId = p.phases[0]!.tasks[0]!.id;
    const phaseId = p.phases[0]!.id;
    expectDomainError(() => d.roadmap.completeTask(taskId, CLAUDE), 'forbidden');
    expectDomainError(() => d.roadmap.addTask(phaseId, { title: 'x' }, CLAUDE), 'forbidden');
    expectDomainError(() => d.roadmap.addPhase(p.id, { title: 'x' }, CLAUDE), 'forbidden');
    expectDomainError(() => d.diary.addNote(p.id, { body: 'hi' }, CLAUDE), 'forbidden');
    expectDomainError(() => d.materials.add(p.id, { name: 'Screw' }, CLAUDE), 'forbidden');
    expectDomainError(() => d.projects.setStatus(p.id, { status: 'on_hold' }, CLAUDE), 'forbidden');
    expectDomainError(() => d.projects.update(p.id, { name: 'X' }, CLAUDE), 'forbidden');
    expectDomainError(() => d.roadmap.deleteTask(taskId, CLAUDE_CONFIRMED), 'forbidden');
    expect(d.proposals.list(p.id)).toHaveLength(0);
    // The UI is unaffected.
    expect(d.roadmap.completeTask(taskId, UI).task.done).toBe(true);
    expect(d.diary.addNote(p.id, { body: 'hi' }, UI).body).toBe('hi');
    // Reads still work for the agent.
    expect(d.projects.get(p.id).id).toBe(p.id);
  });
});

describe('projects: lifecycle status', () => {
  it('sets non-terminal statuses directly from the agent and logs status_changed', () => {
    const { d } = setup();
    const p = seedProject(d);
    const r = d.projects.setStatus(p.id, { status: 'on_hold', note: 'Waiting for parts' }, CLAUDE);
    expect(r.applied).toBe(true);
    if (!r.applied) return;
    expect(r.result.lifecycleStatus).toBe('on_hold');
    expect(r.result.statusNote).toBe('Waiting for parts');
    const ev = d.diary.list(p.id).find((e) => e.eventKind === 'status_changed');
    expect(ev?.data).toMatchObject({ from: 'in_development', to: 'on_hold' });
    expect(ev?.source).toBe('claude_code');
  });

  it('does not log status_changed when nothing changes', () => {
    const { d } = setup();
    const p = seedProject(d);
    d.projects.setStatus(p.id, { status: 'in_development' }, UI);
    expect(d.diary.list(p.id).filter((e) => e.eventKind === 'status_changed')).toHaveLength(0);
  });

  it.each(['completed', 'abandoned'] as const)(
    'agent %s without confirmation becomes a proposal',
    (status) => {
      const { d } = setup();
      const p = seedProject(d);
      const r = d.projects.setStatus(p.id, { status, note: 'done' }, CLAUDE, 'All tasks finished');
      expect(r.applied).toBe(false);
      if (r.applied) return;
      expect(r.proposal).toMatchObject({
        kind: 'set_status',
        state: 'pending',
        payload: { status, note: 'done' },
        reason: 'All tasks finished',
        createdBy: 'claude_code',
        sessionId: 'sess-1',
      });
      expect(d.projects.get(p.id).lifecycleStatus).toBe('in_development');
      expect(d.projects.get(p.id).pendingProposals).toBe(1);
    },
  );

  it.each(['completed', 'abandoned'] as const)(
    'agent %s with confirmation and UI %s are applied',
    (status) => {
      const { d } = setup();
      const a = seedProject(d);
      const b = seedProject(d);
      const ra = d.projects.setStatus(a.id, { status }, CLAUDE_CONFIRMED);
      const rb = d.projects.setStatus(b.id, { status }, UI);
      expect(ra.applied && ra.result.lifecycleStatus).toBe(status);
      expect(rb.applied && rb.result.lifecycleStatus).toBe(status);
      expect(d.proposals.list(null)).toHaveLength(0);
    },
  );

  it('awaiting_manual_test requires a non-blank note', () => {
    const { d } = setup();
    const p = seedProject(d);
    expectDomainError(
      () => d.projects.setStatus(p.id, { status: 'awaiting_manual_test' }, UI),
      'validation',
    );
    expectDomainError(
      () => d.projects.setStatus(p.id, { status: 'awaiting_manual_test', note: '   ' }, CLAUDE),
      'validation',
    );
    const r = d.projects.setStatus(
      p.id,
      { status: 'awaiting_manual_test', note: 'Try the trigger' },
      CLAUDE,
    );
    expect(r.applied && r.result.lifecycleStatus).toBe('awaiting_manual_test');
  });

  it('records a test outcome in the diary and returns to in_development', () => {
    const { d } = setup();
    const p = seedProject(d);
    d.projects.setStatus(p.id, { status: 'awaiting_manual_test', note: 'Weld two strips' }, CLAUDE);
    const after = d.projects.recordTestOutcome(
      p.id,
      { passed: false, notes: '  Second weld is weak  ' },
      UI,
    );
    expect(after.lifecycleStatus).toBe('in_development');
    expect(after.statusNote).toBe('');
    const entry = d.diary.list(p.id).find((e) => e.eventKind === 'test_outcome');
    expect(entry).toBeDefined();
    expect(entry!.type).toBe('event');
    expect(entry!.body).toContain('Manual test failed');
    expect(entry!.body).toContain('Weld two strips');
    expect(entry!.body).toContain('Second weld is weak');
    expect(entry!.data).toMatchObject({ passed: false, tested: 'Weld two strips' });
  });

  it('rejects a test outcome when the project is not awaiting a test', () => {
    const { d } = setup();
    const p = seedProject(d);
    expectDomainError(() => d.projects.recordTestOutcome(p.id, { passed: true }, UI), 'conflict');
  });
});

describe('projects: last activity', () => {
  it('is bumped by non-system changes', () => {
    const { d, clock } = setup();
    const p = seedProject(d);
    const created = p.lastActivityAt;
    clock.advance(DAY_MS);
    d.projects.update(p.id, { description: 'new' }, UI);
    expect(d.projects.get(p.id).lastActivityAt).toBe(iso(toMs(created) + DAY_MS));
    clock.advance(DAY_MS);
    d.roadmap.addTask(p.phases[0]!.id, { title: 'More' }, CLAUDE);
    expect(d.projects.get(p.id).lastActivityAt).toBe(iso(toMs(created) + 2 * DAY_MS));
  });

  it('is not bumped by system changes', () => {
    const { d, clock } = setup();
    const p = seedProject(d);
    clock.advance(DAY_MS);
    d.projects.setStatus(p.id, { status: 'on_hold' }, SYSTEM);
    d.diary.addNote(p.id, { body: 'automatic' }, SYSTEM);
    expect(d.projects.get(p.id).lastActivityAt).toBe(p.lastActivityAt);
  });

  it('never moves backwards', () => {
    const { d, clock } = setup();
    const p = seedProject(d);
    clock.advance(DAY_MS);
    d.diary.addNote(p.id, { body: 'today' }, UI);
    const latest = d.projects.get(p.id).lastActivityAt;
    // A back-dated entry (e.g. an imported commit) does not rewind activity.
    d.diary.append(p.id, { type: 'note', body: 'old', occurredAt: toMs(latest) - 10 * DAY_MS }, UI);
    d.projects.touch(p.id, toMs(latest) - 5 * DAY_MS);
    expect(d.projects.get(p.id).lastActivityAt).toBe(latest);
  });
});

describe('projects: list', () => {
  it('orders by attention group, then most recent activity, and hides closed projects', () => {
    const { d, clock } = setup();
    // Created oldest first.
    const inactive = seedProject(d, { name: 'Inactive' });
    clock.advance(40 * DAY_MS);
    const onHold = seedProject(d, { name: 'On hold' });
    d.projects.setStatus(onHold.id, { status: 'on_hold' }, UI);
    const done = seedProject(d, { name: 'Done' });
    d.projects.setStatus(done.id, { status: 'completed' }, UI);
    const normalOld = seedProject(d, { name: 'Normal old' });
    clock.advance(1000);
    const normalNew = seedProject(d, { name: 'Normal new' });
    const awaiting = seedProject(d, { name: 'Awaiting' });
    d.projects.setStatus(awaiting.id, { status: 'awaiting_manual_test', note: 'Check' }, UI);
    const noNext = d.projects.create({ name: 'No next' }, UI);

    const names = d.projects.list().map((p) => [p.name, p.attentionGroup]);
    expect(names).toEqual([
      ['Awaiting', 1],
      ['No next', 3],
      ['Inactive', 3],
      ['Normal new', 4],
      ['Normal old', 4],
      ['On hold', 5],
    ]);
    expect(d.projects.list({ includeClosed: true }).at(-1)?.name).toBe('Done');
    expect(d.projects.list({ status: 'completed' }).map((p) => p.id)).toEqual([done.id]);
    expect(inactive.id).toBeGreaterThan(0);
    expect(normalOld.id).toBeLessThan(normalNew.id);
    expect(noNext.nextTask).toBeNull();
  });
});

describe('projects.list phaseProgress', () => {
  it('lists every phase in roadmap order with the same progress as the detail', () => {
    const t = makeDomain();
    try {
      const p = seedProject(t.d);
      t.d.roadmap.completeTask(p.phases[0]!.tasks[0]!.id, UI);
      const [s] = t.d.projects.list();
      const detail = t.d.projects.get(p.id);
      expect(s!.phaseProgress).toEqual(
        detail.phases.map((ph) => ({ id: ph.id, title: ph.title, progress: ph.progress })),
      );
      expect(s!.phaseProgress[0]!.progress).toEqual({ done: 1, total: 2, ratio: 0.5 });
    } finally {
      t.cleanup();
    }
  });
});
