/**
 * Third independent verification of D39 in agent-facing text: every absolute
 * time printed by any MCP tool is a full UTC ISO 8601 timestamp with ms and Z.
 * The clock is moved to non-round instants so truncated forms cannot pass by luck.
 */
import { schema } from '@heph/core';
import { describe, expect, it } from 'vitest';
import { type Mcp, seedProject, startMcp, useMcpCleanup } from './test/mcp.js';

useMcpCleanup();

const ISO_RE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/;
const UI = { source: 'ui' } as const;

/** Anything that looks like part of an absolute date or time. */
function timeTokens(text: string): string[] {
  const out: string[] = [];
  // Date-led tokens, greedy over any time suffix (T or space separated, with/without Z).
  for (const m of text.matchAll(
    /[+-]?\d{4,6}-\d{2}-\d{2}(?:[T ]\d{2}(?::\d{2}){0,2}(?:\.\d+)?Z?)?/g,
  ))
    out.push(m[0]);
  return out;
}

/** Free-standing clock times ("12:00", "12:00:01") not inside an ISO token. */
function bareClockTimes(text: string): string[] {
  const stripped = text.replace(/\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z/g, '');
  return [...stripped.matchAll(/\b\d{1,2}:\d{2}(?::\d{2})?\b/g)].map((m) => m[0]);
}

function expectOnlyIso(label: string, text: string, minTokens = 0) {
  const tokens = timeTokens(text);
  expect(
    tokens.length,
    `${label}: expected at least ${minTokens} timestamps\n${text}`,
  ).toBeGreaterThanOrEqual(minTokens);
  expect(
    tokens.filter((x) => !ISO_RE.test(x)),
    `${label}\n${text}`,
  ).toEqual([]);
  expect(bareClockTimes(text), `${label}\n${text}`).toEqual([]);
  expect(text, label).not.toMatch(/\bUTC\b/);
  return tokens;
}

async function populated(): Promise<{ m: Mcp; s: Awaited<ReturnType<typeof seedProject>> }> {
  const m = await startMcp();
  m.t.clock.advance(1_234); // 12:00:01.234
  const s = await seedProject(m, { tags: ['weld'] });
  m.t.clock.advance(61_001);
  await m.ok('complete_task', { task_id: s.tasks.schematic.id });
  m.t.clock.advance(7_777);
  await m.ok('log_progress', { project: s.id, body: 'Measured the cap bank' });
  m.t.clock.advance(3_003);
  await m.ok('delete_task', { task_id: s.tasks.bom.id, reason: 'merge' });
  await m.ok('delete_task', { task_id: s.tasks.wiring.id, reason: 'later' });
  const [first] = m.d.proposals.list(s.id).sort((a, b) => a.id - b.id);
  m.t.clock.advance(999);
  m.d.proposals.reject(first!.id, { note: 'keep it' }, UI);
  // Live Claude session (shown in the briefing).
  const now = m.t.clock.now + 5;
  m.d.db
    .insert(schema.claudeSessions)
    .values({
      sessionId: 'abcdef0123456789',
      projectId: s.id,
      startedAt: now,
      lastHeartbeatAt: now,
      isTesting: true,
      testingSince: now,
      createdAt: now,
      updatedAt: now,
    })
    .run();
  m.t.clock.advance(17);
  return { m, s };
}

