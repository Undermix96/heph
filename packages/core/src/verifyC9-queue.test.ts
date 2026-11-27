// Independent verification C9: Claude's queue (D76). Invented sessions and notes.
import { afterEach, describe, expect, it } from 'vitest';
import { UI } from './context.js';
import { QUEUE_ENDED_MAX } from './sessions.js';
import { CLAUDE, seedProject } from './test/fixtures.js';
import { makeDomain, type TestDomain } from './test/helpers.js';

let t: TestDomain;
afterEach(() => t?.cleanup());

const MIN = 60_000;
const HOUR = 60 * MIN;
const welder = { remote: 'git@github.com:me/welder.git', cwd: '/w' };

/** Clock at 2026-11-24 12:00 UTC; `since` = 00:00 UTC of that day. */
function setup() {
  t = makeDomain();
  const p = seedProject(t.d, { repos: ['me/welder'] });
  const since = new Date(t.clock.now - 12 * HOUR).toISOString();
  const expiry = t.d.settings.get().sessionExpiryMinutes * MIN;
  return { ...t, p, since, expiry };
}
type S = ReturnType<typeof setup>;
const note = (s: S, sessionId: string, body: string, project: number = s.p.id) =>
  s.d.diary.addNote(project, { body }, { ...CLAUDE, sessionId });
const ids = (xs: { sessionId: string }[]) => xs.map((x) => x.sessionId);

describe('C9 queue: silent and expired sessions', () => {
  it('an expired session keeps the same end time it had while silent', () => {
    const s = setup();
    s.d.sessions.start('a', welder);
    note(s, 'a', 'Working');
    const beat = s.clock.now;
    s.clock.advance(s.expiry + 5 * MIN);
    const before = s.d.sessions.queue({ since: s.since }).ended[0]!;
    expect(before.endedAt).toBe(new Date(beat).toISOString());
    s.d.sessions.expireStale();
    const after = s.d.sessions.queue({ since: s.since }).ended[0]!;
    // Same session, nothing new happened: the shown end time should not jump.
    expect(after.endedAt).toBe(before.endedAt);
  });

  it('a session silent since yesterday is not "ended today" because housekeeping ran after midnight', () => {
    const s = setup();
    // Last heartbeat at 23:50 the day before `since`.
    s.clock.advance(-(12 * HOUR) - 10 * MIN);
    s.d.sessions.start('late', welder);
    note(s, 'late', 'Late-night fix');
    // 00:25 today: still within the expiry window, so it ended (went silent) yesterday.
    s.clock.advance(35 * MIN);
    expect(s.d.sessions.queue({ since: s.since }).ended).toEqual([]);
    s.d.sessions.expireStale();
    expect(ids(s.d.sessions.queue({ since: s.since }).ended)).toEqual([]);
  });

  it('after the server was down for days, old silent sessions do not show up today', () => {
    const s = setup();
    s.clock.advance(-3 * 24 * HOUR);
    s.d.sessions.start('old', welder);
    note(s, 'old', 'Three days ago');
    s.clock.advance(3 * 24 * HOUR);
    expect(s.d.sessions.queue({ since: s.since }).ended).toEqual([]);
    // Housekeeping at boot.
    s.d.sessions.expireStale();
    expect(ids(s.d.sessions.queue({ since: s.since }).ended)).toEqual([]);
  });

  it('a session silent while testing is listed as ended, not testing', () => {
    const s = setup();
    s.d.sessions.start('a', welder);
    note(s, 'a', 'Running tests');
    s.d.sessions.toolStart('a', 'tu', 'npm test', welder);
    expect(s.d.sessions.queue({ since: s.since }).running[0]!.state).toBe('testing');
    s.clock.advance(s.expiry + MIN);
    const q = s.d.sessions.queue({ since: s.since });
    expect(q.running).toEqual([]);
    expect(q.ended[0]!.state).toBe('ended');
  });

  it('the expiry boundary agrees with liveFor', () => {
    const s = setup();
    s.d.sessions.start('a', welder);
    note(s, 'a', 'x');
    s.clock.advance(s.expiry - 1);
    expect(ids(s.d.sessions.queue({ since: s.since }).running)).toEqual(['a']);
    expect(s.d.sessions.liveFor([s.p.id]).get(s.p.id)).toHaveLength(1);
    s.clock.advance(1);
    expect(s.d.sessions.queue({ since: s.since }).running).toEqual([]);
    expect(s.d.sessions.liveFor([s.p.id]).get(s.p.id)).toBeUndefined();
  });
});

