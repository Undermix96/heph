import { afterEach, describe, expect, it } from 'vitest';
import { UI } from './context.js';
import { toFtsQuery } from './search.js';
import { CLAUDE, expectDomainError } from './test/fixtures.js';
import { makeDomain, type TestDomain } from './test/helpers.js';

let t: TestDomain;
afterEach(() => t?.cleanup());

function setup() {
  t = makeDomain();
  const { d } = t;
  const welder = d.projects.create(
    {
      name: 'Saldatrice a punti',
      description: 'Una saldatrice per batterie <b>18650</b> & co.',
      phases: [{ title: 'Progettazione', tasks: ['Calibrare il sensore di corrente'] }],
    },
    UI,
  );
  const garden = d.projects.create(
    {
      name: 'Irrigazione giardino',
      description: 'Città e campagna',
      phases: [{ title: 'Sensori', tasks: ['Sensore di umidità'] }],
    },
    UI,
  );
  d.diary.addNote(welder.id, { body: 'Il trasformatore scalda troppo' }, CLAUDE);
  return { ...t, welder, garden };
}

describe('toFtsQuery', () => {
  it('quotes every word as a prefix term', () => {
    expect(toFtsQuery('foo bar')).toBe('"foo"* "bar"*');
    expect(toFtsQuery('  ')).toBeNull();
    expect(toFtsQuery('"*-()')).toBeNull();
    expect(toFtsQuery('NEAR(a b)')).toBe('"NEAR"* "a"* "b"*');
  });
});

describe('search', () => {
  it('matches word prefixes across kinds', () => {
    const { d, welder } = setup();
    const hits = d.search.search({ q: 'saldat' });
    expect(hits.map((h) => h.kind)).toContain('project');
    expect(hits.every((h) => h.projectId === welder.id)).toBe(true);
    expect(hits[0]).toMatchObject({ projectSlug: welder.slug, projectName: welder.name });
    expect(d.search.search({ q: 'calibr' }).map((h) => h.kind)).toEqual(['task']);
    expect(d.search.search({ q: 'trasform' }).map((h) => h.kind)).toEqual(['diary']);
    expect(d.search.search({ q: 'progett' }).map((h) => h.kind)).toEqual(['phase']);
  });

  it('is diacritics-insensitive both ways', () => {
    const { d, garden } = setup();
    expect(d.search.search({ q: 'citta' }).map((h) => h.projectId)).toEqual([garden.id]);
    expect(d.search.search({ q: 'umidita' })[0]?.kind).toBe('task');
    expect(d.search.search({ q: 'Umidità' })[0]?.kind).toBe('task');
  });

  it('requires all words to match', () => {
    const { d } = setup();
    expect(d.search.search({ q: 'sensore corrente' }).map((h) => h.kind)).toEqual(['task']);
    expect(d.search.search({ q: 'sensore zebra' })).toEqual([]);
  });

  it('filters by project and by kinds', () => {
    const { d, welder, garden } = setup();
    const all = d.search.search({ q: 'sensor' });
    expect(new Set(all.map((h) => h.projectId))).toEqual(new Set([welder.id, garden.id]));
    const onlyGarden = d.search.search({ q: 'sensor', projectId: garden.id });
    expect(onlyGarden.length).toBeGreaterThan(0);
    expect(onlyGarden.every((h) => h.projectId === garden.id)).toBe(true);
    const phasesOnly = d.search.search({ q: 'sensor', kinds: ['phase'] });
    expect(phasesOnly.map((h) => [h.kind, h.title])).toEqual([['phase', 'Sensori']]);
    expect(d.search.search({ q: 'sensor', kinds: ['diary', 'project'] })).toEqual([]);
  });

  it.each([
    '"',
    '""',
    'saldat"',
    '*',
    'saldat*',
    'NEAR(saldatrice punti)',
    '-saldatrice',
    'saldatrice OR punti',
    'saldatrice AND NOT punti',
    'title:saldatrice',
    '^saldatrice',
    '(((',
    "'; drop table projects; --",
  ])('does not throw on FTS syntax in user input: %s', (q) => {
    const { d } = setup();
    expect(() => d.search.search({ q })).not.toThrow();
  });

  it('treats operators as plain words', () => {
    const { d } = setup();
    expect(d.search.search({ q: '-saldatrice' }).length).toBeGreaterThan(0);
    expect(d.search.search({ q: 'saldatrice OR zebra' })).toEqual([]);
  });

  it('HTML-escapes snippets and marks matches', () => {
    const { d } = setup();
    const hit = d.search.search({ q: 'batterie', kinds: ['project'] })[0]!;
    expect(hit.snippet).toContain('<mark>batterie</mark>');
    expect(hit.snippet).not.toContain('<b>');
    expect(hit.snippet).toContain('&#60;b&#62;');
    expect(hit.snippet).toContain('&#38;');
  });

  it('follows updates and deletes', () => {
    const { d, welder } = setup();
    const taskId = welder.phases[0]!.tasks[0]!.id;
    d.roadmap.updateTask(taskId, { title: 'Montare la ventola' }, UI);
    expect(d.search.search({ q: 'calibr' })).toEqual([]);
    expect(d.search.search({ q: 'ventol' }).map((h) => h.refId)).toEqual([taskId]);
    d.roadmap.deleteTask(taskId, UI);
    expect(d.search.search({ q: 'ventol' })).toEqual([]);
    d.projects.delete(welder.id, UI);
    expect(d.search.search({ q: 'trasform' })).toEqual([]);
  });

  it('respects the limit and validates the query', () => {
    const { d } = setup();
    expect(d.search.search({ q: 'sensor', limit: 1 })).toHaveLength(1);
    expectDomainError(() => d.search.search({ q: '' }), 'validation');
    expectDomainError(() => d.search.search({ q: 'x', kinds: ['nope'] }), 'validation');
  });
});
