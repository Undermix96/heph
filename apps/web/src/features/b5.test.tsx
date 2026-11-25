// @vitest-environment happy-dom
import type { Settings } from '@heph/schema';
import { DEFAULT_SETTINGS } from '@heph/schema';
import { cleanup, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { HttpResponse, http } from 'msw';
import { setupServer } from 'msw/node';
import { Route, Routes } from 'react-router';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { detail, phase, renderApp, task } from '../test/render.js';
import { EditProjectPage } from './project/EditProjectPage.js';
import { Snippet } from './search/SearchPage.js';
import { SettingsPage } from './settings/SettingsPage.js';

const calls: { method: string; path: string; body: unknown }[] = [];
const rec =
  (reply: unknown, status = 200) =>
  async ({ request }: { request: Request }) => {
    const body =
      request.method === 'GET' || request.method === 'DELETE'
        ? null
        : await request.json().catch(() => null);
    calls.push({ method: request.method, path: new URL(request.url).pathname, body });
    return status === 204
      ? new HttpResponse(null, { status })
      : HttpResponse.json(reply as never, { status });
  };
const project = detail([phase(1, 0, [task(1, 1, 0)])], { slug: 'banco', name: 'Banco da lavoro' });
const settings: Settings = { ...DEFAULT_SETTINGS };
const server = setupServer(
  http.get('/api/settings', () => HttpResponse.json(settings)),
  http.patch('/api/settings', rec(settings)),
  http.get('/api/projects/:ref', () => HttpResponse.json(project)),
  http.get('/api/projects', () => HttpResponse.json([])),
  http.delete('/api/projects/:ref', rec(null, 204)),
);
beforeAll(() => server.listen({ onUnhandledFrame: 'error' }));
afterEach(() => {
  cleanup();
  calls.length = 0;
});
afterAll(() => server.close());

describe('Snippet', () => {
  it('renders marks as elements and everything else as text, never as HTML', () => {
    const { container } = render(<Snippet html={'a &lt;b&gt; <mark>tavolo</mark> &amp; c'} />);
    expect(container.querySelectorAll('mark')).toHaveLength(1);
    expect(container.querySelector('b')).toBeNull();
    expect(container.textContent).toBe('a <b> tavolo & c');
  });
});

describe('SettingsPage', () => {
  it('refuses thresholds in the wrong order and saves valid ones without the GitHub token', async () => {
    const user = userEvent.setup();
    renderApp(<SettingsPage />);
    const recent = await screen.findByLabelText('Attivo di recente (giorni)');
    await user.clear(recent);
    await user.type(recent, '40');
    await user.click(screen.getByRole('button', { name: 'Salva' }));
    expect(await screen.findByText(/deve essere minore/)).toBeTruthy();
    expect(calls).toEqual([]);
    await user.clear(recent);
    await user.type(recent, '5');
    await user.click(screen.getByRole('button', { name: 'Salva' }));
    await waitFor(() => expect(calls).toHaveLength(1));
    const body = calls[0]?.body as Record<string, unknown>;
    expect(body.recentlyActiveDays).toBe(5);
    expect('githubToken' in body).toBe(false);
  });
});

describe('EditProjectPage', () => {
  it('deletes the project only after the exact name is typed', async () => {
    const user = userEvent.setup();
    renderApp(
      <Routes>
        <Route path="/p/:slug/edit" element={<EditProjectPage />} />
        <Route path="/" element={<p>dashboard</p>} />
      </Routes>,
      { path: '/p/banco/edit' },
    );
    await user.click(await screen.findByRole('button', { name: 'Elimina il progetto' }));
    const confirm = screen
      .getAllByRole('button', { name: 'Elimina il progetto' })
      .at(-1) as HTMLButtonElement;
    expect(confirm.disabled).toBe(true);
    await user.type(screen.getByLabelText('Nome del progetto'), 'Banco da lavor');
    expect(confirm.disabled).toBe(true);
    await user.type(screen.getByLabelText('Nome del progetto'), 'o');
    await user.click(confirm);
    await waitFor(() =>
      expect(calls).toEqual([{ method: 'DELETE', path: '/api/projects/banco', body: null }]),
    );
    expect(await screen.findByText('dashboard')).toBeTruthy();
  });
});
