// @vitest-environment happy-dom
import { cleanup, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { HttpResponse, http } from 'msw';
import { setupServer } from 'msw/node';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { detail, phase, renderApp, summary, task } from '../test/render.js';
import { DashboardPage } from './dashboard/DashboardPage.js';
import { StatusMenu } from './project/ProjectPage.js';
import { pathGroups } from './project/path.js';
import { RoadmapBoard } from './roadmap/RoadmapBoard.js';

// Fake API built on the @heph/schema view types; invented data only.
const calls: { method: string; path: string; body: unknown }[] = [];
// Claude's queue (D76) is empty unless a test says otherwise.
const server = setupServer(
  http.get('/api/claude-queue', () => HttpResponse.json({ running: [], ended: [] })),
);
const record =
  (status = 200, reply: unknown = {}) =>
  async ({ request }: { request: Request }) => {
    const body = request.method === 'GET' ? null : await request.json().catch(() => null);
    calls.push({ method: request.method, path: new URL(request.url).pathname, body });
    return HttpResponse.json(reply as never, { status });
  };

beforeAll(() => server.listen({ onUnhandledFrame: 'error' }));
afterEach(() => {
  cleanup();
  server.resetHandlers();
  calls.length = 0;
});
afterAll(() => server.close());

const roadmap = () => [
  phase(10, 0, [task(1, 10, 0, { title: 'Schema' }), task(2, 10, 1, { title: 'Distinta' })]),
  phase(20, 1, [task(3, 20, 0, { title: 'Case' })]),
];

describe('RoadmapBoard', () => {
  it('Move down sends the 0-based position and updates the order at once', async () => {
    server.use(
      http.post('/api/tasks/:id/move', record()),
      http.get('/api/projects/:ref', () => HttpResponse.json(detail(roadmap()))),
      http.get('/api/projects', () => HttpResponse.json([])),
    );
    const user = userEvent.setup();
    renderApp(<RoadmapBoard project={detail(roadmap())} />);
    await user.click(screen.getByRole('button', { name: 'Azioni per il task Schema' }));
    await user.click(screen.getByRole('button', { name: 'Sposta giù' }));
    await waitFor(() => expect(calls).toHaveLength(1));
    expect(calls[0]).toEqual({
      method: 'POST',
      path: '/api/tasks/1/move',
      body: { position: 1, phaseId: 10 },
    });
  });

  it('marks the next step and offers Set as next only for other open tasks', async () => {
    const user = userEvent.setup();
    renderApp(<RoadmapBoard project={detail(roadmap())} />);
    const schema = screen.getByText('Schema').closest('li') as HTMLElement;
    expect(within(schema).getByText('prossimo')).toBeTruthy();
    await user.click(screen.getByRole('button', { name: 'Azioni per il task Schema' }));
    expect(screen.queryByRole('button', { name: 'Imposta come prossimo' })).toBeNull();
  });

  it('shows a fixed error text when the server refuses a move (D44)', async () => {
    server.use(
      http.post('/api/tasks/:id/move', () =>
        HttpResponse.json(
          { error: { code: 'validation', message: 'raw detail' } },
          { status: 400 },
        ),
      ),
      http.get('/api/projects/:ref', () => HttpResponse.json(detail(roadmap()))),
      http.get('/api/projects', () => HttpResponse.json([])),
    );
    const user = userEvent.setup();
    renderApp(<RoadmapBoard project={detail(roadmap())} />);
    await user.click(screen.getByRole('button', { name: 'Azioni per il task Distinta' }));
    await user.click(screen.getByRole('button', { name: 'Sposta su' }));
    expect(await screen.findByText(/Alcuni dati non sono validi/)).toBeTruthy();
    expect(screen.queryByText('raw detail')).toBeNull();
  });

  it('Move up is disabled for the first task and Move down for the last', async () => {
    const user = userEvent.setup();
    renderApp(<RoadmapBoard project={detail(roadmap())} />);
    await user.click(screen.getByRole('button', { name: 'Azioni per il task Case' }));
    expect((screen.getByRole('button', { name: 'Sposta su' }) as HTMLButtonElement).disabled).toBe(
      true,
    );
    expect((screen.getByRole('button', { name: 'Sposta giù' }) as HTMLButtonElement).disabled).toBe(
      true,
    );
  });
});

describe('StatusMenu', () => {
  it('asks what to test before setting "waiting for my test"', async () => {
    server.use(
      http.post('/api/projects/:ref/status', record(200, detail(roadmap()))),
      http.get('/api/projects/:ref', () => HttpResponse.json(detail(roadmap()))),
      http.get('/api/projects', () => HttpResponse.json([])),
    );
    const user = userEvent.setup();
    renderApp(<StatusMenu p={detail(roadmap())} />);
    await user.click(screen.getByRole('button', { name: /Stato/ }));
    await user.click(screen.getByRole('button', { name: 'In attesa del mio test' }));
    const dialog = screen.getByRole('dialog');
    await user.click(within(dialog).getByRole('button', { name: 'Salva' }));
    expect(calls).toHaveLength(0); // empty note: nothing sent
    await user.type(within(dialog).getByLabelText('Cosa devo verificare?'), 'Il LED si accende');
    await user.click(within(dialog).getByRole('button', { name: 'Salva' }));
    await waitFor(() => expect(calls).toHaveLength(1));
    expect(calls[0]?.body).toEqual({ status: 'awaiting_manual_test', note: 'Il LED si accende' });
  });
});

describe('Dashboard', () => {
  it('orders by attention, hides closed projects and filters by text', async () => {
    server.use(
      http.get('/api/projects', () =>
        HttpResponse.json([
          summary({ id: 1, slug: 'a', name: 'Attivo', attentionGroup: 4 }),
          summary({
            id: 2,
            slug: 'b',
            name: 'Da testare',
            lifecycleStatus: 'awaiting_manual_test',
            badge: { kind: 'awaiting_manual_test' },
            attentionGroup: 1,
          }),
          summary({
            id: 3,
            slug: 'c',
            name: 'Chiuso',
            lifecycleStatus: 'completed',
            badge: { kind: 'completed' },
            attentionGroup: 6,
          }),
        ]),
      ),
      http.get('/api/proposals', () => HttpResponse.json([])),
    );
    const user = userEvent.setup();
    renderApp(<DashboardPage tab="projects" />);
    // Tile titles only (the side boxes also have level-2 headings).
    const names = async () =>
      (await screen.findAllByRole('heading', { level: 2 }))
        .filter((h) => h.classList.contains('tile-name'))
        .map((h) => h.textContent);
    expect(await names()).toEqual(['Da testare', 'Attivo']);
    await user.click(screen.getByLabelText('Mostra chiusi'));
    expect(await names()).toEqual(['Da testare', 'Attivo', 'Chiuso']);
    await user.type(screen.getByPlaceholderText('Filtra i progetti'), 'attivo');
    expect(await names()).toEqual(['Attivo']);
  });

  it('shows the first-project invitation when there are no projects', async () => {
    server.use(
      http.get('/api/projects', () => HttpResponse.json([])),
      http.get('/api/proposals', () => HttpResponse.json([])),
    );
    renderApp(<DashboardPage tab="projects" />);
    expect(await screen.findByText('Nessun progetto, per ora')).toBeTruthy();
  });

  it('shows a fixed text and Retry when the server does not answer', async () => {
    server.use(
      http.get('/api/projects', () => HttpResponse.error()),
      http.get('/api/proposals', () => HttpResponse.json([])),
    );
    renderApp(<DashboardPage tab="projects" />);
    expect(await screen.findByText(/Il server non risponde/)).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Riprova' })).toBeTruthy();
  });
});

describe('pathGroups', () => {
  it('has one group per phase and marks only the next task as "here"', () => {
    const g = pathGroups(roadmap(), 2);
    expect(g.map((x) => [x.id, x.tasks.map((t) => [t.id, t.here])])).toEqual([
      [
        10,
        [
          [1, false],
          [2, true],
        ],
      ],
      [20, [[3, false]]],
    ]);
  });
});
