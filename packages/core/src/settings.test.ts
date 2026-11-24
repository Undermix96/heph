import { DEFAULT_SETTINGS } from '@heph/schema';
import { afterEach, describe, expect, it } from 'vitest';
import { SYSTEM, UI } from './context.js';
import { changeLog, settings } from './db/schema.js';
import { CLAUDE, CLAUDE_CONFIRMED, expectDomainError } from './test/fixtures.js';
import { makeDomain, type TestDomain } from './test/helpers.js';

let t: TestDomain;
afterEach(() => t?.cleanup());

describe('settings', () => {
  it('returns defaults when nothing is stored', () => {
    t = makeDomain();
    expect(t.d.settings.get()).toEqual(DEFAULT_SETTINGS);
  });

  it('updates and persists a partial patch', () => {
    t = makeDomain();
    const s = t.d.settings.update({ maxUploadMb: 5, currency: 'chf', uiLanguage: 'en' }, UI);
    expect(s).toMatchObject({ maxUploadMb: 5, currency: 'CHF', uiLanguage: 'en' });
    expect(t.d.settings.get().inactiveDays).toBe(30);
    expect(t.d.settings.get().maxUploadMb).toBe(5);
  });

  it('validates values', () => {
    t = makeDomain();
    const { d } = t;
    expectDomainError(() => d.settings.update({ maxUploadMb: 0 }, UI), 'validation');
    expectDomainError(() => d.settings.update({ uiLanguage: 'fr' }, UI), 'validation');
    expectDomainError(() => d.settings.update({ currency: 'EURO' }, UI), 'validation');
    expectDomainError(
      () => d.settings.update({ recentlyActiveDays: 10, inactiveDays: 10 }, UI),
      'validation',
    );
    // Checked against stored values too.
    expectDomainError(() => d.settings.update({ recentlyActiveDays: 30 }, UI), 'validation');
    expectDomainError(() => d.settings.update({ inactiveDays: 7 }, UI), 'validation');
    expect(d.settings.get()).toEqual(DEFAULT_SETTINGS);
  });

  it('only the user (or system) can change settings', () => {
    t = makeDomain();
    const { d } = t;
    expectDomainError(() => d.settings.update({ maxUploadMb: 1 }, CLAUDE), 'forbidden');
    expectDomainError(() => d.settings.update({ maxUploadMb: 1 }, CLAUDE_CONFIRMED), 'forbidden');
    expectDomainError(
      () => d.settings.update({ maxUploadMb: 1 }, { source: 'github' }),
      'forbidden',
    );
    expect(d.settings.update({ maxUploadMb: 2 }, SYSTEM).maxUploadMb).toBe(2);
  });

  it('masks the GitHub token in the audit log', () => {
    t = makeDomain();
    const { d } = t;
    d.settings.update({ githubToken: 'ghp_secret' }, UI);
    expect(d.settings.get().githubToken).toBe('ghp_secret');
    const log = d.db.select().from(changeLog).all();
    expect(JSON.stringify(log)).not.toContain('ghp_secret');
  });

  it('falls back to defaults per key for invalid stored values', () => {
    t = makeDomain();
    const { d } = t;
    d.settings.update({ maxUploadMb: 7 }, UI);
    d.db
      .insert(settings)
      .values({ key: 'inactiveDays', value: 'not a number', updatedAt: 0 })
      .onConflictDoUpdate({ target: settings.key, set: { value: 'not a number' } })
      .run();
    const s = d.settings.get();
    expect(s.inactiveDays).toBe(DEFAULT_SETTINGS.inactiveDays);
    expect(s.maxUploadMb).toBe(7);
  });

  it('never returns the API token among user settings', () => {
    t = makeDomain();
    t.d.settings.setApiToken('heph_x');
    expect(JSON.stringify(t.d.settings.get())).not.toContain('heph_x');
    expect(t.d.settings.getApiToken()).toBe('heph_x');
  });
});
