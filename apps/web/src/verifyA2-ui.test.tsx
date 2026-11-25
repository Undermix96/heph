// @vitest-environment happy-dom
/**
 * Independent verification, group A round 2: dialogs, menus, Move up / down under a
 * filter, New project tags and phases, breadcrumb and Cancel. Fake API (MSW), invented
 * data only.
 */
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { act, cleanup, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { HttpResponse, http } from 'msw';
import { setupServer } from 'msw/node';
import { useState } from 'react';
import { createMemoryRouter, RouterProvider } from 'react-router';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { routes } from './app/App.js';
import { NoticesProvider } from './app/notices.js';
import { NewProjectPage } from './features/project/NewProjectPage.js';
import { StatusMenu } from './features/project/ProjectPage.js';
import { RoadmapBoard } from './features/roadmap/RoadmapBoard.js';
import { I18nProvider } from './i18n/index.js';
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
const base = () => [
  http.get('/api/projects/:ref', () => HttpResponse.json(detail(roadmap()))),
  http.get('/api/projects', () => HttpResponse.json([])),
  http.get('/api/proposals', () => HttpResponse.json([])),
  http.get('/api/tags', () => HttpResponse.json([])),
];

let setProject: (p: ReturnType<typeof detail>) => void = () => {};
function Harness({ initial = detail(roadmap()) }: { initial?: ReturnType<typeof detail> }) {
  const [p, setP] = useState(initial);
  setProject = setP;
  return <RoadmapBoard project={p} />;
}
const menuOf = (title: string) =>
  screen.getByRole('button', { name: `Azioni per il task ${title}` });
const item = (name: string) => screen.getByRole('button', { name }) as HTMLButtonElement;

describe('verifyA2: dialogs', () => {
  it('Tab and Shift+Tab stay inside the edit dialog; focus survives a poll; Esc returns focus to the trigger', async () => {
    server.use(...base());
    const user = userEvent.setup();
    renderApp(<Harness />);
    await user.click(menuOf('Schema'));
    await user.click(item('Modifica'));
    const dialog = screen.getByRole('dialog');
    const inside = () => dialog.contains(document.activeElement);
    expect(inside()).toBe(true);
    for (let i = 0; i < 8; i++) {
      await user.tab();
      expect(inside()).toBe(true);
    }
    for (let i = 0; i < 8; i++) {
      await user.tab({ shift: true });
      expect(inside()).toBe(true);
    }
    const focused = document.activeElement;
    act(() => setProject(detail(roadmap())));
    expect(document.activeElement).toBe(focused);
    await user.keyboard('{Escape}');
    expect(screen.queryByRole('dialog')).toBeNull();
    expect(document.activeElement).toBe(menuOf('Schema'));
  });

  it('the latest onClose is used after a re-render (Cancel closes the dialog)', async () => {
    server.use(...base());
    const user = userEvent.setup();
    renderApp(<Harness />);
    await user.click(menuOf('Case'));
    await user.click(item('Elimina'));
    act(() => setProject(detail(roadmap())));
    await user.keyboard('{Escape}');
    expect(screen.queryByRole('dialog')).toBeNull();
  });

  it('the Status note dialog returns the focus to the Status button on Esc', async () => {
    server.use(...base());
    const user = userEvent.setup();
    renderApp(<StatusMenu p={detail(roadmap())} />);
    const trigger = screen.getByRole('button', { name: /Stato/ });
    await user.click(trigger);
    await user.click(item('In pausa'));
    expect(screen.getByRole('dialog')).toBeTruthy();
    await user.keyboard('{Escape}');
    expect(screen.queryByRole('dialog')).toBeNull();
    expect(document.activeElement).toBe(trigger);
  });
});

describe('verifyA2: Move up / down under a filter', () => {
  // Phase: open A, closed B, open C, closed D, open E (positions 0..4).
  const mixed = () =>
    detail([
      phase(10, 0, [
        task(1, 10, 0, { title: 'A' }),
        task(2, 10, 1, { title: 'B', done: true }),
        task(3, 10, 2, { title: 'C' }),
        task(4, 10, 3, { title: 'D', done: true }),
        task(5, 10, 4, { title: 'E' }),
      ]),
    ]);

  it('Open filter: Move up on C goes to the position of A (0), Move down to E (4)', async () => {
    server.use(...base(), http.post('/api/tasks/:id/move', record(200, [])));
    const user = userEvent.setup();
    renderApp(<Harness initial={mixed()} />);
    await user.click(menuOf('C'));
    await user.click(item('Sposta su'));
    await waitFor(() => expect(calls).toHaveLength(1));
    expect(calls[0]).toMatchObject({ path: '/api/tasks/3/move', body: { position: 0 } });
    act(() => setProject(mixed()));
    await user.click(menuOf('C'));
    await user.click(item('Sposta giù'));
    await waitFor(() => expect(calls).toHaveLength(2));
    expect(calls[1]).toMatchObject({ path: '/api/tasks/3/move', body: { position: 4 } });
  });

  it('Open filter: A has no Move up, E has no Move down', async () => {
    server.use(...base());
    const user = userEvent.setup();
    renderApp(<Harness initial={mixed()} />);
    await user.click(menuOf('A'));
    expect(item('Sposta su').disabled).toBe(true);
    expect(item('Sposta giù').disabled).toBe(false);
    await user.keyboard('{Escape}');
    await user.click(menuOf('E'));
    expect(item('Sposta giù').disabled).toBe(true);
  });

  it('Closed filter: B and D swap through their positions; B up and D down disabled', async () => {
    server.use(...base(), http.post('/api/tasks/:id/move', record(200, [])));
    const user = userEvent.setup();
    renderApp(<Harness initial={mixed()} />);
    await user.click(screen.getByRole('button', { name: 'Chiusi' }));
    await user.click(menuOf('B'));
    expect(item('Sposta su').disabled).toBe(true);
    await user.click(item('Sposta giù'));
    await waitFor(() => expect(calls).toHaveLength(1));
    expect(calls[0]).toMatchObject({ path: '/api/tasks/2/move', body: { position: 3 } });
    act(() => setProject(mixed()));
    await user.click(menuOf('D'));
    expect(item('Sposta giù').disabled).toBe(true);
  });

  it('All filter: Move down on A goes to 1', async () => {
    server.use(...base(), http.post('/api/tasks/:id/move', record(200, [])));
    const user = userEvent.setup();
    renderApp(<Harness initial={mixed()} />);
    await user.click(screen.getByRole('button', { name: 'Tutti' }));
    await user.click(menuOf('A'));
    await user.click(item('Sposta giù'));
    await waitFor(() => expect(calls).toHaveLength(1));
    expect(calls[0]).toMatchObject({ path: '/api/tasks/1/move', body: { position: 1 } });
  });
});

describe('verifyA2: menus', () => {
  it('the task ⋯ menu closes on Esc with focus back on its trigger, and on a click outside', async () => {
    server.use(...base());
    const user = userEvent.setup();
    renderApp(<Harness />);
    await user.click(menuOf('Schema'));
    await user.tab();
    await user.keyboard('{Escape}');
    expect(screen.queryByRole('button', { name: 'Sposta su' })).toBeNull();
    expect(document.activeElement).toBe(menuOf('Schema'));
    await user.click(menuOf('Schema'));
    await user.click(screen.getByText('Case'));
    expect(screen.queryByRole('button', { name: 'Sposta su' })).toBeNull();
  });

  it('Esc on the Status menu returns the focus to its button', async () => {
    const user = userEvent.setup();
    renderApp(<StatusMenu p={detail(roadmap())} />);
    const trigger = screen.getByRole('button', { name: /Stato/ });
    await user.click(trigger);
    await user.tab();
    await user.keyboard('{Escape}');
    expect(screen.queryByRole('button', { name: 'In pausa' })).toBeNull();
    expect(document.activeElement).toBe(trigger);
  });
});

describe('verifyA2: new project', () => {
  const tagsHandlers = () => [
    http.get('/api/tags', () => HttpResponse.json([{ name: 'elettronica', count: 3 }])),
    http.get('/api/projects', () => HttpResponse.json([])),
  ];
  const chips = () => [...document.querySelectorAll('.tag-input .tag')].map((x) => x.textContent);

  it('keyboard: Tab to a suggestion and Enter adds that tag only', async () => {
    server.use(...tagsHandlers());
    const user = userEvent.setup();
    renderApp(<NewProjectPage />);
    await user.type(screen.getByLabelText('Tag'), 'elet');
    await screen.findByRole('button', { name: 'elettronica' });
    await user.tab();
    expect(document.activeElement?.textContent).toBe('elettronica');
    await user.keyboard('{Enter}');
    expect(chips()).toEqual(['elettronica']);
  });

  it('a typed tag is added when the field is left by clicking elsewhere', async () => {
    server.use(...tagsHandlers());
    const user = userEvent.setup();
    renderApp(<NewProjectPage />);
    await user.type(screen.getByLabelText('Tag'), 'legno');
    await user.click(screen.getByLabelText('Nome'));
    expect(chips()).toEqual(['legno']);
  });

  it('a typed new tag is added when the field is left with Tab (keyboard only)', async () => {
    server.use(...tagsHandlers());
    const user = userEvent.setup();
    renderApp(<NewProjectPage />);
    await user.type(screen.getByLabelText('Tag'), 'legno');
    // Leave the field with the keyboard and keep going through the form.
    await user.tab();
    await user.tab();
    await user.tab();
    expect(chips()).toEqual(['legno']);
  });

  it('a typed tag left in the field with Tab is sent on Create', async () => {
    server.use(
      ...tagsHandlers(),
      http.post('/api/projects', record(201, { ...summary(), slug: 'x' })),
    );
    const user = userEvent.setup();
    renderApp(<NewProjectPage />);
    await user.type(screen.getByLabelText('Nome'), 'Mensola');
    await user.type(screen.getByLabelText('Tag'), 'legno');
    await user.tab();
    await user.tab();
    await user.click(screen.getByRole('button', { name: 'Crea progetto' }));
    await waitFor(() => expect(calls.filter((c) => c.method === 'POST')).toHaveLength(1));
    const sent = calls.find((c) => c.method === 'POST')?.body as { tags?: string[] } | undefined;
    expect(sent?.tags).toEqual(['legno']);
  });

  it('tasks under an untitled phase show a message and send nothing', async () => {
    server.use(...base(), http.post('/api/projects', record(201, { ...summary(), slug: 'x' })));
    const user = userEvent.setup();
    renderApp(<NewProjectPage />);
    await user.type(screen.getByLabelText('Nome'), 'Stazione meteo');
    await user.click(screen.getByRole('button', { name: /Aggiungi fase/ }));
    await user.type(screen.getByLabelText('Task, uno per riga'), 'Schema');
    await user.click(screen.getByRole('button', { name: 'Crea progetto' }));
    expect(await screen.findByText(/Dai un titolo alla fase/)).toBeTruthy();
    await new Promise((r) => setTimeout(r, 50));
    expect(calls.filter((c) => c.method === 'POST')).toEqual([]);
  });

  it('an empty untitled phase (no tasks) does not block the submit', async () => {
    server.use(...base(), http.post('/api/projects', record(201, { ...summary(), slug: 'x' })));
    const user = userEvent.setup();
    renderApp(<NewProjectPage />);
    await user.type(screen.getByLabelText('Nome'), 'Stazione meteo');
    await user.click(screen.getByRole('button', { name: /Aggiungi fase/ }));
    await user.click(screen.getByRole('button', { name: 'Crea progetto' }));
    await waitFor(() => expect(calls.filter((c) => c.method === 'POST')).toHaveLength(1));
  });
});

describe('verifyA2: breadcrumb and Cancel', () => {
  function renderRoutes(path: string) {
    const client = new QueryClient({
      defaultOptions: { queries: { retry: false, refetchInterval: false } },
    });
    const router = createMemoryRouter(routes, { initialEntries: [path] });
    render(
      <QueryClientProvider client={client}>
        <I18nProvider lang="it">
          <NoticesProvider>
            <RouterProvider router={router} />
          </NoticesProvider>
        </I18nProvider>
      </QueryClientProvider>,
    );
    return router;
  }

  it('shows the project name in the breadcrumb once the project is loaded', async () => {
    server.use(
      ...base(),
      http.get('/api/projects/:ref/diary', () => HttpResponse.json([])),
    );
    renderRoutes('/p/banco');
    const nav = await screen.findByRole('navigation', { name: 'Percorso' });
    await waitFor(() => expect(within(nav).getByText('Banco da lavoro')).toBeTruthy());
    expect(within(nav).queryByText('banco')).toBeNull();
  });

  it('Cancel on New project goes to the dashboard even when opened directly', async () => {
    server.use(...base());
    const user = userEvent.setup();
    const router = renderRoutes('/new');
    await user.click(await screen.findByRole('button', { name: 'Annulla' }));
    await waitFor(() => expect(router.state.location.pathname).toBe('/'));
  });
});
