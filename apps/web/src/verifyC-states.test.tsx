// @vitest-environment happy-dom
// Independent verification, phase 4 group C: server-not-answering notice, page language,
// empty dashboard with the getting-started list, project not found. Fake API (MSW),
// invented data only.
import { DEFAULT_SETTINGS, type Settings } from '@heph/schema';
import { QueryClientProvider } from '@tanstack/react-query';
import { act, cleanup, render, screen, waitFor } from '@testing-library/react';
import { HttpResponse, http } from 'msw';
import { setupServer } from 'msw/node';
import { createMemoryRouter, RouterProvider } from 'react-router';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { makeQueryClient } from './api/queries.js';
import { routes, Session } from './app/App.js';
import { setOffline } from './app/online.js';

let settings: Settings = { ...DEFAULT_SETTINGS, uiLanguage: 'it' };
const ok = () => [
  http.get('/api/auth/status', () =>
    HttpResponse.json({ setupDone: true, user: { id: 1, username: 'prova' } }),
  ),
  http.get('/api/settings', () => HttpResponse.json(settings)),
  http.get('/api/projects', () => HttpResponse.json([])),
  http.get('/api/projects/:ref', () =>
    HttpResponse.json({ error: { code: 'not_found', message: 'x' } }, { status: 404 }),
  ),
  http.get('/api/proposals', () => HttpResponse.json([])),
  http.get('/api/tags', () => HttpResponse.json([])),
];
const server = setupServer(...ok());
beforeAll(() => server.listen({ onUnhandledFrame: 'error' }));
afterEach(() => {
  cleanup();
  server.resetHandlers(...ok());
  settings = { ...DEFAULT_SETTINGS, uiLanguage: 'it' };
  setOffline(false);
});
afterAll(() => server.close());

function renderAt(path: string) {
  const client = makeQueryClient();
  const router = createMemoryRouter(routes, { initialEntries: [path] });
  render(
    <QueryClientProvider client={client}>
      <Session>
        <RouterProvider router={router} />
      </Session>
    </QueryClientProvider>,
  );
  return { client, router };
}

const notice = () => document.querySelector('.offline');

describe('verifyC: server not answering', () => {
  it('shows the page-wide notice on network errors and clears it on the next success', async () => {
    const { client } = renderAt('/');
    expect(await screen.findByText('Per iniziare')).toBeTruthy();
    expect(notice()).toBeNull();
    server.use(http.get('/api/projects', () => HttpResponse.error()));
    await act(() => client.refetchQueries({ queryKey: ['projects'] }).catch(() => {}));
    await waitFor(() => expect(notice()).not.toBeNull(), { timeout: 5000 });
    server.resetHandlers(...ok());
    await act(() => client.refetchQueries({ queryKey: ['projects'] }));
    await waitFor(() => expect(notice()).toBeNull());
  });

  // Bug (normal use through Cloudflare Access, D54): when the Heph container is down the
  // tunnel still answers, with a 502 HTML page, so fetch never throws and the notice never
  // shows; every box shows its own generic error instead.
  it('shows the notice when a proxy answers 502 with an HTML page (server down behind the tunnel)', async () => {
    const { client } = renderAt('/');
    expect(await screen.findByText('Per iniziare')).toBeTruthy();
    server.use(
      http.get(
        '/api/projects',
        () =>
          new HttpResponse('<html>Bad gateway</html>', {
            status: 502,
            headers: { 'content-type': 'text/html' },
          }),
      ),
    );
    await act(() => client.refetchQueries({ queryKey: ['projects'] }).catch(() => {}));
    await waitFor(() => expect(notice()).not.toBeNull(), { timeout: 3000 });
  }, 10_000);
});

describe('verifyC: language and states', () => {
  it('sets <html lang> from the uiLanguage setting', async () => {
    settings = { ...DEFAULT_SETTINGS, uiLanguage: 'en' };
    renderAt('/');
    expect(await screen.findByText('Getting started')).toBeTruthy();
    expect(document.documentElement.lang).toBe('en');
  });

  it('empty dashboard lists account, Claude Code and GitHub steps', async () => {
    renderAt('/');
    expect(await screen.findByText('Per iniziare')).toBeTruthy();
    const items = document.querySelectorAll('.checklist li');
    expect(items.length).toBe(3);
  });

  it('a missing project shows the not-found state', async () => {
    renderAt('/p/nessuno');
    await waitFor(() => expect(document.querySelector('.alert, [role="alert"]')).not.toBeNull(), {
      timeout: 5000,
    });
    expect(notice()).toBeNull();
  });
});
