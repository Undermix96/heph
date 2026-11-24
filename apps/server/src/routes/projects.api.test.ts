import { afterEach, describe, expect, it } from 'vitest';
import { type Api, startApi } from '../test/api.js';
import { USER } from '../test/app.js';

let t: Api | undefined;
afterEach(() => {
  t?.cleanup();
  t = undefined;
});

const DAY = 86_400_000;

describe('projects CRUD', () => {
  it('creates a project with tags, links, repos and phases (201)', async () => {
    t = await startApi();
    const r = await t.uiReq('POST', '/api/projects', {
      json: {
        name: 'Lampada Ñandú',
        description: 'A *lamp*',
        tags: ['DIY', 'diy', 'Lighting'],
        links: [{ label: 'Shop', url: 'https://example.com/shop' }],
        repos: ['Acme/Lamp', { fullName: 'acme/lamp-fw', docsPath: 'docs/ADR.md' }],
        phases: [{ title: 'Build', tasks: ['Solder'] }],
      },
    });
    expect(r.status).toBe(201);
    expect(r.data).toMatchObject({
      slug: 'lampada-nandu',
      name: 'Lampada Ñandú',
      tags: ['diy', 'lighting'],
      lifecycleStatus: 'in_development',
      docsSource: 'repo',
      claudeWriteEnabled: true,
      links: [{ label: 'Shop', url: 'https://example.com/shop' }],
      repos: ['Acme/Lamp', 'acme/lamp-fw'],
      progress: { done: 0, total: 1, ratio: 0 },
      nextTask: { title: 'Solder', phaseTitle: 'Build', overridden: false },
    });
    expect(r.data.repoDetails[1].docsPath).toBe('docs/ADR.md');
    expect(r.data.repoDetails[0].docsPath).toBe('DECISIONS.md');

    const tags = await t.agentReq('GET', '/api/tags');
    expect(tags.data).toEqual([
      { name: 'diy', count: 1 },
      { name: 'lighting', count: 1 },
    ]);
  });

  it('records the agent as creator and writes a project_created diary event', async () => {
    t = await startApi();
    const r = await t.agentReq('POST', '/api/projects', {
      json: { name: 'Agent Made' },
      headers: { 'x-heph-session-id': 'sess-create' },
    });
    expect(r.status).toBe(201);
    const diary = await t.uiReq('GET', `/api/projects/${r.data.slug}/diary`);
    expect(diary.data).toHaveLength(1);
    expect(diary.data[0]).toMatchObject({
      type: 'event',
      eventKind: 'project_created',
      source: 'claude_code',
      sessionId: 'sess-create',
    });
  });

  it('generates unique slugs and refuses an explicit duplicate (409)', async () => {
    t = await startApi();
    const a = await t.createProject({ name: 'Same Name' });
    const b = await t.createProject({ name: 'Same Name' });
    expect(a.slug).toBe('same-name');
    expect(b.slug).toBe('same-name-2');
    const dup = await t.uiReq('POST', '/api/projects', {
      json: { name: 'Other', slug: 'same-name' },
    });
    expect(dup.status).toBe(409);
    expect(dup.data.error.code).toBe('conflict');
    const patch = await t.uiReq('PATCH', `/api/projects/${b.slug}`, {
      json: { slug: 'same-name' },
    });
    expect(patch.status).toBe(409);
    // Re-setting its own slug is fine.
    expect(
      (await t.uiReq('PATCH', `/api/projects/${a.slug}`, { json: { slug: 'same-name' } })).status,
    ).toBe(200);
  });

  it('validates create input (400)', async () => {
    t = await startApi();
    for (const json of [
      {},
      { name: '   ' },
      { name: 'X', slug: 'Bad Slug' },
      { name: 'X', lifecycleStatus: 'completed' },
      { name: 'X', links: [{ label: 'a', url: 'not a url' }] },
      { name: 'X', repos: ['no-slash'] },
      { name: 'X', tags: 'diy' },
    ]) {
      const r = await t.uiReq('POST', '/api/projects', { json });
      expect(r.status, JSON.stringify(json)).toBe(400);
      expect(r.data.error.code).toBe('validation');
    }
  });

  it('resolves a project by id and by slug in the path', async () => {
    t = await startApi();
    const p = await t.seed();
    const byId = await t.agentReq('GET', `/api/projects/${p.id}`);
    const bySlug = await t.agentReq('GET', `/api/projects/${p.slug}`);
    expect(byId.status).toBe(200);
    expect(bySlug.data).toEqual(byId.data);
    expect(byId.data.phases).toHaveLength(2);
    // Sub-resources too.
    expect((await t.agentReq('GET', `/api/projects/${p.id}/phases`)).data).toHaveLength(2);
    expect((await t.agentReq('GET', `/api/projects/${p.slug}/phases`)).data).toHaveLength(2);
    expect((await t.agentReq('GET', '/api/projects/no-such-project/phases')).status).toBe(404);
    expect((await t.agentReq('GET', '/api/projects/no-such-project/diary')).status).toBe(404);
    expect((await t.agentReq('GET', '/api/projects/424242/materials')).status).toBe(404);
  });

  it('resolves a project by a URL-encoded linked repo name', async () => {
    t = await startApi();
    const p = await t.seed({ repos: ['acme/welder'] });
    const r = await t.agentReq('GET', '/api/projects/acme%2Fwelder');
    expect(r.status).toBe(200);
    expect(r.data.id).toBe(p.id);
  });

  it('never produces all-digit slugs, which would clash with ids', async () => {
    t = await startApi();
    const p = await t.createProject({ name: '2025' });
    expect(p.slug).not.toMatch(/^\d+$/);
    const r = await t.uiReq('GET', `/api/projects/${p.slug}`);
    expect(r.status).toBe(200);
    expect(r.data.id).toBe(p.id);
    const explicit = await t.uiReq('POST', '/api/projects', { json: { name: 'X', slug: '2025' } });
    expect(explicit.status).toBe(400);
    const patch = await t.uiReq('PATCH', `/api/projects/${p.id}`, { json: { slug: '42' } });
    expect(patch.status).toBe(400);
  });

  it('PATCH replaces tags and links and updates fields', async () => {
    t = await startApi();
    const p = await t.seed({
      tags: ['a', 'b'],
      links: [{ label: 'One', url: 'https://one.example' }],
    });
    const r = await t.uiReq('PATCH', `/api/projects/${p.id}`, {
      json: {
        name: 'Renamed',
        description: 'New desc',
        tags: ['C', 'b'],
        links: [
          { label: 'Two', url: 'https://two.example' },
          { label: 'Three', url: 'https://three.example' },
        ],
      },
    });
    expect(r.status).toBe(200);
    expect(r.data).toMatchObject({
      name: 'Renamed',
      slug: p.slug,
      description: 'New desc',
      tags: ['b', 'c'],
    });
    expect(r.data.links.map((l: { label: string }) => l.label)).toEqual(['Two', 'Three']);
    // Unused tags disappear from the tag list.
    expect((await t.uiReq('GET', '/api/tags')).data.map((x: { name: string }) => x.name)).toEqual([
      'b',
      'c',
    ]);
    // Omitted fields are untouched; empty arrays clear.
    const r2 = await t.uiReq('PATCH', `/api/projects/${p.id}`, { json: { tags: [] } });
    expect(r2.data.tags).toEqual([]);
    expect(r2.data.links).toHaveLength(2);
    expect(r2.data.name).toBe('Renamed');
    expect((await t.uiReq('PATCH', '/api/projects/nope', { json: { name: 'x' } })).status).toBe(
      404,
    );
    expect(
      (await t.uiReq('PATCH', `/api/projects/${p.id}`, { json: { name: '' } })).data.error.code,
    ).toBe('validation');
  });

  it('only the UI can change claudeWriteEnabled', async () => {
    t = await startApi();
    const p = await t.seed();
    for (const app of ['ui', 'agent'] as const) {
      const r = await t.agentReq(
        'PATCH',
        `/api/projects/${p.slug}`,
        { json: { claudeWriteEnabled: false } },
        app,
      );
      expect(r.status).toBe(403);
      expect(r.data.error.code).toBe('forbidden');
    }
    const ok = await t.uiReq('PATCH', `/api/projects/${p.slug}`, {
      json: { claudeWriteEnabled: false },
    });
    expect(ok.status).toBe(200);
    expect(ok.data.claudeWriteEnabled).toBe(false);
  });

  it('with claudeWriteEnabled=false the token gets 403 on writes but can still read', async () => {
    t = await startApi();
    const p = await t.seed();
    const phaseId = p.phases[0].id;
    const taskId = p.phases[0].tasks[0].id;
    await t.uiReq('PATCH', `/api/projects/${p.slug}`, { json: { claudeWriteEnabled: false } });
    const writes: [string, string, unknown][] = [
      ['PATCH', `/api/projects/${p.slug}`, { name: 'x' }],
      ['POST', `/api/projects/${p.slug}/status`, { status: 'on_hold' }],
      ['POST', `/api/projects/${p.slug}/diary`, { body: 'hi' }],
      ['POST', `/api/projects/${p.slug}/phases`, { title: 'P' }],
      ['POST', `/api/projects/${p.slug}/materials`, { name: 'M' }],
      ['POST', `/api/projects/${p.slug}/repos`, { fullName: 'acme/x' }],
      ['PUT', `/api/projects/${p.slug}/next-task`, { taskId }],
      ['POST', `/api/projects/${p.slug}/upload-requests`, {}],
      ['PATCH', `/api/phases/${phaseId}`, { title: 'x' }],
      ['POST', `/api/phases/${phaseId}/tasks`, { title: 'x' }],
      ['DELETE', `/api/phases/${phaseId}`, undefined],
      ['PATCH', `/api/tasks/${taskId}`, { title: 'x' }],
      ['POST', `/api/tasks/${taskId}/complete`, undefined],
      ['DELETE', `/api/tasks/${taskId}`, undefined],
    ];
    for (const [method, path, json] of writes) {
      const r = await t.agentReq(method, path, {
        json,
        headers: { 'x-heph-confirmed': 'true' },
      });
      expect(r.status, `${method} ${path}`).toBe(403);
      expect(r.data.error.code).toBe('forbidden');
    }
    const up = await t.agent.request(`/api/projects/${p.slug}/files`, {
      method: 'POST',
      headers: { authorization: `Bearer ${t.token}` },
      body: (() => {
        const f = new FormData();
        f.append('file', new Blob(['x']), 'x.txt');
        return f;
      })(),
    });
    expect(up.status).toBe(403);
    // Reads still work, and nothing was written.
    const after = await t.agentReq('GET', `/api/projects/${p.slug}`);
    expect(after.status).toBe(200);
    expect(after.data.name).toBe('Spot Welder');
    expect(after.data.phases[0].tasks[0].done).toBe(false);
    expect((await t.agentReq('GET', `/api/projects/${p.slug}/diary`)).status).toBe(200);
    // The UI is unaffected.
    expect(
      (await t.uiReq('POST', `/api/projects/${p.slug}/diary`, { json: { body: 'mine' } })).status,
    ).toBe(201);
  });

  it('DELETE as the UI removes the project (204) then 404', async () => {
    t = await startApi();
    const p = await t.seed();
    const del = await t.uiReq('DELETE', `/api/projects/${p.slug}`);
    expect(del.status).toBe(204);
    expect(del.data).toBeNull();
    expect((await t.uiReq('GET', `/api/projects/${p.slug}`)).status).toBe(404);
    expect((await t.uiReq('DELETE', `/api/projects/${p.slug}`)).status).toBe(404);
    expect((await t.uiReq('GET', `/api/tasks/${p.phases[0].tasks[0].id}`)).status).toBe(404);
  });
});

