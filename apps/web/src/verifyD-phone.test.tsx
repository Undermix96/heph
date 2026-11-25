// @vitest-environment happy-dom
// Independent verification of the phone layout (mockups 60-62, design §8). Invented data.
import type { ProjectDetail, ProposalView } from '@heph/schema';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { act, cleanup, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { HttpResponse, http } from 'msw';
import { setupServer } from 'msw/node';
import { createMemoryRouter, RouterProvider } from 'react-router';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { routes } from './app/App.js';
import { NoticesProvider } from './app/notices.js';
import { TopBar } from './app/TopBar.js';
import { MobileDashboard } from './features/dashboard/MobileDashboard.js';
import { DiaryView } from './features/diary/DiaryView.js';
import { Overview } from './features/project/Overview.js';
import { en } from './i18n/en.js';
import { I18nProvider } from './i18n/index.js';
import { it as itMsgs } from './i18n/it.js';
import { detail, phase, renderApp, summary, task } from './test/render.js';

// ---------------------------------------------------------------- viewport fake
let width = 390;
const listeners = new Set<() => void>();
function evalQuery(q: string): boolean {
  const max = /max-width:\s*(\d+)px/.exec(q);
  const min = /min-width:\s*(\d+)px/.exec(q);
  if (max && width > Number(max[1])) return false;
  if (min && width < Number(min[1])) return false;
  return true;
}
function setWidth(w: number) {
  width = w;
  for (const l of listeners) l();
}
beforeEach(() => {
  width = 390;
  window.matchMedia = ((q: string) => ({
    media: q,
    get matches() {
      return evalQuery(q);
    },
    addEventListener: (_: string, cb: () => void) => listeners.add(cb),
    removeEventListener: (_: string, cb: () => void) => listeners.delete(cb),
    addListener: () => {},
    removeListener: () => {},
    onchange: null,
    dispatchEvent: () => false,
  })) as unknown as typeof window.matchMedia;
});

// ---------------------------------------------------------------- server
type Call = { method: string; path: string; body: unknown };
const calls: Call[] = [];
const log = async (request: Request) => {
  const u = new URL(request.url);
  let body: unknown = null;
  try {
    body = await request.clone().json();
  } catch {}
  calls.push({ method: request.method, path: u.pathname, body });
};
const server = setupServer();
beforeAll(() => server.listen());
afterEach(() => {
  cleanup();
  server.resetHandlers();
  calls.length = 0;
  listeners.clear();
});
afterAll(() => server.close());

const proposal = (over: Partial<ProposalView> = {}): ProposalView =>
  ({
    id: 7,
    projectId: 1,
    kind: 'delete_task',
    payload: { taskId: 3, title: 'Vecchio cablaggio' },
    state: 'pending',
    note: null,
    createdAt: '2026-11-25T08:00:00.000Z',
    decidedAt: null,
    sessionId: null,
    ...over,
  }) as unknown as ProposalView;

// ---------------------------------------------------------------- dashboard
describe('verifyD: phone dashboard actions', () => {
  it('Superato on a pending test posts the outcome and refetches the project list', async () => {
    const p = summary({ lifecycleStatus: 'awaiting_manual_test', statusNote: 'Prova il pedale' });
    server.use(
      http.get('/api/projects', () => HttpResponse.json([p])),
      http.get('/api/proposals', () => HttpResponse.json([])),
      http.post('/api/projects/:ref/test-outcome', async ({ request }) => {
        await log(request);
        return HttpResponse.json(detail([]));
      }),
    );
    const user = userEvent.setup();
    const { client } = renderApp(<MobileDashboard projects={[p]} />);
    client.setQueryData(['projects'], [p]);
    await user.click(await screen.findByRole('button', { name: 'Superato' }));
    await waitFor(() => expect(calls).toHaveLength(1));
    expect(calls[0]).toMatchObject({
      path: '/api/projects/banco/test-outcome',
      body: { passed: true },
    });
    await waitFor(() => expect(client.getQueryState(['projects'])?.isInvalidated).toBe(true));
  });

  it('Rifiuta on a proposal posts the rejection and refetches the pending proposals', async () => {
    let proposalFetches = 0;
    server.use(
      http.get('/api/proposals', () => {
        proposalFetches++;
        return HttpResponse.json(proposalFetches === 1 ? [proposal()] : []);
      }),
      http.post('/api/proposals/:id/reject', async ({ request }) => {
        await log(request);
        return HttpResponse.json(proposal({ state: 'rejected' } as Partial<ProposalView>));
      }),
    );
    const user = userEvent.setup();
    renderApp(<MobileDashboard projects={[summary()]} />);
    expect(await screen.findByText(/Vecchio cablaggio/)).toBeTruthy();
    await user.click(screen.getByRole('button', { name: 'Rifiuta' }));
    await waitFor(() => expect(calls.map((c) => c.path)).toEqual(['/api/proposals/7/reject']));
    await waitFor(() => expect(screen.queryByText(/Vecchio cablaggio/)).toBeNull());
  });

  it('a stuck project offers Scegli passo that opens the project', async () => {
    server.use(http.get('/api/proposals', () => HttpResponse.json([])));
    renderApp(
      <MobileDashboard
        projects={[summary({ badge: { kind: 'no_next_step' } as never, nextTask: null })]}
      />,
    );
    const section = (await screen.findByRole('heading', { name: 'Richiede attenzione' })).closest(
      'section',
    ) as HTMLElement;
    const pick = within(section).getByRole('link', { name: /Scegli/ });
    expect(pick.getAttribute('href')).toBe('/p/banco');
  });

  it('Claude at work with one project uses a singular sentence', async () => {
    server.use(http.get('/api/proposals', () => HttpResponse.json([])));
    renderApp(<MobileDashboard projects={[summary({ activityState: 'claude_working' })]} />);
    const title = await screen.findByRole('heading', { name: /Claude al lavoro/ });
    // "su 1 progetti" is ungrammatical.
    expect(title.textContent).not.toMatch(/\b1 progetti\b/);
  });

  it('a very long project name stays inside its row (wraps, no fixed width)', async () => {
    server.use(http.get('/api/proposals', () => HttpResponse.json([])));
    const long = 'Saldatrice a punti con controllo a microcontrollore e pedale '.repeat(3);
    renderApp(<MobileDashboard projects={[summary({ name: long })]} />);
    const link = await screen.findByRole('link', { name: long.trim() });
    expect(link.className).toContain('m-name');
  });
});

// ---------------------------------------------------------------- overview
const roadmap = () => [
  phase(10, 0, [
    task(1, 10, 0, { title: 'Schema', done: true }),
    task(2, 10, 1, { title: 'Case' }),
  ]),
  phase(20, 1, [task(3, 20, 0, { title: 'Collaudo' })]),
];
const project = (over: Partial<ProjectDetail> = {}) =>
  detail(roadmap(), {
    currentPhase: { id: 10, title: 'Phase 10', position: 0 } as never,
    progress: { done: 1, total: 3, ratio: 1 / 3 },
    ...over,
  });

describe('verifyD: phone overview', () => {
  beforeEach(() => {
    server.use(
      http.post('/api/tasks/:id/complete', async ({ request }) => {
        await log(request);
        return HttpResponse.json({});
      }),
      http.post('/api/tasks/:id/reopen', async ({ request }) => {
        await log(request);
        return HttpResponse.json({});
      }),
      http.post('/api/projects/:ref/test-outcome', async ({ request }) => {
        await log(request);
        return HttpResponse.json(project());
      }),
      http.get('/api/projects/:ref/diary', () => HttpResponse.json([])),
    );
  });

  it('checkboxes of the current phase complete an open task and reopen a done one', async () => {
    const user = userEvent.setup();
    renderApp(<Overview p={project()} />);
    const open = await screen.findByRole('checkbox', { name: /1\.2 Case/ });
    const done = screen.getByRole('checkbox', { name: /1\.1 Schema/ }) as HTMLInputElement;
    expect(done.checked).toBe(true);
    await user.click(open);
    await waitFor(() => expect(calls.map((c) => c.path)).toEqual(['/api/tasks/2/complete']));
    await waitFor(() => expect((open as HTMLInputElement).disabled).toBe(false));
    await user.click(done);
    await waitFor(() =>
      expect(calls.map((c) => c.path)).toEqual(['/api/tasks/2/complete', '/api/tasks/1/reopen']),
    );
  });

  it('the pending test sends the typed note with the outcome and clears it', async () => {
    const user = userEvent.setup();
    renderApp(
      <Overview
        p={project({ lifecycleStatus: 'awaiting_manual_test', statusNote: 'Prova il pedale' })}
      />,
    );
    const note = await screen.findByPlaceholderText('Nota sull’esito (facoltativa)');
    await user.type(note, '  Scintilla debole  ');
    await user.click(screen.getByRole('button', { name: 'Fallito' }));
    await waitFor(() => expect(calls).toHaveLength(1));
    expect(calls[0]).toMatchObject({
      path: '/api/projects/banco/test-outcome',
      body: { passed: false, notes: 'Scintilla debole' },
    });
    await waitFor(() => expect((note as HTMLTextAreaElement).value).toBe(''));
  });

  it('next step meta shows "phase · n.m"', async () => {
    renderApp(<Overview p={project()} />);
    expect(await screen.findByText(/· 1\.2/)).toBeTruthy();
  });

  it('the vertical path shows per-phase counts and "sei qui" on the next step phase', async () => {
    const { container } = renderApp(<Overview p={project()} />);
    await screen.findByText('Schema', { exact: false });
    const items = container.querySelectorAll('.m-path-item');
    expect(items).toHaveLength(2);
    expect(items[0]?.textContent).toContain('1/2');
    expect(items[0]?.textContent).toContain('sei qui');
    expect(items[1]?.textContent).toContain('0/1');
  });

  it('a project with zero phases renders without crashing', async () => {
    renderApp(
      <Overview
        p={detail([], { progress: { done: 0, total: 0, ratio: 0 }, currentPhase: null })}
      />,
    );
    expect(await screen.findByText('Percorso', { exact: false })).toBeTruthy();
  });

  it('switching 599 -> 600 px swaps the vertical path for the desktop path', async () => {
    const { container } = renderApp(<Overview p={project()} />);
    await screen.findByText('Schema', { exact: false });
    setWidth(599);
    expect(container.querySelectorAll('.m-path-item').length).toBe(2);
    act(() => setWidth(600));
    await waitFor(() => expect(container.querySelectorAll('.m-path-item').length).toBe(0));
    expect(container.querySelectorAll('.m-checks').length).toBe(0);
    act(() => setWidth(599));
    await waitFor(() => expect(container.querySelectorAll('.m-path-item').length).toBe(2));
  });
});

// ---------------------------------------------------------------- top bar and project page
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
  return { router, client };
}
const base = (p: ProjectDetail = project()) => [
  http.get('/api/projects/:ref', () => HttpResponse.json(p)),
  http.get('/api/projects', () => HttpResponse.json([summary()])),
  http.get('/api/proposals', () => HttpResponse.json([])),
  http.get('/api/tags', () => HttpResponse.json([])),
  http.get('/api/projects/:ref/diary/months', () =>
    HttpResponse.json([{ month: '2026-11', count: 4 }]),
  ),
  http.get('/api/projects/:ref/diary', () => HttpResponse.json([])),
  http.get('/api/settings', () => HttpResponse.json({ uiLanguage: 'it' })),
];

