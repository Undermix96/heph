// @vitest-environment happy-dom
import type { MaterialView } from '@heph/schema';
import { cleanup, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { HttpResponse, http } from 'msw';
import { setupServer } from 'msw/node';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { renderApp } from '../../test/render.js';
import { headings } from './DocsTab.js';
import { MaterialsTab, materialTotals } from './MaterialsTab.js';

// Invented materials.
const m = (id: number, over: Partial<MaterialView>): MaterialView => ({
  id,
  projectId: 1,
  phaseId: null,
  name: `M${id}`,
  quantity: 1,
  unit: null,
  link: null,
  price: null,
  currency: 'EUR',
  notes: '',
  status: 'to_buy',
  position: id,
  createdAt: '2026-11-25T10:00:00.000Z',
  updatedAt: '2026-11-25T10:00:00.000Z',
  ...over,
});

describe('materialTotals', () => {
  it('counts per status and sums price × quantity, rounding to cents', () => {
    const r = materialTotals([
      m(1, { price: 0.1, quantity: 3 }),
      m(2, { price: 2.5, quantity: 2, status: 'arrived' }),
      m(3, { status: 'used' }),
    ]);
    expect(r.byStatus).toEqual({ to_buy: 1, ordered: 0, arrived: 1, used: 1 });
    expect(r.cost).toBe(5.3);
    expect(r.toSpend).toBe(0.3);
  });
});

describe('headings', () => {
  it('lists levels 1–3 outside fenced code', () => {
    expect(headings('# A\n```\n# not\n```\n## B ##\n#### deep\n### C')).toEqual([
      { level: 1, text: 'A' },
      { level: 2, text: 'B' },
      { level: 3, text: 'C' },
    ]);
  });
});

const posted: unknown[] = [];
const server = setupServer(
  http.get('/api/projects/:ref/materials', () =>
    HttpResponse.json([m(1, { name: 'Viti M3', price: 4, quantity: 2 })]),
  ),
  http.post('/api/projects/:ref/materials', async ({ request }) => {
    posted.push(await request.json());
    return HttpResponse.json(m(2, {}), { status: 201 });
  }),
  http.patch('/api/materials/:id', async ({ request }) => {
    posted.push(await request.json());
    return HttpResponse.json(m(1, { status: 'ordered' }));
  }),
  http.get('/api/projects', () => HttpResponse.json([])),
);
beforeAll(() => server.listen({ onUnhandledFrame: 'error' }));
afterEach(() => {
  cleanup();
  posted.length = 0;
});
afterAll(() => server.close());

describe('MaterialsTab', () => {
  it('adds with a decimal comma and changes the status inline', async () => {
    const user = userEvent.setup();
    renderApp(<MaterialsTab projectRef="banco" />);
    await screen.findByText('Viti M3');
    await user.type(screen.getByLabelText('Nome'), 'Colla vinilica');
    await user.type(screen.getByLabelText('Prezzo'), '3,50');
    await user.click(screen.getByRole('button', { name: 'Aggiungi' }));
    await waitFor(() =>
      expect(posted).toEqual([{ name: 'Colla vinilica', quantity: 1, unit: null, price: 3.5 }]),
    );
    await user.selectOptions(screen.getByLabelText('Stato di Viti M3'), 'ordered');
    await waitFor(() => expect(posted.at(-1)).toEqual({ status: 'ordered' }));
  });

  it('refuses a zero quantity with a visible message and sends nothing', async () => {
    const user = userEvent.setup();
    renderApp(<MaterialsTab projectRef="banco" />);
    await screen.findByText('Viti M3');
    await user.type(screen.getByLabelText('Nome'), 'Chiodi');
    await user.clear(screen.getByLabelText('Quantità'));
    await user.type(screen.getByLabelText('Quantità'), '0');
    await user.click(screen.getByRole('button', { name: 'Aggiungi' }));
    expect(await screen.findByText(/Quantità e prezzo devono essere numeri/)).toBeTruthy();
    expect(posted).toEqual([]);
  });
});