describe('repos', () => {
  it('links, updates and unlinks repos; a repo cannot belong to two projects (409)', async () => {
    t = await startApi();
    const a = await t.seed();
    const b = await t.createProject({ name: 'Other' });
    const link = await t.agentReq('POST', `/api/projects/${a.slug}/repos`, {
      json: { fullName: 'Acme/Welder' },
    });
    expect(link.status).toBe(201);
    expect(link.data.repos).toEqual(['Acme/Welder']);
    // Linking again to the same project is idempotent.
    expect(
      (
        await t.agentReq('POST', `/api/projects/${a.slug}/repos`, {
          json: { fullName: 'acme/welder' },
        })
      ).status,
    ).toBe(201);
    const clash = await t.uiReq('POST', `/api/projects/${b.slug}/repos`, {
      json: { fullName: 'ACME/WELDER' },
    });
    expect(clash.status).toBe(409);
    expect(clash.data.error.code).toBe('conflict');
    expect(clash.data.error.message).toContain(a.slug);
    // Creating a project with an already-linked repo also conflicts.
    expect(
      (await t.uiReq('POST', '/api/projects', { json: { name: 'C', repos: ['acme/welder'] } }))
        .status,
    ).toBe(409);
    expect(
      (await t.uiReq('POST', `/api/projects/${b.slug}/repos`, { json: 'bad name' })).status,
    ).toBe(400);

    const repoId = link.data.repoDetails[0].id;
    const upd = await t.agentReq('PATCH', `/api/repos/${repoId}`, {
      json: { docsPath: 'docs/DECISIONS.md', showCommits: false },
    });
    expect(upd.status).toBe(200);
    expect(upd.data.repoDetails[0]).toMatchObject({
      docsPath: 'docs/DECISIONS.md',
      showCommits: false,
    });
    expect((await t.agentReq('PATCH', '/api/repos/999', { json: {} })).status).toBe(404);

    const un = await t.agentReq('DELETE', `/api/repos/${repoId}`);
    expect(un.status).toBe(200);
    expect(un.data.repos).toEqual([]);
    expect((await t.agentReq('DELETE', `/api/repos/${repoId}`)).status).toBe(404);
    // Now free for the other project.
    expect(
      (
        await t.uiReq('POST', `/api/projects/${b.slug}/repos`, {
          json: { fullName: 'acme/welder' },
        })
      ).status,
    ).toBe(201);
  });
});

