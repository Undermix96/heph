import { afterEach, describe, expect, it } from 'vitest';
import { UI } from './context.js';
import { QUEUE_ENDED_MAX } from './sessions.js';
import { CLAUDE, expectDomainError, seedProject } from './test/fixtures.js';
import { makeDomain, type TestDomain } from './test/helpers.js';

let t: TestDomain;
afterEach(() => t?.cleanup());

const MIN = 60_000;
const facts = { remote: 'git@github.com:me/welder.git', cwd: '/w' };

function setup() {
  t = makeDomain();
  const p = seedProject(t.d, { repos: ['me/welder'] });
  // Start of the viewer's day: the clock starts at 12:00 UTC.
  const since = new Date(t.clock.now - 6 * 60 * MIN).toISOString();
  return { ...t, p, since };
}

const note = (s: ReturnType<typeof setup>, sessionId: string, body: string) =>
  s.d.diary.addNote(s.p.id, { body }, { ...CLAUDE, sessionId });

describe("Claude's queue (D76)", () => {
  it('lists a running session with its state and last diary entry', () => {
    const s = setup();
    s.d.sessions.start('a', facts);
    expect(s.d.sessions.queue({ since: s.since })).toEqual({
      running: [
        {
          sessionId: 'a',
          projectId: s.p.id,
          projectSlug: s.p.slug,
          projectName: 'Spot Welder',
          state: 'working',
          startedAt: new Date(s.clock.now).toISOString(),
          endedAt: null,
          lastEntry: null,
        },
      ],
      ended: [],
    });
    s.clock.advance(MIN);
    note(s, 'a', 'First note');
    s.clock.advance(MIN);
    note(s, 'a', '  Writing the tests for POST /api/diary  ');
    s.d.sessions.toolStart('a', 'tu1', 'npm test', facts);
    const q = s.d.sessions.queue({ since: s.since });
    expect(q.running[0]).toMatchObject({
      state: 'testing',
      lastEntry: { body: 'Writing the tests for POST /api/diary' },
    });
  });

  it('an ended session is listed only with a diary entry, newest first', () => {
    const s = setup();
    s.d.sessions.start('quiet', facts);
    s.d.sessions.end('quiet', 'other');
    s.d.sessions.start('busy', facts);
    note(s, 'busy', 'Closed 3 tasks');
    s.clock.advance(MIN);
    s.d.sessions.end('busy', 'other');
    s.d.sessions.start('later', facts);
    note(s, 'later', 'Done');
    s.clock.advance(MIN);
    s.d.sessions.end('later', 'other');
    const q = s.d.sessions.queue({ since: s.since });
    expect(q.running).toEqual([]);
    expect(q.ended.map((x) => x.sessionId)).toEqual(['later', 'busy']);
    expect(q.ended[1]).toMatchObject({
      state: 'ended',
      endedAt: new Date(s.clock.now - MIN).toISOString(),
      lastEntry: { body: 'Closed 3 tasks' },
    });
  });

  it('a session that went silent counts as ended at its last heartbeat', () => {
    const s = setup();
    s.d.sessions.start('a', facts);
    note(s, 'a', 'Working');
    const beat = s.clock.now;
    s.clock.advance(s.d.settings.get().sessionExpiryMinutes * MIN + MIN);
    const q = s.d.sessions.queue({ since: s.since });
    expect(q.running).toEqual([]);
    expect(q.ended[0]).toMatchObject({ state: 'ended', endedAt: new Date(beat).toISOString() });
  });

  it('sessions that ended before `since`, or without a project, are left out', () => {
    const s = setup();
    s.d.sessions.start('yesterday', facts);
    note(s, 'yesterday', 'old');
    s.d.sessions.end('yesterday', 'other');
    s.clock.advance(7 * 60 * MIN);
    const since = new Date(s.clock.now - MIN).toISOString();
    s.d.sessions.start('other-repo', { remote: 'git@github.com:me/unlinked.git' });
    s.d.sessions.start('no-git', {});
    expect(s.d.sessions.queue({ since })).toEqual({ running: [], ended: [] });
  });

  it('long entries are cut to 300 characters; at most QUEUE_ENDED_MAX ended sessions', () => {
    const s = setup();
    for (let i = 0; i < QUEUE_ENDED_MAX + 3; i++) {
      s.d.sessions.start(`s${i}`, facts);
      note(s, `s${i}`, 'x'.repeat(500));
      s.clock.advance(1000);
      s.d.sessions.end(`s${i}`, 'other');
    }
    const q = s.d.sessions.queue({ since: s.since });
    expect(q.ended).toHaveLength(QUEUE_ENDED_MAX);
    expect(q.ended[0]!.sessionId).toBe(`s${QUEUE_ENDED_MAX + 2}`);
    expect(q.ended[0]!.lastEntry!.body).toHaveLength(300);
    expect(q.ended[0]!.lastEntry!.body.endsWith('…')).toBe(true);
  });

  it('events of the session count as its last entry too', () => {
    const s = setup();
    s.d.sessions.start('a', facts);
    s.clock.advance(MIN);
    s.d.roadmap.completeTask(s.p.phases[0]!.tasks[0]!.id, { ...CLAUDE, sessionId: 'a' });
    expect(s.d.sessions.queue({ since: s.since }).running[0]!.lastEntry).toMatchObject({
      body: 'Completed task: Schematic',
    });
    // A UI note is not the session's.
    s.d.diary.addNote(s.p.id, { body: 'mine' }, UI);
    expect(s.d.sessions.queue({ since: s.since }).running[0]!.lastEntry!.body).toBe(
      'Completed task: Schematic',
    );
  });

  it('`since` is required and must be an ISO time', () => {
    const s = setup();
    expectDomainError(() => s.d.sessions.queue({}), 'validation');
    expectDomainError(() => s.d.sessions.queue({ since: 'today' }), 'validation');
  });
});
