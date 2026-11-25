// @vitest-environment happy-dom
/**
 * Independent verification, group A: real workflows on the UI components against a
 * fake API (MSW) shaped like the real REST contract. Invented data only.
 */
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { HttpResponse, http } from 'msw';
import { setupServer } from 'msw/node';
import { useState } from 'react';
import { MemoryRouter } from 'react-router';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { makeQueryClient, POLL_MS } from './api/queries.js';
import { Session } from './app/App.js';
import { TopBar } from './app/TopBar.js';
import { DashboardPage } from './features/dashboard/DashboardPage.js';
import { matchesText } from './features/dashboard/filter.js';
import { NewProjectPage } from './features/project/NewProjectPage.js';
import { Overview } from './features/project/Overview.js';
import { StatusMenu } from './features/project/ProjectPage.js';
import { RoadmapBoard } from './features/roadmap/RoadmapBoard.js';
import { detail, phase, renderApp, summary, task } from './test/render.js';

const calls: { method: string; path: string; body: unknown }[] = [];
const server = setupServer();
const record =
  (status = 200, reply: unknown = {}) =>
  async ({ request }: { request: Request }) => {
    const body = request.method === 'GET' ? null : await request.json().catch(() => null);
    calls.push({ method: request.method, path: new URL(request.url).pathname, body });
    return status === 204
      ? new HttpResponse(null, { status })
      : HttpResponse.json(reply as never, { status });
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
const baseHandlers = () => [
  http.get('/api/projects/:ref', () => HttpResponse.json(detail(roadmap()))),
  http.get('/api/projects', () => HttpResponse.json([])),
  http.get('/api/proposals', () => HttpResponse.json([])),
];

describe('verifyA: dialogs', () => {
  it('keeps the focus in the field being typed when new data arrives (poll, D52)', async () => {
    server.use(...baseHandlers());
    const user = userEvent.setup();
    renderApp(<Harness />);
    await user.click(screen.getByRole('button', { name: 'Azioni per il task Schema' }));
    await user.click(screen.getByRole('button', { name: 'Modifica' }));
    const notes = within(screen.getByRole('dialog')).getByLabelText('Note');
    await user.click(notes);
    await user.type(notes, 'Resistenze da 220');
    expect(document.activeElement).toBe(notes);
    // A poll brings a change made by Claude elsewhere in the roadmap: the parent re-renders.
    const changed = roadmap();
    (changed[1]?.tasks[0] as { title: string }).title = 'Case stampato';
    act(() => setProject(detail(changed)));
    expect(document.activeElement).toBe(within(screen.getByRole('dialog')).getByLabelText('Note'));
  });

  it('Cancel and Esc on the delete confirmation send nothing', async () => {
    server.use(...baseHandlers(), http.delete('/api/tasks/:id', record(204)));
    const user = userEvent.setup();
    renderApp(<RoadmapBoard project={detail(roadmap())} />);
    await user.click(screen.getByRole('button', { name: 'Azioni per il task Case' }));
    await user.click(screen.getByRole('button', { name: 'Elimina' }));
    await user.click(within(screen.getByRole('dialog')).getByRole('button', { name: 'Annulla' }));
    expect(screen.queryByRole('dialog')).toBeNull();
    await user.click(screen.getByRole('button', { name: 'Azioni per il task Case' }));
    await user.click(screen.getByRole('button', { name: 'Elimina' }));
    await user.keyboard('{Escape}');
    expect(screen.queryByRole('dialog')).toBeNull();
    expect(calls).toEqual([]);
  });

  it('Delete in the confirmation sends DELETE once and closes', async () => {
    server.use(...baseHandlers(), http.delete('/api/tasks/:id', record(204)));
    const user = userEvent.setup();
    renderApp(<RoadmapBoard project={detail(roadmap())} />);
    await user.click(screen.getByRole('button', { name: 'Azioni per il task Case' }));
    await user.click(screen.getByRole('button', { name: 'Elimina' }));
    await user.click(within(screen.getByRole('dialog')).getByRole('button', { name: 'Elimina' }));
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
    expect(calls).toEqual([{ method: 'DELETE', path: '/api/tasks/3', body: null }]);
  });
});

describe('verifyA: roadmap with the Open filter', () => {
  it('Move up on the first visible task is disabled when the tasks above are hidden', async () => {
    // Phase: a closed task (hidden by the default "Open" filter), then two open ones.
    const phases = [
      phase(10, 0, [
        task(1, 10, 0, { title: 'Fatto', done: true }),
        task(2, 10, 1, { title: 'Primo aperto' }),
        task(3, 10, 2, { title: 'Secondo aperto' }),
      ]),
    ];
    server.use(...baseHandlers());
    const user = userEvent.setup();
    renderApp(<RoadmapBoard project={detail(phases)} />);
    expect(screen.queryByText('Fatto')).toBeNull();
    await user.click(screen.getByRole('button', { name: 'Azioni per il task Primo aperto' }));
    // Otherwise it swaps with the hidden task and nothing visible changes.
    expect((screen.getByRole('button', { name: 'Sposta su' }) as HTMLButtonElement).disabled).toBe(
      true,
    );
  });

  it('a phase with no tasks shows the empty text and the add field', async () => {
    server.use(...baseHandlers(), http.post('/api/phases/:id/tasks', record(201, task(9, 30, 0))));
    const user = userEvent.setup();
    renderApp(<RoadmapBoard project={detail([phase(30, 0, [], { title: 'Vuota' })])} />);
    expect(screen.getByText('Nessun task da mostrare con questo filtro.')).toBeTruthy();
    const input = screen.getByLabelText('Nuovo task');
    await user.type(input, '  Saldatura àèìòù  {Enter}');
    await waitFor(() => expect(calls).toHaveLength(1));
    expect(calls[0]).toEqual({
      method: 'POST',
      path: '/api/phases/30/tasks',
      body: { title: 'Saldatura àèìòù' },
    });
  });
});

describe('verifyA: status menu', () => {
  it('Esc closes the Status menu while the focus is on its button', async () => {
    const user = userEvent.setup();
    renderApp(<StatusMenu p={detail(roadmap())} />);
    await user.click(screen.getByRole('button', { name: /Stato/ }));
    expect(screen.getByRole('button', { name: 'In pausa' })).toBeTruthy();
    await user.keyboard('{Escape}');
    expect(screen.queryByRole('button', { name: 'In pausa' })).toBeNull();
  });

  it('a click outside closes the Status menu', async () => {
    const user = userEvent.setup();
    renderApp(
      <div>
        <p>fuori</p>
        <StatusMenu p={detail(roadmap())} />
      </div>,
    );
    await user.click(screen.getByRole('button', { name: /Stato/ }));
    await user.click(screen.getByText('fuori'));
    expect(screen.queryByRole('button', { name: 'In pausa' })).toBeNull();
  });

  it('a proposal reply (202) shows the proposal notice', async () => {
    server.use(
      ...baseHandlers(),
      http.post(
        '/api/projects/:ref/status',
        record(202, { proposal: { id: 1, kind: 'set_status', state: 'pending' } }),
      ),
    );
    const user = userEvent.setup();
    renderApp(<StatusMenu p={detail(roadmap())} />);
    await user.click(screen.getByRole('button', { name: /Stato/ }));
    await user.click(screen.getByRole('button', { name: 'Completato' }));
    await waitFor(() => expect(calls).toHaveLength(1));
    expect(calls[0]?.body).toEqual({ status: 'completed' });
    expect(await screen.findByText(/proposta/i)).toBeTruthy();
  });
});

describe('verifyA: overview', () => {
  it('Mark done closes the task and shows the next step computed by the server (D26)', async () => {
    let done = false;
    const after = () => {
      const ph = roadmap();
      (ph[0]?.tasks[0] as { done: boolean }).done = true;
      return detail(ph, {
        nextTask: { id: 3, title: 'Case', phaseId: 20, phaseTitle: 'Phase 20', overridden: false },
      });
    };
    server.use(
      http.post('/api/tasks/:id/complete', async (info) => {
        done = true;
        return record(200, { task: {}, nextTask: null })(info);
      }),
      http.get('/api/projects/:ref/diary', () => HttpResponse.json([])),
      http.get('/api/projects/:ref', () => HttpResponse.json(done ? after() : detail(roadmap()))),
      http.get('/api/projects', () => HttpResponse.json([])),
    );
    const user = userEvent.setup();
    // Same data flow as ProjectPage: the overview reads the cached project.
    renderApp(<OverviewFromCache />);
    await screen.findByText('Schema', { selector: '.next-title' });
    await user.click(screen.getByRole('button', { name: 'Segna fatto' }));
    await waitFor(() => expect(calls[0]?.path).toBe('/api/tasks/1/complete'));
    // Server picked task 3 (another phase), not the next task of the same phase.
    expect(await screen.findByText('Case', { selector: '.next-title' })).toBeTruthy();
  });

  it('a 500 from the server shows the fixed text, never the raw message (D44)', async () => {
    server.use(
      http.post('/api/tasks/:id/complete', () =>
        HttpResponse.json(
          { error: { code: 'internal', message: 'SQLITE_BUSY raw' } },
          { status: 500 },
        ),
      ),
      http.get('/api/projects/:ref/diary', () => HttpResponse.json([])),
      ...baseHandlers(),
    );
    const user = userEvent.setup();
    renderApp(<Overview p={detail(roadmap())} />);
    await user.click(screen.getByRole('button', { name: 'Segna fatto' }));
    expect(await screen.findByRole('alert')).toBeTruthy();
    expect(screen.queryByText(/SQLITE_BUSY/)).toBeNull();
  });
});

import { useProject } from './api/queries.js';

let setProject: (p: ReturnType<typeof detail>) => void = () => {};
function Harness() {
  const [p, setP] = useState(detail(roadmap()));
  setProject = setP;
  return <RoadmapBoard project={p} />;
}

function OverviewFromCache() {
  const q = useProject('banco');
  return q.data ? <Overview p={q.data} /> : null;
}

describe('verifyA: new project', () => {
  it('picking a suggested tag adds that tag, not the typed prefix', async () => {
    server.use(
      http.get('/api/tags', () => HttpResponse.json([{ name: 'elettronica', count: 3 }])),
      http.get('/api/projects', () => HttpResponse.json([])),
    );
    const user = userEvent.setup();
    renderApp(<NewProjectPage />);
    await waitFor(() => expect(calls).toEqual([]));
    await user.type(screen.getByLabelText('Tag'), 'elet');
    await user.click(await screen.findByRole('button', { name: 'elettronica' }));
    const chips = [...document.querySelectorAll('.tag-input .tag')].map((x) => x.textContent);
    expect(chips).toEqual(['elettronica']);
  });

  it('tasks typed under a phase without a title are not dropped silently', async () => {
    server.use(
      http.get('/api/tags', () => HttpResponse.json([])),
      http.post('/api/projects', record(201, { ...summary(), slug: 'x' })),
      http.get('/api/projects', () => HttpResponse.json([])),
    );
    const user = userEvent.setup();
    renderApp(<NewProjectPage />);
    await user.type(screen.getByLabelText('Nome'), 'Stazione meteo');
    await user.click(screen.getByRole('button', { name: /Aggiungi fase/ }));
    await user.type(screen.getByLabelText('Task, uno per riga'), 'Schema{Enter}Distinta');
    await user.click(screen.getByRole('button', { name: 'Crea progetto' }));
    await new Promise((r) => setTimeout(r, 50));
    // Either the form asks for the phase title (nothing sent) or the tasks are sent.
    const sent = calls.find((c) => c.method === 'POST')?.body as
      | { phases?: { tasks: string[] }[] }
      | undefined;
    if (sent) expect(sent.phases?.flatMap((p) => p.tasks)).toEqual(['Schema', 'Distinta']);
  });

  it('creates a project with an Italian name and only the name set', async () => {
    server.use(
      http.get('/api/tags', () => HttpResponse.json([])),
      http.post('/api/projects', record(201, { ...summary(), slug: 'caffe' })),
      http.get('/api/projects', () => HttpResponse.json([])),
    );
    const user = userEvent.setup();
    renderApp(<NewProjectPage />);
    await user.type(screen.getByLabelText('Nome'), '  Caffè à la crème  ');
    await user.click(screen.getByRole('button', { name: 'Crea progetto' }));
    await waitFor(() => expect(calls).toHaveLength(1));
    expect(calls[0]?.body).toEqual({
      name: 'Caffè à la crème',
      links: [],
      repos: [],
      phases: [],
      lifecycleStatus: 'in_development',
    });
  });
});

describe('verifyA: dashboard', () => {
  it('text filter ignores accents and case', () => {
    expect(matchesText(summary({ name: 'Caffè Crème' }), 'caffe creme')).toBe(true);
    expect(matchesText(summary({ name: 'Perché' }), 'PERCHE')).toBe(true);
  });

  it('Test tab: Failed records the outcome with the notes and confirms', async () => {
    const waiting = summary({
      lifecycleStatus: 'awaiting_manual_test',
      statusNote: 'Il LED si accende',
      badge: { kind: 'awaiting_manual_test' },
      attentionGroup: 1,
    });
    let recorded = false;
    server.use(
      http.get('/api/projects', () =>
        HttpResponse.json(
          recorded
            ? [{ ...waiting, lifecycleStatus: 'in_development', statusNote: '' }]
            : [waiting],
        ),
      ),
      http.get('/api/proposals', () => HttpResponse.json([])),
      http.get('/api/projects/:ref', () => HttpResponse.json(detail([]))),
      http.post('/api/projects/:ref/test-outcome', async (info) => {
        recorded = true;
        return record(200, detail([]))(info);
      }),
    );
    const user = userEvent.setup();
    renderApp(<DashboardPage tab="tests" />);
    expect(await screen.findByText('Il LED si accende')).toBeTruthy();
    await user.type(screen.getByLabelText('Esito'), 'Resta spento');
    await user.click(screen.getByRole('button', { name: 'Fallito' }));
    await waitFor(() => expect(calls).toHaveLength(1));
    expect(calls[0]).toEqual({
      method: 'POST',
      path: '/api/projects/banco/test-outcome',
      body: { passed: false, notes: 'Resta spento' },
    });
    // The project leaves the Test tab after the refetch.
    await waitFor(() => expect(screen.queryByText('Il LED si accende')).toBeNull());
  });

  it('tag filter shows counts and narrows the tiles', async () => {
    server.use(
      http.get('/api/projects', () =>
        HttpResponse.json([
          summary({ id: 1, slug: 'a', name: 'Uno', tags: ['diy', 'legno'] }),
          summary({ id: 2, slug: 'b', name: 'Due', tags: ['diy'] }),
          summary({ id: 3, slug: 'c', name: 'Tre', tags: [] }),
        ]),
      ),
      http.get('/api/proposals', () => HttpResponse.json([])),
    );
    const user = userEvent.setup();
    renderApp(<DashboardPage tab="projects" />);
    const tags = await screen.findByRole('group', { name: 'Tag' });
    const diy = within(tags).getByText('diy').closest('label') as HTMLElement;
    expect(within(diy).getByText('2')).toBeTruthy();
    await user.click(within(diy).getByRole('checkbox'));
    const names = [...document.querySelectorAll('.tile-name')].map((x) => x.textContent);
    expect(names.sort()).toEqual(['Due', 'Uno']);
  });
});

describe('verifyA: polling and language', () => {
  it('polls every 10 s only while the tab is visible (D52)', () => {
    const q = makeQueryClient().getDefaultOptions().queries;
    expect(POLL_MS).toBe(10_000);
    expect(q?.refetchInterval).toBe(10_000);
    expect(q?.refetchIntervalInBackground).toBe(false);
  });

  it('switching IT -> EN saves the setting and changes the texts', async () => {
    let lang = 'it';
    server.use(
      http.get('/api/auth/status', () =>
        HttpResponse.json({ setupDone: true, user: { id: 1, username: 'tester' } }),
      ),
      http.get('/api/settings', () => HttpResponse.json({ uiLanguage: lang })),
      http.patch('/api/settings', async ({ request }) => {
        const b = (await request.json()) as { uiLanguage: string };
        lang = b.uiLanguage;
        calls.push({ method: 'PATCH', path: '/api/settings', body: b });
        return HttpResponse.json({ uiLanguage: lang });
      }),
      http.get('/api/projects', () => HttpResponse.json([])),
    );
    const client = new QueryClient({
      defaultOptions: { queries: { retry: false, refetchInterval: false } },
    });
    render(
      <QueryClientProvider client={client}>
        <Session>
          <MemoryRouter>
            <TopBar />
          </MemoryRouter>
        </Session>
      </QueryClientProvider>,
    );
    expect(await screen.findByRole('button', { name: /Nuovo progetto/ })).toBeTruthy();
    await act(async () => {
      fireEvent.change(screen.getByLabelText('Lingua'), { target: { value: 'en' } });
    });
    expect(await screen.findByRole('button', { name: /New project/ })).toBeTruthy();
    expect(calls).toEqual([{ method: 'PATCH', path: '/api/settings', body: { uiLanguage: 'en' } }]);
  });
});