describe('project lists and the dashboard', () => {
  it('filters by ?status, ?tag and ?includeClosed=true', async () => {
    t = await startApi();
    const open = await t.seed({ name: 'Open', tags: ['diy'] });
    const hold = await t.seed({ name: 'Hold', tags: ['work'] });
    const done = await t.seed({ name: 'Done', tags: ['diy'] });
    await t.uiReq('POST', `/api/projects/${hold.slug}/status`, { json: { status: 'on_hold' } });
    const c = await t.uiReq('POST', `/api/projects/${done.slug}/status`, {
      json: { status: 'completed' },
    });
    expect(c.status).toBe(200);
    expect(c.data.lifecycleStatus).toBe('completed');

    const slugs = (r: { data: { slug: string }[] }) => r.data.map((p) => p.slug).sort();
    expect(slugs(await t.uiReq('GET', '/api/projects'))).toEqual([hold.slug, open.slug].sort());
    expect(slugs(await t.uiReq('GET', '/api/projects?includeClosed=true'))).toEqual(
      [done.slug, hold.slug, open.slug].sort(),
    );
    expect(slugs(await t.uiReq('GET', '/api/projects?status=completed'))).toEqual([done.slug]);
    expect(slugs(await t.uiReq('GET', '/api/projects?status=on_hold'))).toEqual([hold.slug]);
    expect(slugs(await t.uiReq('GET', '/api/projects?tag=diy'))).toEqual([open.slug]);
    expect(slugs(await t.uiReq('GET', '/api/projects?tag=DIY&includeClosed=true'))).toEqual(
      [done.slug, open.slug].sort(),
    );
    expect(slugs(await t.uiReq('GET', '/api/projects?tag=none'))).toEqual([]);
    const bad = await t.uiReq('GET', '/api/projects?status=bogus');
    expect(bad.status).toBe(400);
    expect(bad.data.error.code).toBe('validation');
  });

  it('?includeClosed=false excludes closed projects', async () => {
    t = await startApi();
    const done = await t.seed({ name: 'Done' });
    await t.uiReq('POST', `/api/projects/${done.slug}/status`, { json: { status: 'abandoned' } });
    const r = await t.uiReq('GET', '/api/projects?includeClosed=false');
    expect(r.data).toEqual([]);
  });

  it('/needs-attention returns open projects in dashboard order', async () => {
    t = await startApi();
    // Group 4 (healthy, recent): two of them, ordered by last activity desc.
    const healthyOld = await t.seed({ name: 'Healthy Old' });
    t.clock.advance(60_000);
    const healthyNew = await t.seed({ name: 'Healthy New' });
    // Group 5: on hold.
    const hold = await t.seed({ name: 'Hold' });
    await t.uiReq('POST', `/api/projects/${hold.slug}/status`, { json: { status: 'on_hold' } });
    // Group 3: no next step.
    const empty = await t.createProject({ name: 'Empty' });
    // Group 2: Claude working.
    const live = await t.seed({ name: 'Live' });
    t.insertLiveSession(live.id, 'live-1');
    // Group 1: awaiting manual test.
    const awaiting = await t.seed({ name: 'Awaiting' });
    await t.uiReq('POST', `/api/projects/${awaiting.slug}/status`, {
      json: { status: 'awaiting_manual_test', note: 'Try the trigger' },
    });
    // Closed projects are not listed.
    const closed = await t.seed({ name: 'Closed' });
    await t.uiReq('POST', `/api/projects/${closed.slug}/status`, {
      json: { status: 'completed' },
    });
    // Touch the old healthy one last so recency, not creation order, decides within a group.
    t.clock.advance(60_000);
    await t.uiReq('POST', `/api/projects/${healthyOld.slug}/diary`, { json: { body: 'bump' } });

    const r = await t.agentReq('GET', '/api/needs-attention');
    expect(r.status).toBe(200);
    expect(r.data.map((p: { slug: string }) => p.slug)).toEqual([
      awaiting.slug,
      live.slug,
      empty.slug,
      healthyOld.slug,
      healthyNew.slug,
      hold.slug,
    ]);
    expect(r.data.map((p: { attentionGroup: number }) => p.attentionGroup)).toEqual([
      1, 2, 3, 4, 4, 5,
    ]);
    const byslug = Object.fromEntries(
      r.data.map((p: { slug: string; badge: { kind: string } }) => [p.slug, p.badge.kind]),
    );
    expect(byslug[awaiting.slug]).toBe('awaiting_manual_test');
    expect(byslug[live.slug]).toBe('claude_working');
    expect(byslug[empty.slug]).toBe('no_next_step');
    expect(byslug[hold.slug]).toBe('on_hold');
  });

  it('long-inactive projects rise to group 3 with an inactive badge', async () => {
    t = await startApi();
    const stale = await t.seed({ name: 'Stale' });
    t.clock.advance(31 * DAY);
    // The UI session expired meanwhile; log in again.
    expect((await t.uiReq('POST', '/api/auth/login', { json: USER })).status).toBe(200);
    const fresh = await t.seed({ name: 'Fresh' });
    const r = await t.uiReq('GET', '/api/needs-attention');
    expect(r.data.map((p: { slug: string }) => p.slug)).toEqual([stale.slug, fresh.slug]);
    expect(r.data[0].badge).toEqual({ kind: 'inactive', days: 31 });
    expect(r.data[0].activityState).toBe('inactive');
    expect(r.data[1].badge.kind).toBe('recently_active');
  });
});

