// @vitest-environment happy-dom
import type { MaterialView, ProjectDocsView } from '@heph/schema';
import { cleanup, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { HttpResponse, http } from 'msw';
import { setupServer } from 'msw/node';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { DocsTab } from './features/project/DocsTab.js';
import { MaterialsTab } from './features/project/MaterialsTab.js';
import { detail, renderApp } from './test/render.js';

// Independent verification, phase 4 group B (docs and materials). Invented data.
let docs: ProjectDocsView = {
  projectId: 1,
  source: 'internal',
  internal: '# Banco\n\nVecchie note.',
  repos: [],
} as ProjectDocsView;
let materials: MaterialView[] = [];
const patches: unknown[] = [];
const server = setupServer(
  http.get('/api/projects', () => HttpResponse.json([])),
  http.get('/api/projects/:ref/docs', () => HttpResponse.json(docs)),
  http.patch('/api/projects/:ref', async ({ request }) => {
    const body = (await request.json()) as { internalDocs?: string };
    patches.push(body);
    if (body.internalDocs !== undefined) docs = { ...docs, internal: body.internalDocs };
    return HttpResponse.json(detail([]));
  }),
  http.get('/api/projects/:ref/materials', () => HttpResponse.json(materials)),
  http.patch('/api/materials/:id', async ({ request, params }) => {
    const body = (await request.json()) as Partial<MaterialView>;
    materials = materials.map((m) => (m.id === Number(params.id) ? { ...m, ...body } : m));
    return HttpResponse.json(materials.find((m) => m.id === Number(params.id)));
  }),
);
beforeAll(() => server.listen({ onUnhandledFrame: 'error' }));
afterEach(() => {
  cleanup();
  patches.length = 0;
});
afterAll(() => server.close());

describe('verifyB internal docs', () => {
  it('saves Italian Markdown and renders it, including a table', async () => {
    const user = userEvent.setup();
    renderApp(<DocsTab projectRef="banco" />);
    await user.click(await screen.findByRole('button', { name: 'Modifica' }));
    const box = screen.getByLabelText('Documentazione interna', { selector: 'textarea' });
    await user.clear(box);
    await user.type(
      box,
      '## Perché il legno di faggio{Enter}{Enter}| a | b |{Enter}|---|---|{Enter}| 1 | 2 |',
    );
    await user.click(screen.getByRole('button', { name: 'Salva' }));
    await waitFor(() => expect(patches).toHaveLength(1));
    expect(await screen.findByRole('heading', { name: 'Perché il legno di faggio' })).toBeTruthy();
    expect(screen.getByRole('table')).toBeTruthy();
  });

  it('lets the user empty the documentation', async () => {
    const user = userEvent.setup();
    renderApp(<DocsTab projectRef="banco" />);
    await user.click(await screen.findByRole('button', { name: 'Modifica' }));
    await user.clear(screen.getByLabelText('Documentazione interna', { selector: 'textarea' }));
    const save = screen.getByRole('button', { name: 'Salva' }) as HTMLButtonElement;
    expect(save.disabled).toBe(false);
  });
});

describe('verifyB materials', () => {
  it('changing a status inline updates the totals', async () => {
    materials = [
      {
        id: 1,
        projectId: 1,
        phaseId: null,
        name: 'Viti 4x40',
        quantity: 2,
        unit: 'scatole',
        link: null,
        price: 3.5,
        currency: 'EUR',
        notes: '',
        status: 'to_buy',
        createdAt: '2026-11-25T10:00:00.000Z',
        updatedAt: '2026-11-25T10:00:00.000Z',
      } as MaterialView,
    ];
    const user = userEvent.setup();
    const { container } = renderApp(<MaterialsTab projectRef="banco" />);
    const select = await screen.findByRole('combobox', { name: /Viti 4x40/ });
    const totals = container.querySelector('.totals') as HTMLElement;
    const count = (label: string) =>
      within(totals).getByText(label).parentElement?.querySelector('.total-n')?.textContent;
    expect(count('Da comprare')).toBe('1');
    await user.selectOptions(select, 'ordered');
    await waitFor(() => expect(count('Ordinato')).toBe('1'));
    expect(count('Da comprare')).toBe('0');
  });
});