const menuItems = async (user: ReturnType<typeof userEvent.setup>) => {
  const bar = document.querySelector('header.topbar') as HTMLElement;
  await user.click(within(bar).getByRole('button', { name: 'Altre azioni' }));
  return Array.from(document.querySelectorAll('.menu-list button')).map((b) => b.textContent);
};

describe('verifyD: phone top bar and project header', () => {
  it('dashboard: logo, title, search, + and a menu without New project', async () => {
    server.use(...base());
    const user = userEvent.setup();
    renderApp(<TopBar />, { path: '/' });
    expect(screen.getByRole('heading', { name: 'Progetti' })).toBeTruthy();
    expect(screen.getByRole('link', { name: 'Nuovo progetto' })).toBeTruthy();
    expect(screen.queryByRole('link', { name: 'Indietro' })).toBeNull();
    const items = await menuItems(user);
    expect(items).not.toContain('Nuovo progetto');
    expect(items).toContain('Impostazioni');
  });

  it('settings: back, title Impostazioni, menu with New project', async () => {
    server.use(...base());
    const user = userEvent.setup();
    renderApp(<TopBar />, { path: '/settings' });
    expect(screen.getByRole('link', { name: 'Indietro' })).toBeTruthy();
    expect(screen.getByRole('heading', { name: 'Impostazioni' })).toBeTruthy();
    const items = await menuItems(user);
    expect(items).toContain('Nuovo progetto');
    expect(items).not.toContain('Modifica');
  });

  it('project: the menu has Edit and the title is the project name', async () => {
    server.use(...base());
    const user = userEvent.setup();
    const { router } = renderRoutes('/p/banco');
    const bar = await waitFor(() => document.querySelector('header.topbar') as HTMLElement);
    await waitFor(() =>
      expect(within(bar).getByRole('heading', { name: 'Banco da lavoro' })).toBeTruthy(),
    );
    const items = await menuItems(user);
    expect(items).toContain('Modifica');
    await user.click(screen.getByRole('button', { name: 'Modifica' }));
    await waitFor(() => expect(router.state.location.pathname).toBe('/p/banco/edit'));
  });

  it('project with no tags: compact header shows status and done/total · % only', async () => {
    server.use(...base(project({ tags: [] })));
    renderRoutes('/p/banco');
    const head = await waitFor(() => {
      const h = document.querySelector('.m-project-head');
      if (!h) throw new Error('no header');
      return h as HTMLElement;
    });
    expect(head.textContent).toContain('1/3 · 33%');
    expect(head.querySelectorAll('.meta')).toHaveLength(1);
  });

  it('the project status can still be changed on the phone (menu -> Modifica)', async () => {
    server.use(...base());
    const user = userEvent.setup();
    renderRoutes('/p/banco');
    await waitFor(() => expect(document.querySelector('.m-project-head')).toBeTruthy());
    await menuItems(user);
    await user.click(screen.getByRole('button', { name: 'Modifica' }));
    expect((await screen.findAllByRole('button', { name: /Stato/ })).length).toBeGreaterThan(0);
  });

  it('back from the edit page returns to the project, not the dashboard', async () => {
    server.use(...base());
    renderRoutes('/p/banco/edit');
    const back = await screen.findByRole('link', { name: 'Indietro' });
    expect(back.getAttribute('href')).toBe('/p/banco');
  });

  it('tab counters follow the project when it changes', async () => {
    server.use(...base());
    const { client } = renderRoutes('/p/banco');
    const tabs = await screen.findByRole('navigation', { name: 'Sezioni del progetto' });
    await waitFor(() =>
      expect(within(tabs).getByRole('link', { name: /Roadmap\s*2/ })).toBeTruthy(),
    );
    await waitFor(() =>
      expect(within(tabs).getByRole('link', { name: /Diario\s*4/ })).toBeTruthy(),
    );
    act(() => {
      client.setQueryData(
        ['project', 'banco'],
        project({ progress: { done: 3, total: 3, ratio: 1 } }),
      );
    });
    await waitFor(() =>
      expect(within(tabs).getByRole('link', { name: /Roadmap\s*0/ })).toBeTruthy(),
    );
  });
});