describe('lifecycle status and manual tests', () => {
  it('awaiting_manual_test needs a note; test-outcome returns to in_development', async () => {
    t = await startApi();
    const p = await t.seed();
    const noNote = await t.agentReq('POST', `/api/projects/${p.slug}/status`, {
      json: { status: 'awaiting_manual_test' },
    });
    expect(noNote.status).toBe(400);
    expect(noNote.data.error.code).toBe('validation');
    expect(
      (
        await t.agentReq('POST', `/api/projects/${p.slug}/status`, {
          json: { status: 'awaiting_manual_test', note: '   ' },
        })
      ).status,
    ).toBe(400);

    // Not awaiting yet → 409.
    const early = await t.uiReq('POST', `/api/projects/${p.slug}/test-outcome`, {
      json: { passed: true },
    });
    expect(early.status).toBe(409);

    const set = await t.agentReq('POST', `/api/projects/${p.slug}/status`, {
      json: { status: 'awaiting_manual_test', note: 'Check the **welds**' },
      headers: { 'x-heph-session-id': 'sess-t' },
    });
    expect(set.status).toBe(200);
    expect(set.data).toMatchObject({
      lifecycleStatus: 'awaiting_manual_test',
      statusNote: 'Check the **welds**',
      badge: { kind: 'awaiting_manual_test' },
      attentionGroup: 1,
    });

    expect(
      (await t.uiReq('POST', `/api/projects/${p.slug}/test-outcome`, { json: {} })).status,
    ).toBe(400);
    const out = await t.uiReq('POST', `/api/projects/${p.slug}/test-outcome`, {
      json: { passed: false, notes: 'Weld 3 cracked' },
    });
    expect(out.status).toBe(200);
    expect(out.data).toMatchObject({ lifecycleStatus: 'in_development', statusNote: '' });

    const diary = await t.uiReq('GET', `/api/projects/${p.slug}/diary?type=event`);
    const kinds = diary.data.map((e: { eventKind: string }) => e.eventKind);
    expect(kinds).toContain('test_outcome');
    expect(kinds).toContain('status_changed');
    const outcome = diary.data.find((e: { eventKind: string }) => e.eventKind === 'test_outcome');
    expect(outcome).toMatchObject({
      source: 'ui',
      data: { passed: false, tested: 'Check the **welds**', notes: 'Weld 3 cracked' },
    });
    expect(outcome.body).toContain('Manual test failed');
    expect(outcome.body).toContain('Check the **welds**');
    const statusEvent = diary.data.find(
      (e: { eventKind: string }) => e.eventKind === 'status_changed',
    );
    expect(statusEvent).toMatchObject({ source: 'claude_code', sessionId: 'sess-t' });

    // Once back in development another outcome is a conflict.
    expect(
      (await t.uiReq('POST', `/api/projects/${p.slug}/test-outcome`, { json: { passed: true } }))
        .status,
    ).toBe(409);
  });

  it('terminal statuses from the agent become proposals (202) unless confirmed', async () => {
    t = await startApi();
    const p = await t.seed();
    const gated = await t.agentReq('POST', `/api/projects/${p.slug}/status`, {
      json: { status: 'completed', note: 'All done', reason: 'Every task is finished' },
      headers: { 'x-heph-session-id': 'sess-9' },
    });
    expect(gated.status).toBe(202);
    expect(gated.data.proposal).toMatchObject({
      kind: 'set_status',
      payload: { status: 'completed', note: 'All done' },
      reason: 'Every task is finished',
      createdBy: 'claude_code',
      sessionId: 'sess-9',
      state: 'pending',
    });
    const still = await t.uiReq('GET', `/api/projects/${p.slug}`);
    expect(still.data.lifecycleStatus).toBe('in_development');
    expect(still.data.pendingProposals).toBe(1);

    // Non-terminal statuses apply directly.
    const hold = await t.agentReq('POST', `/api/projects/${p.slug}/status`, {
      json: { status: 'on_hold' },
    });
    expect(hold.status).toBe(200);
    expect(hold.data.lifecycleStatus).toBe('on_hold');

    // X-Heph-Confirmed applies a terminal status directly.
    const confirmed = await t.agentReq('POST', `/api/projects/${p.slug}/status`, {
      json: { status: 'abandoned' },
      headers: { 'x-heph-confirmed': 'TRUE' },
    });
    expect(confirmed.status).toBe(200);
    expect(confirmed.data.lifecycleStatus).toBe('abandoned');

    // Anything else than "true" is not a confirmation.
    const p2 = await t.seed({ name: 'Second' });
    const notConfirmed = await t.agentReq('POST', `/api/projects/${p2.slug}/status`, {
      json: { status: 'abandoned' },
      headers: { 'x-heph-confirmed': '1' },
    });
    expect(notConfirmed.status).toBe(202);

    expect(
      (await t.uiReq('POST', `/api/projects/${p.slug}/status`, { json: { status: 'nope' } }))
        .status,
    ).toBe(400);
    expect(
      (await t.uiReq('POST', '/api/projects/nope/status', { json: { status: 'on_hold' } })).status,
    ).toBe(404);
  });
});

