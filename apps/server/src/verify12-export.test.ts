// Independent verification of the export endpoint, round 12. Invented data only.
// Focus: a small, valid description makes the whole export fail (writer stack overflow).
import { afterEach, describe, expect, it } from 'vitest';
import { type Api, startApi } from './test/api.js';

let t: Api | undefined;
afterEach(() => {
  t?.cleanup();
  t = undefined;
});

const get = (p: string) => t!.ui.request(p, { headers: { cookie: t!.getCookie() } });

describe('verify12 export with deeply nested Markdown', () => {
  it('a 2 KB description of nested list markers still exports (zip and ?format=md)', async () => {
    t = await startApi();
    const p = await t.seed({ description: `${'- '.repeat(1000)}x` });
    expect((await get(`/api/projects/${p.id}/export?format=md`)).status).toBe(200);
    expect((await get(`/api/projects/${p.id}/export`)).status).toBe(200);
  });
});