describe('C9 queue: reopened, moved and deleted', () => {
  it('a session that ended and came back is running again, then ended once', () => {
    const s = setup();
    s.d.sessions.start('a', welder);
    note(s, 'a', 'Morning');
    s.d.sessions.end('a', 'other');
    s.clock.advance(HOUR);
    s.d.sessions.stop('a', false, welder);
    let q = s.d.sessions.queue({ since: s.since });
    expect(ids(q.running)).toEqual(['a']);
    expect(q.ended).toEqual([]);
    expect(q.running[0]!.lastEntry!.body).toBe('Morning');
    s.clock.advance(MIN);
    s.d.sessions.end('a', 'other');
    q = s.d.sessions.queue({ since: s.since });
    expect(q.running).toEqual([]);
    expect(q.ended.map((x) => x.endedAt)).toEqual([new Date(s.clock.now).toISOString()]);
  });

  it('a session ended yesterday and resumed today shows its earlier note', () => {
    const s = setup();
    s.clock.advance(-14 * HOUR);
    s.d.sessions.start('a', welder);
    note(s, 'a', 'Yesterday');
    s.d.sessions.end('a', 'other');
    expect(s.d.sessions.queue({ since: s.since }).ended).toEqual([]);
    s.clock.advance(14 * HOUR);
    s.d.sessions.start('a', welder);
    expect(s.d.sessions.queue({ since: s.since }).running[0]!.lastEntry!.body).toBe('Yesterday');
  });

  it('a running session follows its repo to another project', () => {
    const s = setup();
    const other = seedProject(s.d, { name: 'Bench PSU with a really long name that keeps going' });
    s.d.sessions.start('a', welder);
    note(s, 'a', 'Before the move');
    const repoId = s.d.projects.get(s.p.id).repoDetails[0]!.id;
    s.d.projects.unlinkRepo(repoId, UI);
    s.d.projects.linkRepo(other.id, { fullName: 'me/welder' }, UI);
    const q = s.d.sessions.queue({ since: s.since });
    expect(q.running).toHaveLength(1);
    expect(q.running[0]).toMatchObject({
      projectId: other.id,
      projectSlug: other.slug,
      projectName: other.name,
    });
  });

  it('sessions of a deleted project disappear, others stay', () => {
    const s = setup();
    const other = seedProject(s.d, { name: 'Radio', repos: ['me/radio'] });
    s.d.sessions.start('a', welder);
    note(s, 'a', 'a');
    s.d.sessions.start('b', { remote: 'git@github.com:me/radio.git' });
    note(s, 'b', 'b', other.id);
    s.d.sessions.end('b', 'other');
    s.d.projects.delete(other.id, UI);
    const q = s.d.sessions.queue({ since: s.since });
    expect(ids(q.running)).toEqual(['a']);
    expect(q.ended).toEqual([]);
  });

  it('a session without a project at start that gets one later appears', () => {
    const s = setup();
    s.d.sessions.start('a', { remote: 'git@github.com:me/lamp.git' });
    expect(s.d.sessions.queue({ since: s.since }).running).toEqual([]);
    const lamp = seedProject(s.d, { name: 'Lamp' });
    s.d.projects.linkRepo(lamp.id, { fullName: 'me/lamp' }, UI);
    expect(s.d.sessions.queue({ since: s.since }).running[0]!.projectId).toBe(lamp.id);
  });
});

describe('C9 queue: since and ordering', () => {
  it('ended exactly at `since` is in, one millisecond earlier is out', () => {
    const s = setup();
    s.d.sessions.start('a', welder);
    note(s, 'a', 'x');
    s.d.sessions.end('a', 'other');
    const at = new Date(s.clock.now).toISOString();
    expect(ids(s.d.sessions.queue({ since: at }).ended)).toEqual(['a']);
    expect(s.d.sessions.queue({ since: new Date(s.clock.now + 1).toISOString() }).ended).toEqual(
      [],
    );
  });

  it('a running session is listed whatever `since` says (started yesterday)', () => {
    const s = setup();
    s.clock.advance(-13 * HOUR);
    s.d.sessions.start('long', welder);
    s.clock.advance(13 * HOUR);
    s.d.sessions.stop('long', false, welder);
    expect(ids(s.d.sessions.queue({ since: s.since }).running)).toEqual(['long']);
  });

  it('`since` must be UTC (Z); the web client always sends toISOString()', () => {
    const s = setup();
    expect(() => s.d.sessions.queue({ since: '2026-11-24T01:00:00+01:00' })).toThrow(/since/);
    expect(() => s.d.sessions.queue({ since: '2026-11-24T00:00:00Z' })).not.toThrow();
  });

  it('running newest start first, ended newest end first, across many projects', () => {
    const s = setup();
    const names = ['Alpha', 'Beta', 'Gamma', 'Delta'];
    const ps = names.map((n, i) => seedProject(s.d, { name: n, repos: [`me/r${i}`] }));
    ps.forEach((_p, i) => {
      s.d.sessions.start(`run${i}`, { remote: `git@github.com:me/r${i}.git` });
      s.clock.advance(MIN);
    });
    for (const [i, p] of ps.entries()) {
      s.d.sessions.start(`end${i}`, { remote: `git@github.com:me/r${i}.git` });
      note(s, `end${i}`, `note ${i}`, p.id);
    }
    // End in a different order than they started.
    for (const i of [2, 0, 3, 1]) {
      s.clock.advance(MIN);
      s.d.sessions.end(`end${i}`, 'other');
    }
    const q = s.d.sessions.queue({ since: s.since });
    expect(ids(q.running)).toEqual(['run3', 'run2', 'run1', 'run0']);
    expect(ids(q.ended)).toEqual(['end1', 'end3', 'end0', 'end2']);
  });

  it('the cap keeps the newest ended sessions, and running ones are not capped', () => {
    const s = setup();
    for (let i = 0; i < QUEUE_ENDED_MAX + 5; i++) {
      s.d.sessions.start(`r${i}`, welder);
    }
    for (let i = 0; i < QUEUE_ENDED_MAX + 5; i++) {
      s.d.sessions.start(`e${i}`, welder);
      note(s, `e${i}`, `n${i}`);
      s.clock.advance(1000);
      s.d.sessions.end(`e${i}`, 'other');
    }
    const q = s.d.sessions.queue({ since: s.since });
    expect(q.running).toHaveLength(QUEUE_ENDED_MAX + 5);
    expect(q.ended).toHaveLength(QUEUE_ENDED_MAX);
    expect(q.ended.at(-1)!.sessionId).toBe('e5');
  });
});

