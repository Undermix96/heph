import { afterEach, describe, expect, it } from 'vitest';
import { type Api, startApi } from '../test/api.js';

let t: Api | undefined;
afterEach(() => {
  t?.cleanup();
  t = undefined;
});

type Hit = {
  kind: string;
  refId: number;
  projectId: number;
  projectSlug: string;
  projectName: string;
  title: string;
  snippet: string;
};

async function seedSearch(api: Api) {
  const a = await api.createProject({
    name: 'Spot Welder',
    description: 'Capacitor discharge welder for battery tabs',
    phases: [{ title: 'Electronics', tasks: ['Solder the capacitor bank', 'Mount relay'] }],
  });
  const b = await api.createProject({
    name: 'Garden Lamp',
    phases: [{ title: 'Capacitor tests', tasks: ['Order parts'] }],
  });
  const note = await api.uiReq('POST', `/api/projects/${a.slug}/diary`, {
    json: { body: 'Blew a capacitor today <b>oops</b> & learned a lot' },
  });
  return { a, b, noteId: note.data.id as number };
}

describe('search', () => {
  it('finds projects, phases, tasks and diary entries with <mark> snippets', async () => {
    t = await startApi();
    const { a, b, noteId } = await seedSearch(t);
    const r = await t.agentReq('GET', '/api/search?q=capacitor');
    expect(r.status).toBe(200);
    const hits = r.data as Hit[];
    const keys = hits.map((h) => `${h.kind}:${h.projectSlug}`).sort();
    expect(keys).toEqual(
      [`diary:${a.slug}`, `phase:${b.slug}`, `project:${a.slug}`, `task:${a.slug}`].sort(),
    );
    const task = hits.find((h) => h.kind === 'task')!;
    expect(task).toMatchObject({
      refId: a.phases[0].tasks[0].id,
      projectId: a.id,
      projectName: 'Spot Welder',
      title: 'Solder the capacitor bank',
    });
    const diary = hits.find((h) => h.kind === 'diary')!;
    expect(diary.refId).toBe(noteId);
    expect(diary.snippet).toContain('<mark>capacitor</mark>');
    // Stored text is HTML-escaped; only <mark> is real markup.
    expect(diary.snippet).not.toContain('<b>');
    expect(diary.snippet).toContain('&#60;b&#62;');
    expect(diary.snippet).toContain('&#38;');
    // Prefix search.
    const prefix = await t.uiReq('GET', '/api/search?q=capac');
    expect(prefix.data.length).toBe(hits.length);
    // All words must match.
    const both = await t.uiReq('GET', '/api/search?q=capacitor%20relay');
    expect(both.data).toEqual([]);
    const both2 = await t.uiReq('GET', '/api/search?q=solder%20bank');
    expect(both2.data.map((h: Hit) => h.kind)).toEqual(['task']);
  });

  it('filters by ?projectId and ?kinds (comma list or repeated)', async () => {
    t = await startApi();
    const { a, b } = await seedSearch(t);
    const kinds = (r: { data: Hit[] }) => r.data.map((h) => h.kind).sort();

    const inA = await t.uiReq('GET', `/api/search?q=capacitor&projectId=${a.id}`);
    expect(inA.data.every((h: Hit) => h.projectId === a.id)).toBe(true);
    expect(kinds(inA)).toEqual(['diary', 'project', 'task']);
    expect(kinds(await t.uiReq('GET', `/api/search?q=capacitor&projectId=${b.id}`))).toEqual([
      'phase',
    ]);
    expect(kinds(await t.uiReq('GET', '/api/search?q=capacitor&kinds=task,diary'))).toEqual([
      'diary',
      'task',
    ]);
    expect(kinds(await t.uiReq('GET', '/api/search?q=capacitor&kinds=task&kinds=phase'))).toEqual([
      'phase',
      'task',
    ]);
    expect(
      kinds(await t.uiReq('GET', `/api/search?q=capacitor&kinds=diary&projectId=${b.id}`)),
    ).toEqual([]);
    expect((await t.uiReq('GET', '/api/search?q=capacitor&limit=1')).data).toHaveLength(1);
  });

  it('never errors on FTS syntax in the query', async () => {
    t = await startApi();
    await seedSearch(t);
    for (const q of [
      '"*NEAR(',
      'NEAR(capacitor relay)',
      'capacitor OR',
      'AND',
      '-capacitor',
      'capacitor*',
      '^capacitor',
      'title:capacitor',
      '"unbalanced',
      "'; drop table projects; --",
      '()',
      '***',
      '😀',
      'x'.repeat(400),
    ]) {
      const r = await t.uiReq('GET', `/api/search?q=${encodeURIComponent(q)}`);
      expect(r.status, q).toBe(200);
      expect(Array.isArray(r.data), q).toBe(true);
    }
    // Operators are inert: the words are searched literally.
    const near = await t.uiReq('GET', `/api/search?q=${encodeURIComponent('"*NEAR(')}`);
    expect(near.data).toEqual([]);
    const col = await t.uiReq('GET', `/api/search?q=${encodeURIComponent('title:capacitor')}`);
    expect(col.data).toEqual([]);
    const star = await t.uiReq('GET', `/api/search?q=${encodeURIComponent('capacitor*')}`);
    expect(star.data.length).toBeGreaterThan(0);
    // Projects still exist.
    expect((await t.uiReq('GET', '/api/projects')).data).toHaveLength(2);
  });

  it('validates the query (400)', async () => {
    t = await startApi();
    for (const q of [
      '',
      'q=',
      'q=%20%20',
      `q=${'x'.repeat(501)}`,
      'q=a&projectId=abc',
      'q=a&kinds=tasks',
      'q=a&limit=0',
      'q=a&limit=201',
    ]) {
      const r = await t.uiReq('GET', `/api/search?${q}`);
      expect(r.status, q).toBe(400);
      expect(r.data.error.code).toBe('validation');
    }
  });

  it('reflects updates and deletions', async () => {
    t = await startApi();
    const { a } = await seedSearch(t);
    const taskId = a.phases[0].tasks[1].id;
    await t.uiReq('PATCH', `/api/tasks/${taskId}`, { json: { title: 'Mount contactor' } });
    expect((await t.uiReq('GET', '/api/search?q=relay')).data).toEqual([]);
    expect((await t.uiReq('GET', '/api/search?q=contactor')).data.map((h: Hit) => h.refId)).toEqual(
      [taskId],
    );
    await t.uiReq('DELETE', `/api/projects/${a.slug}`);
    const after = await t.uiReq('GET', '/api/search?q=capacitor');
    expect(after.data.map((h: Hit) => h.kind)).toEqual(['phase']);
  });
});
