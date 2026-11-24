import { afterEach, describe, expect, it } from 'vitest';
import { UI } from './context.js';
import { CLAUDE, expectDomainError, seedProject } from './test/fixtures.js';
import { makeDomain, type TestDomain } from './test/helpers.js';

let t: TestDomain;
afterEach(() => t?.cleanup());

function setup() {
  t = makeDomain();
  const p = seedProject(t.d);
  return { ...t, p };
}

describe('materials', () => {
  it('adds with defaults and the settings currency', () => {
    const { d, p } = setup();
    const m = d.materials.add(p.id, { name: 'M3 screws' }, CLAUDE);
    expect(m).toMatchObject({
      name: 'M3 screws',
      quantity: 1,
      unit: null,
      price: null,
      currency: 'EUR',
      status: 'to_buy',
      position: 0,
      phaseId: null,
    });
    expect(d.materials.add(p.id, { name: 'Nuts' }, UI).position).toBe(1);
  });

  it.each([12.34, 0.1, 19.99, 0.005, 1234.5, 0])('round-trips price %s through cents', (price) => {
    const { d, p } = setup();
    const m = d.materials.add(p.id, { name: 'X', price }, UI);
    expect(m.price).toBe(Math.round(price * 100) / 100);
  });

  it('updates price, clears it with null and leaves it alone when omitted', () => {
    const { d, p } = setup();
    const m = d.materials.add(
      p.id,
      { name: 'Copper strip', price: 4.5, quantity: 2, unit: 'm' },
      UI,
    );
    expect(d.materials.update(m.id, { status: 'ordered' }, UI)).toMatchObject({
      price: 4.5,
      status: 'ordered',
      quantity: 2,
      unit: 'm',
    });
    expect(d.materials.update(m.id, { price: 3.99 }, UI).price).toBe(3.99);
    expect(d.materials.update(m.id, { price: null }, UI).price).toBeNull();
  });

  it('reflects a currency change in settings', () => {
    const { d, p } = setup();
    const m = d.materials.add(p.id, { name: 'X', price: 1 }, UI);
    d.settings.update({ currency: 'usd' }, UI);
    expect(d.materials.get(m.id).currency).toBe('USD');
  });

  it('checks the phase belongs to the project', () => {
    const { d, p } = setup();
    const other = seedProject(d, { name: 'Other' });
    const m = d.materials.add(p.id, { name: 'X', phaseId: p.phases[1]!.id }, UI);
    expect(m.phaseId).toBe(p.phases[1]!.id);
    expectDomainError(
      () => d.materials.add(p.id, { name: 'Y', phaseId: other.phases[0]!.id }, UI),
      'validation',
    );
    expectDomainError(() => d.materials.add(p.id, { name: 'Y', phaseId: 9999 }, UI), 'validation');
    expectDomainError(
      () => d.materials.update(m.id, { phaseId: other.phases[0]!.id }, UI),
      'validation',
    );
    expect(d.materials.update(m.id, { phaseId: null }, UI).phaseId).toBeNull();
  });

  it('validates input', () => {
    const { d, p } = setup();
    expectDomainError(() => d.materials.add(p.id, { name: 'X', price: -1 }, UI), 'validation');
    expectDomainError(() => d.materials.add(p.id, { name: 'X', quantity: 0 }, UI), 'validation');
    expectDomainError(() => d.materials.add(p.id, { name: '' }, UI), 'validation');
    expectDomainError(() => d.materials.add(p.id, { name: 'X', status: 'lost' }, UI), 'validation');
  });

  it('lists in position order and deletes', () => {
    const { d, p } = setup();
    const a = d.materials.add(p.id, { name: 'A' }, UI);
    d.materials.add(p.id, { name: 'B' }, UI);
    expect(d.materials.list(p.slug).map((m) => m.name)).toEqual(['A', 'B']);
    d.materials.delete(a.id, UI);
    expect(d.materials.list(p.id).map((m) => m.name)).toEqual(['B']);
    expectDomainError(() => d.materials.get(a.id), 'not_found');
  });
});