describe('C9 queue: the diary entry', () => {
  it('300 characters exactly are kept whole; 301 are cut to 300 with an ellipsis', () => {
    const s = setup();
    s.d.sessions.start('a', welder);
    note(s, 'a', 'y'.repeat(300));
    expect(s.d.sessions.queue({ since: s.since }).running[0]!.lastEntry!.body).toBe(
      'y'.repeat(300),
    );
    s.clock.advance(1);
    note(s, 'a', 'z'.repeat(301));
    const b = s.d.sessions.queue({ since: s.since }).running[0]!.lastEntry!.body;
    expect(b).toBe(`${'z'.repeat(299)}…`);
  });

  it('accented text is cut by characters', () => {
    const s = setup();
    s.d.sessions.start('a', welder);
    note(s, 'a', 'è'.repeat(400));
    const b = s.d.sessions.queue({ since: s.since }).running[0]!.lastEntry!.body;
    expect(b).toBe(`${'è'.repeat(299)}…`);
  });

  it('the cut never splits a character outside the BMP (no lone surrogate)', () => {
    const s = setup();
    s.d.sessions.start('a', welder);
    // 298 ASCII characters then symbols outside the BMP: the cut at 299 UTF-16 units falls mid-pair.
    note(s, 'a', `${'a'.repeat(298)}${'\u{1F527}'.repeat(10)}`);
    const b = s.d.sessions.queue({ since: s.since }).running[0]!.lastEntry!.body;
    expect(b.isWellFormed()).toBe(true);
  });

  it('the newest entry wins: a later event beats an earlier note, a backdated note does not count', () => {
    const s = setup();
    s.d.sessions.start('a', welder);
    note(s, 'a', 'Started');
    s.clock.advance(MIN);
    s.d.roadmap.completeTask(s.p.phases[0]!.tasks[0]!.id, { ...CLAUDE, sessionId: 'a' });
    s.clock.advance(MIN);
    // Imported history from the same session is not part of it (verification A8).
    s.d.diary.addNote(
      s.p.id,
      { body: 'Imported', occurredAt: '2026-11-01T10:00:00.000Z' },
      { ...CLAUDE, sessionId: 'a' },
    );
    const e = s.d.sessions.queue({ since: s.since }).running[0]!.lastEntry!;
    expect(e.body).toBe('Completed task: Schematic');
    expect(e.occurredAt).toBe(new Date(s.clock.now - MIN).toISOString());
  });

  it('two entries at the same instant: the one written last wins', () => {
    const s = setup();
    s.d.sessions.start('a', welder);
    note(s, 'a', 'first');
    note(s, 'a', 'second');
    expect(s.d.sessions.queue({ since: s.since }).running[0]!.lastEntry!.body).toBe('second');
  });

  it('another session’s notes are never shown', () => {
    const s = setup();
    s.d.sessions.start('a', welder);
    s.d.sessions.start('b', welder);
    note(s, 'b', 'from b');
    const q = s.d.sessions.queue({ since: s.since });
    const a = q.running.find((x) => x.sessionId === 'a')!;
    expect(a.lastEntry).toBeNull();
  });

  it('an ended session whose only entry was written into another project is still listed', () => {
    const s = setup();
    const other = seedProject(s.d, { name: 'Notes elsewhere' });
    s.d.sessions.start('a', welder);
    note(s, 'a', 'Wrote here', other.id);
    s.d.sessions.end('a', 'other');
    const q = s.d.sessions.queue({ since: s.since });
    // Recorded, not asserted as a bug: the row links to the session's project.
    expect(q.ended[0]).toMatchObject({ projectId: s.p.id, lastEntry: { body: 'Wrote here' } });
  });
});
