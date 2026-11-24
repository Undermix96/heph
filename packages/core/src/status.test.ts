import { DEFAULT_SETTINGS } from '@heph/schema';
import { eq } from 'drizzle-orm';
import { afterEach, describe, expect, it } from 'vitest';
import { UI } from './context.js';
import { claudeSessions } from './db/schema.js';
import { activityStateOf, attentionGroupOf, badgeOf } from './status.js';
import { insertLiveSession, seedProject } from './test/fixtures.js';
import { makeDomain, type TestDomain } from './test/helpers.js';
import { DAY_MS } from './util.js';

let t: TestDomain;
afterEach(() => t?.cleanup());

function setup() {
  t = makeDomain();
  const p = seedProject(t.d);
  return { ...t, p };
}

const MIN = 60_000;

describe('activity state with the clock', () => {
  it('recently_active below 7 days, idle up to 30, inactive after 30', () => {
    const { d, p, clock } = setup();
    const st = () => d.projects.get(p.id);
    expect(st().activityState).toBe('recently_active');
    expect(st().badge).toEqual({ kind: 'recently_active' });
    clock.advance(7 * DAY_MS - 1);
    expect(st().activityState).toBe('recently_active');
    clock.advance(1);
    expect(st().activityState).toBe('idle');
    expect(st().badge).toEqual({ kind: 'idle' });
    expect(st().attentionGroup).toBe(4);
    clock.advance(23 * DAY_MS); // exactly 30 days
    expect(st().activityState).toBe('idle');
    clock.advance(1);
    expect(st().activityState).toBe('inactive');
    clock.advance(DAY_MS);
    expect(st().badge).toEqual({ kind: 'inactive', days: 31 });
    expect(st().attentionGroup).toBe(3);
  });

  it('follows the configured thresholds', () => {
    const { d, p, clock } = setup();
    d.settings.update({ recentlyActiveDays: 2, inactiveDays: 5 }, UI);
    clock.advance(3 * DAY_MS);
    expect(d.projects.get(p.id).activityState).toBe('idle');
    clock.advance(3 * DAY_MS);
    expect(d.projects.get(p.id).activityState).toBe('inactive');
  });

  it('a live session makes the project claude_working, testing makes it claude_testing', () => {
    const { d, p, clock } = setup();
    clock.advance(40 * DAY_MS);
    insertLiveSession(d, p.id, { sessionId: 'a' });
    let v = d.projects.get(p.id);
    expect(v.activityState).toBe('claude_working');
    expect(v.badge).toEqual({ kind: 'claude_working' });
    expect(v.attentionGroup).toBe(2);
    expect(v.liveSessions.map((s) => s.sessionId)).toEqual(['a']);
    insertLiveSession(d, p.id, { sessionId: 'b', isTesting: true });
    v = d.projects.get(p.id);
    expect(v.activityState).toBe('claude_testing');
    expect(v.badge).toEqual({ kind: 'claude_testing' });
  });

  it('live sessions stop counting after sessionExpiryMinutes without heartbeat', () => {
    const { d, p, clock } = setup();
    insertLiveSession(d, p.id, { sessionId: 'a' });
    clock.advance(30 * MIN - 1);
    expect(d.projects.get(p.id).activityState).toBe('claude_working');
    clock.advance(1);
    expect(d.projects.get(p.id).activityState).toBe('recently_active');
    d.settings.update({ sessionExpiryMinutes: 60 }, UI);
    expect(d.projects.get(p.id).activityState).toBe('claude_working');
  });

  it('ended sessions are not live', () => {
    const { d, p } = setup();
    insertLiveSession(d, p.id, { sessionId: 'a' });
    d.db
      .update(claudeSessions)
      .set({ endedAt: d.now() })
      .where(eq(claudeSessions.sessionId, 'a'))
      .run();
    expect(d.projects.get(p.id).activityState).toBe('recently_active');
  });

  it('expireStale closes stale sessions only', () => {
    const { d, p, clock } = setup();
    insertLiveSession(d, p.id, { sessionId: 'old', isTesting: true });
    clock.advance(20 * MIN);
    insertLiveSession(d, p.id, { sessionId: 'fresh' });
    clock.advance(10 * MIN);
    expect(d.sessions.expireStale()).toBe(1);
    expect(d.sessions.expireStale()).toBe(0);
    const old = d.db.select().from(claudeSessions).where(eq(claudeSessions.sessionId, 'old')).get();
    expect(old).toMatchObject({ endReason: 'expired', endedAt: clock.now, isTesting: false });
    expect(d.projects.get(p.id).liveSessions.map((s) => s.sessionId)).toEqual(['fresh']);
  });
});

describe('badge precedence: live → lifecycle → recency', () => {
  it('live activity wins over lifecycle', () => {
    const { d, p } = setup();
    d.projects.setStatus(p.id, { status: 'awaiting_manual_test', note: 'Check' }, UI);
    insertLiveSession(d, p.id, { isTesting: true });
    const v = d.projects.get(p.id);
    expect(v.badge.kind).toBe('claude_testing');
    // ...but the dashboard still puts awaiting-test projects first.
    expect(v.attentionGroup).toBe(1);
  });

  it.each([
    ['awaiting_manual_test', 1],
    ['on_hold', 5],
    ['completed', 6],
    ['abandoned', 6],
  ] as const)('lifecycle %s wins over recency (group %d)', (status, group) => {
    const { d, p, clock } = setup();
    d.projects.setStatus(p.id, { status, note: 'n' }, UI);
    clock.advance(60 * DAY_MS);
    const v = d.projects.get(p.id);
    expect(v.activityState).toBe('inactive');
    expect(v.badge).toEqual({ kind: status });
    expect(v.attentionGroup).toBe(group);
  });

  it('no next step is flagged before recency for in_development', () => {
    const { d, clock } = setup();
    const empty = d.projects.create({ name: 'Empty' }, UI);
    expect(d.projects.get(empty.id).badge).toEqual({ kind: 'no_next_step' });
    expect(d.projects.get(empty.id).attentionGroup).toBe(3);
    clock.advance(60 * DAY_MS);
    expect(d.projects.get(empty.id).badge).toEqual({ kind: 'no_next_step' });
  });
});

describe('pure status functions', () => {
  const env = (over: Partial<Parameters<typeof activityStateOf>[1]> = {}) => ({
    live: [],
    hasNextTask: true,
    settings: DEFAULT_SETTINGS,
    now: 100 * DAY_MS,
    ...over,
  });
  const live = { sessionId: 's', repo: null, startedAt: 0, lastHeartbeatAt: 0, testingSince: null };

  it('computes activity, badge and group consistently', () => {
    const p = { lifecycleStatus: 'in_development' as const, lastActivityAt: 100 * DAY_MS };
    const e = env({ live: [{ ...live, isTesting: false }] });
    const a = activityStateOf(p, e);
    expect(a).toBe('claude_working');
    expect(badgeOf(p, a, e)).toEqual({ kind: 'claude_working' });
    expect(attentionGroupOf(p, a, e)).toBe(2);
    const onHold = { ...p, lifecycleStatus: 'on_hold' as const };
    expect(attentionGroupOf(onHold, a, e)).toBe(2);
    expect(attentionGroupOf(onHold, 'idle', env())).toBe(5);
    expect(attentionGroupOf(p, 'idle', env({ hasNextTask: false }))).toBe(3);
  });
});
