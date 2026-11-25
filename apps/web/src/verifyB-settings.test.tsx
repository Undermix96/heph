// @vitest-environment happy-dom
import { DEFAULT_SETTINGS, type Settings } from '@heph/schema';
import { QueryClientProvider } from '@tanstack/react-query';
import { cleanup, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { HttpResponse, http } from 'msw';
import { setupServer } from 'msw/node';
import { MemoryRouter } from 'react-router';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { makeQueryClient } from './api/queries.js';
import { NoticesProvider } from './app/notices.js';
import { SettingsPage } from './features/settings/SettingsPage.js';
import { I18nProvider } from './i18n/index.js';

// Independent verification, phase 4 group B (settings). Invented data.
const settings: Settings = { ...DEFAULT_SETTINGS };
const calls: { path: string; body: unknown }[] = [];
const server = setupServer(
  http.get('/api/settings', () => HttpResponse.json({ ...settings, githubToken: null })),
  http.get('/api/projects', () => HttpResponse.json([])),
  // The real server answers a wrong current password with 401 `unauthorized`.
  http.post('/api/auth/password', async ({ request }) => {
    calls.push({ path: '/auth/password', body: await request.json() });
    return HttpResponse.json(
      { error: { code: 'unauthorized', message: 'Current password is wrong' } },
      { status: 401 },
    );
  }),
);
beforeAll(() => server.listen({ onUnhandledFrame: 'error' }));
afterEach(() => {
  cleanup();
  calls.length = 0;
});
afterAll(() => server.close());

/** Same as the app: the real query client, whose 401 handler signs the user out. */
function renderReal() {
  const client = makeQueryClient();
  client.setQueryData(['auth'], { setupDone: true, user: { id: 1, username: 'mario' } });
  render(
    <QueryClientProvider client={client}>
      <I18nProvider lang="it">
        <NoticesProvider>
          <MemoryRouter>
            <SettingsPage />
          </MemoryRouter>
        </NoticesProvider>
      </I18nProvider>
    </QueryClientProvider>,
  );
  return client;
}

describe('verifyB SettingsPage password change', () => {
  it('a mistyped current password does not sign the user out', async () => {
    const user = userEvent.setup();
    const client = renderReal();
    await user.type(await screen.findByLabelText('Password attuale'), 'sbagliata');
    await user.type(screen.getByLabelText('Nuova password'), 'nuovapassword1');
    await user.type(screen.getByLabelText(/Ripeti|Conferma/), 'nuovapassword1');
    await user.click(screen.getByRole('button', { name: 'Cambia password' }));
    await waitFor(() => expect(calls).toHaveLength(1));
    await new Promise((r) => setTimeout(r, 50));
    // The session is still valid: the app must not drop to the sign-in screen.
    expect(client.getQueryData<{ user: unknown }>(['auth'])?.user).not.toBeNull();
    // And the text must not claim the session expired.
    expect(screen.queryByText('La sessione è scaduta. Accedi di nuovo.')).toBeNull();
  });
});
