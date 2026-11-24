import { afterEach, describe, expect, it } from 'vitest';
import { type Api, startApi } from '../test/api.js';

let t: Api | undefined;
afterEach(() => {
  t?.cleanup();
  t = undefined;
});

describe('materials', () => {
  it('adds materials with defaults, decimal prices and the settings currency', async () => {
    t = await startApi();
    const p = await t.seed();
    const a = await t.agentReq('POST', `/api/projects/${p.slug}/materials`, {
      json: { name: 'Nickel strip' },
    });
    expect(a.status).toBe(201);
    expect(a.data).toMatchObject({
      projectId: p.id,
      phaseId: null,
      name: 'Nickel strip',
      quantity: 1,
      unit: null,
      link: null,
      price: null,
      currency: 'EUR',
      notes: '',
      status: 'to_buy',
      position: 0,
    });
    const b = await t.uiReq('POST', `/api/projects/${p.id}/materials`, {
      json: {
        name: 'Capacitor',
        quantity: 2.5,
        unit: 'pcs',
        link: 'https://shop.example/cap',
        price: 19.99,
        notes: '450 V',
        status: 'ordered',
        phaseId: p.phases[1].id,
      },
    });
    expect(b.status).toBe(201);
    expect(b.data).toMatchObject({
      quantity: 2.5,
      unit: 'pcs',
      price: 19.99,
      status: 'ordered',
      phaseId: p.phases[1].id,
      position: 1,
    });
    const c = await t.uiReq('POST', `/api/projects/${p.id}/materials`, {
      json: { name: 'Screws', price: 0.1 },
    });
    expect(c.data.price).toBe(0.1);
    const d = await t.uiReq('POST', `/api/projects/${p.id}/materials`, {
      json: { name: 'Free', price: 0 },
    });
    expect(d.data.price).toBe(0);
    // Sub-cent prices are rounded to cents.
    const e = await t.uiReq('POST', `/api/projects/${p.id}/materials`, {
      json: { name: 'Rounded', price: 3.333 },
    });
    expect(e.data.price).toBe(3.33);

    const list = await t.agentReq('GET', `/api/projects/${p.slug}/materials`);
    expect(list.status).toBe(200);
    expect(list.data.map((m: { name: string }) => m.name)).toEqual([
      'Nickel strip',
      'Capacitor',
      'Screws',
      'Free',
      'Rounded',
    ]);

    // The currency follows the settings.
    await t.uiReq('PATCH', '/api/settings', { json: { currency: 'chf' } });
    const after = await t.agentReq('GET', `/api/projects/${p.slug}/materials`);
    expect(after.data.every((m: { currency: string }) => m.currency === 'CHF')).toBe(true);
  });

  it('validates material input', async () => {
    t = await startApi();
    const p = await t.seed();
    const other = await t.seed({ name: 'Other' });
    for (const json of [
      {},
      { name: '' },
      { name: 'x', price: -1 },
      { name: 'x', price: '12.50' },
      { name: 'x', quantity: 0 },
      { name: 'x', status: 'lost' },
      { name: 'x', link: 'nope' },
      { name: 'x', phaseId: other.phases[0].id },
      { name: 'x', phaseId: 99999 },
    ]) {
      const r = await t.uiReq('POST', `/api/projects/${p.slug}/materials`, { json });
      expect(r.status, JSON.stringify(json)).toBe(400);
      expect(r.data.error.code).toBe('validation');
    }
    expect((await t.uiReq('GET', '/api/projects/nope/materials')).status).toBe(404);
    expect(
      (await t.uiReq('POST', '/api/projects/nope/materials', { json: { name: 'x' } })).status,
    ).toBe(404);
  });

  it('updates and deletes materials', async () => {
    t = await startApi();
    const p = await t.seed();
    const m = await t.uiReq('POST', `/api/projects/${p.slug}/materials`, {
      json: { name: 'Relay', price: 4.2, phaseId: p.phases[0].id },
    });
    const id = m.data.id;
    const upd = await t.agentReq('PATCH', `/api/materials/${id}`, {
      json: { status: 'arrived', price: 5.05, quantity: 3 },
    });
    expect(upd.status).toBe(200);
    expect(upd.data).toMatchObject({
      name: 'Relay',
      status: 'arrived',
      price: 5.05,
      quantity: 3,
      phaseId: p.phases[0].id,
    });
    const cleared = await t.agentReq('PATCH', `/api/materials/${id}`, {
      json: { price: null, phaseId: null, unit: null },
    });
    expect(cleared.data).toMatchObject({ price: null, phaseId: null, unit: null });
    // An empty patch changes nothing.
    const same = await t.agentReq('PATCH', `/api/materials/${id}`, { json: {} });
    expect(same.status).toBe(200);
    expect(same.data.status).toBe('arrived');

    expect(
      (await t.agentReq('PATCH', `/api/materials/${id}`, { json: { price: -3 } })).status,
    ).toBe(400);
    expect((await t.agentReq('PATCH', '/api/materials/9999', { json: {} })).status).toBe(404);

    const del = await t.agentReq('DELETE', `/api/materials/${id}`);
    expect(del.status).toBe(204);
    expect(del.data).toBeNull();
    expect((await t.agentReq('PATCH', `/api/materials/${id}`, { json: {} })).status).toBe(404);
    expect((await t.agentReq('DELETE', `/api/materials/${id}`)).status).toBe(404);
    expect((await t.uiReq('GET', `/api/projects/${p.slug}/materials`)).data).toEqual([]);
  });

  it('agent writes are refused when Claude write access is off', async () => {
    t = await startApi();
    const p = await t.seed();
    const m = await t.uiReq('POST', `/api/projects/${p.slug}/materials`, { json: { name: 'A' } });
    await t.uiReq('PATCH', `/api/projects/${p.slug}`, { json: { claudeWriteEnabled: false } });
    expect(
      (await t.agentReq('PATCH', `/api/materials/${m.data.id}`, { json: { name: 'B' } })).status,
    ).toBe(403);
    expect((await t.agentReq('DELETE', `/api/materials/${m.data.id}`)).status).toBe(403);
    expect((await t.agentReq('GET', `/api/projects/${p.slug}/materials`)).data).toHaveLength(1);
  });
});