describe('verify3: MCP read tools print full ISO timestamps', () => {
  it('get_briefing: last activity, live session, diary, pending and decided proposals', async () => {
    const { m, s } = await populated();
    const text = await m.ok('get_briefing', { project: s.id });
    const tokens = expectOnlyIso('get_briefing', text, 5);
    expect(text).toContain('Claude session abcdef01');
    expect(text).toMatch(/since \d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z/);
    expect(text).toMatch(/pending since \d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z/);
    expect(text).toMatch(/\*\*rejected\*\* \d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z/);
    // At least one non-zero millisecond value survives (no truncation).
    expect(tokens.some((x) => !x.endsWith('.000Z'))).toBe(true);
  });

  it('get_project: created, done timestamps and pending proposals', async () => {
    const { m, s } = await populated();
    const text = await m.ok('get_project', { project: s.id });
    expectOnlyIso('get_project', text, 2);
    expect(text).toMatch(/done 2026-11-24T12:01:02\.235Z/);
    expect(text).toMatch(/created 2026-11-24T12:00:01\.234Z/);
  });

  it('get_diary: every entry and the paging hint', async () => {
    const { m, s } = await populated();
    const text = await m.ok('get_diary', { project: s.id, limit: 2 });
    expectOnlyIso('get_diary', text, 3);
    const before = /before=(\S+?),/.exec(text)?.[1];
    expect(before).toMatch(ISO_RE);
    // The printed cursor is accepted back by the tool.
    const id = Number(/before_id=(\d+)/.exec(text)?.[1]);
    const next = await m.ok('get_diary', { project: s.id, before, before_id: id });
    expectOnlyIso('get_diary page 2', next, 1);
  });

  it('list_projects, needs_attention, search, list_proposals', async () => {
    const { m, s } = await populated();
    expectOnlyIso('list_projects', await m.ok('list_projects'));
    expectOnlyIso('needs_attention', await m.ok('needs_attention'));
    expectOnlyIso('search', await m.ok('search', { query: 'cap bank' }));
    const props = await m.ok('list_proposals', { project: s.id });
    expectOnlyIso('list_proposals', props, 1);
    expect(props).toMatch(/rejected 2026-11-24T\d{2}:\d{2}:\d{2}\.\d{3}Z/);
  });

  it('request_upload expiry and get_file metadata', async () => {
    const { m, s } = await populated();
    const up = await m.ok('request_upload', { project: s.id, caption: 'scope 12:30 trace' });
    const tokens = timeTokens(up);
    expect(tokens).toHaveLength(1);
    expect(tokens[0]).toMatch(ISO_RE);
    const url = /^(http\S+\/upload\/\S+)$/m.exec(up)?.[1] as string;
    const form = new FormData();
    form.append('file', new Blob(['hello'], { type: 'text/plain' }), 'n.txt');
    const res = await fetch(url, { method: 'POST', body: form });
    expect(res.status).toBe(201);
    const { id } = (await res.json()) as { id: number };
    const r = await m.call('get_file', { file_id: id });
    expect(r.isError).toBe(false);
    const head = r.content[0] as { text: string };
    // caption is user text; strip it before scanning
    const meta = head.text.replace(/ · caption: .*$/, '');
    expectOnlyIso('get_file', meta, 1);
  });
});

describe('verify3: MCP write tools print full ISO timestamps', () => {
  it('create_project (briefing), complete_task, restructure_roadmap proposal and applied', async () => {
    const m = await startMcp();
    m.t.clock.advance(4_321);
    const created = await m.ok('create_project', {
      name: 'Bench PSU',
      phases: [{ title: 'Design', tasks: ['A', 'B'] }],
    });
    expectOnlyIso('create_project', created, 1);
    const id = Number(/Created project #(\d+)/.exec(created)?.[1]);
    const p = m.d.projects.get(id);
    m.t.clock.advance(111);
    expectOnlyIso(
      'complete_task',
      await m.ok('complete_task', { task_id: p.phases[0]!.tasks[0]!.id }),
    );
    const proposed = await m.ok('restructure_roadmap', {
      project: id,
      operations: [{ op: 'add_phase', title: 'Build' }],
      reason: 'split',
    });
    expect(proposed).toContain('Proposed roadmap');
    expectOnlyIso('restructure proposal', proposed);
    const applied = await m.ok('restructure_roadmap', {
      project: id,
      operations: [{ op: 'add_phase', title: 'Test' }],
      confirmed: true,
    });
    expectOnlyIso('restructure applied', applied, 1); // done timestamp of task A
    expect(applied).toMatch(/done 2026-11-24T12:00:04\.432Z/);
    // the briefing after all that still holds
    expectOnlyIso('get_briefing', await m.ok('get_briefing', { project: id }), 2);
  });

  it('remaining write tools print no truncated times', async () => {
    const { m, s } = await populated();
    const outputs: [string, string][] = [
      ['log_progress', await m.ok('log_progress', { project: s.id, body: 'x' })],
      ['update_project', await m.ok('update_project', { project: s.id, description: 'd' })],
      ['add_phase', await m.ok('add_phase', { project: s.id, title: 'Ship' })],
      ['add_task', await m.ok('add_task', { phase_id: s.build.id, title: 'Box' })],
      ['reopen_task', await m.ok('reopen_task', { task_id: s.tasks.schematic.id })],
      ['set_next_task', await m.ok('set_next_task', { project: s.id, task_id: null })],
      ['add_material', await m.ok('add_material', { project: s.id, name: 'Cap' })],
      [
        'set_status',
        await m.ok('set_status', { project: s.id, status: 'awaiting_manual_test', note: 'try' }),
      ],
    ];
    for (const [name, text] of outputs) expectOnlyIso(name, text);
  });
});