describe('next task', () => {
  it('GET is computed; PUT overrides; null clears; done and foreign tasks are rejected', async () => {
    t = await startApi();
    const p = await t.seed();
    const other = await t.seed({ name: 'Other' });
    const [[schematic, bom], [caseT]] = p.phases.map((ph: { tasks: { id: number }[] }) =>
      ph.tasks.map((x) => x.id),
    );

    const g = await t.agentReq('GET', `/api/projects/${p.slug}/next-task`);
    expect(g.status).toBe(200);
    expect(g.data.nextTask).toMatchObject({ id: schematic, title: 'Schematic', overridden: false });

    const put = await t.agentReq('PUT', `/api/projects/${p.id}/next-task`, {
      json: { taskId: caseT },
    });
    expect(put.status).toBe(200);
    expect(put.data.nextTask).toMatchObject({ id: caseT, phaseTitle: 'Build', overridden: true });
    expect((await t.agentReq('GET', `/api/projects/${p.id}/next-task`)).data.nextTask.id).toBe(
      caseT,
    );

    const cleared = await t.agentReq('PUT', `/api/projects/${p.id}/next-task`, {
      json: { taskId: null },
    });
    expect(cleared.status).toBe(200);
    expect(cleared.data.nextTask).toMatchObject({ id: schematic, overridden: false });

    await t.uiReq('POST', `/api/tasks/${bom}/complete`);
    const done = await t.agentReq('PUT', `/api/projects/${p.id}/next-task`, {
      json: { taskId: bom },
    });
    expect(done.status).toBe(400);
    expect(done.data.error.code).toBe('validation');

    const foreign = await t.agentReq('PUT', `/api/projects/${p.id}/next-task`, {
      json: { taskId: other.phases[0].tasks[0].id },
    });
    expect(foreign.status).toBe(400);
    expect((await t.agentReq('PUT', `/api/projects/${p.id}/next-task`, { json: {} })).status).toBe(
      400,
    );
    expect(
      (await t.agentReq('PUT', `/api/projects/${p.id}/next-task`, { json: { taskId: '3' } }))
        .status,
    ).toBe(400);
    expect(
      (await t.agentReq('PUT', `/api/projects/${p.id}/next-task`, { json: { taskId: 99999 } }))
        .status,
    ).toBe(404);
    expect((await t.agentReq('GET', '/api/projects/nope/next-task')).status).toBe(404);

    const events = await t.uiReq('GET', `/api/projects/${p.id}/diary?type=event`);
    expect(
      events.data.filter((e: { eventKind: string }) => e.eventKind === 'next_task_changed'),
    ).toHaveLength(2);
  });

  it('completing the overridden task clears the override', async () => {
    t = await startApi();
    const p = await t.seed();
    const wiring = p.phases[1].tasks[1].id;
    await t.agentReq('PUT', `/api/projects/${p.slug}/next-task`, { json: { taskId: wiring } });
    const c = await t.agentReq('POST', `/api/tasks/${wiring}/complete`);
    expect(c.status).toBe(200);
    expect(c.data.nextTask).toMatchObject({ title: 'Schematic', overridden: false });
  });

  it('a project with no open tasks has nextTask null', async () => {
    t = await startApi();
    const p = await t.createProject({ name: 'Empty' });
    expect((await t.uiReq('GET', `/api/projects/${p.slug}/next-task`)).data).toEqual({
      nextTask: null,
    });
  });
});