// ---------------------------------------------------------------- diary bottom bar
describe('verifyD: diary bottom bar', () => {
  it('attaches a file, sends a long note with its file ids and clears the bar', async () => {
    server.use(
      http.get('/api/projects', () => HttpResponse.json([])),
      http.get('/api/projects/:ref/diary/months', () => HttpResponse.json([])),
      http.get('/api/projects/:ref/diary', () => HttpResponse.json([])),
      http.post('/api/projects/:ref/files', () =>
        HttpResponse.json([
          {
            id: 55,
            projectId: 1,
            originalName: 'foto-pedale.jpg',
            mimeType: 'image/jpeg',
            size: 10,
          },
        ]),
      ),
      http.post('/api/projects/:ref/diary', async ({ request }) => {
        await log(request);
        return HttpResponse.json({});
      }),
    );
    const user = userEvent.setup();
    const { container } = renderApp(<DiaryView projectRef="banco" />);
    const field = await screen.findByPlaceholderText('Scrivi una nota…');
    const fileInput = container.querySelector('input[type="file"]') as HTMLInputElement;
    await user.upload(fileInput, new File(['x'], 'foto-pedale.jpg', { type: 'image/jpeg' }));
    expect(await screen.findByText('foto-pedale.jpg')).toBeTruthy();
    const long = 'Riga lunga del collaudo. '.repeat(40);
    await user.click(field);
    await user.paste(long);
    await user.click(screen.getByRole('button', { name: 'Invia' }));
    await waitFor(() => expect(calls).toHaveLength(1));
    expect(calls[0]?.body).toEqual({ body: long.trim(), fileIds: [55] });
    await waitFor(() => expect((field as HTMLTextAreaElement).value).toBe(''));
    expect(screen.queryByText('foto-pedale.jpg')).toBeNull();
    // After sending, the field shrinks back to one line (no inline height left over).
    expect(
      (field as HTMLTextAreaElement).style.height === '' ||
        (field as HTMLTextAreaElement).style.height === 'auto',
    ).toBe(true);
  });

  it('Invia is disabled for a blank note', async () => {
    server.use(
      http.get('/api/projects', () => HttpResponse.json([])),
      http.get('/api/projects/:ref/diary/months', () => HttpResponse.json([])),
      http.get('/api/projects/:ref/diary', () => HttpResponse.json([])),
    );
    const user = userEvent.setup();
    renderApp(<DiaryView projectRef="banco" />);
    const field = await screen.findByPlaceholderText('Scrivi una nota…');
    await user.type(field, '   ');
    expect((screen.getByRole('button', { name: 'Invia' }) as HTMLButtonElement).disabled).toBe(
      true,
    );
  });
});

// ---------------------------------------------------------------- i18n invariant
describe('verifyD: i18n', () => {
  it('every key exists in both languages with a non-empty text', () => {
    const a = Object.keys(itMsgs).sort();
    const b = Object.keys(en).sort();
    expect(b).toEqual(a);
    for (const k of a) {
      expect((en as Record<string, string>)[k]?.trim(), k).toBeTruthy();
    }
  });

  it('{n} placeholders match between it and en', () => {
    for (const k of Object.keys(itMsgs)) {
      const ph = (s: string) => (s.match(/\{\w+\}/g) ?? []).sort().join();
      expect(ph((en as Record<string, string>)[k] ?? ''), k).toBe(
        ph((itMsgs as Record<string, string>)[k] ?? ''),
      );
    }
  });
});
