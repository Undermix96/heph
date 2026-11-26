// @vitest-environment happy-dom
import { DEFAULT_SETTINGS, type Settings } from '@heph/schema';
import { cleanup, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { HttpResponse, http } from 'msw';
import { setupServer } from 'msw/node';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { renderApp } from '../../test/render.js';
import { SettingsPage } from './SettingsPage.js';

// Invented data. Phase 5 group C: Connect Claude Code and test patterns (D60).
let connect: { agentUrl: string | null; lastAgentCallAt: string | null } = {
  agentUrl: 'http://192.168.1.10:8081',
  lastAgentCallAt: null,
};
const patches: Partial<Settings>[] = [];
const server = setupServer(
  http.get('/api/settings', () => HttpResponse.json({ ...DEFAULT_SETTINGS, githubToken: null })),
  http.get('/api/settings/connect', () => HttpResponse.json(connect)),
  http.get('/api/settings/api-token', () => HttpResponse.json({ apiToken: 'heph_invented_token' })),
  http.patch('/api/settings', async ({ request }) => {
    const body = (await request.json()) as Partial<Settings>;
    patches.push(body);
    return HttpResponse.json({ ...DEFAULT_SETTINGS, ...body, githubToken: null });
  }),
);
beforeAll(() => server.listen());
afterEach(() => {
  cleanup();
  patches.length = 0;
});
afterAll(() => server.close());

describe('Connect Claude Code', () => {
  it('shows the plugin commands and the agent URL from the server', async () => {
    connect = { agentUrl: 'http://192.168.1.10:8081', lastAgentCallAt: null };
    renderApp(<SettingsPage />);
    const box = (await screen.findByRole('heading', { name: /Collega Claude Code/ })).closest(
      'section',
    ) as HTMLElement;
    expect(await within(box).findByText('http://192.168.1.10:8081')).toBeTruthy();
    expect(within(box).getByText('claude plugin marketplace add Undermix96/heph')).toBeTruthy();
    expect(within(box).getByText('claude plugin install heph@heph --scope user')).toBeTruthy();
    expect(within(box).getByText('/plugin configure heph@heph')).toBeTruthy();
    expect(within(box).getByText('claude mcp remove heph --scope user')).toBeTruthy();
    expect(within(box).getByText('ancora nessuna chiamata da Claude')).toBeTruthy();
    // The design's "project slug in CLAUDE.md" step is replaced (D23).
    expect(box.textContent).not.toContain('CLAUDE.md');
  });

  it('without HEPH_PUBLIC_AGENT_URL it says TBD and how to set it', async () => {
    connect = { agentUrl: null, lastAgentCallAt: new Date().toISOString() };
    renderApp(<SettingsPage />);
    expect(await screen.findByText(/TBD: imposta HEPH_PUBLIC_AGENT_URL/)).toBeTruthy();
    expect(await screen.findByText(/collegato · ultima chiamata/)).toBeTruthy();
  });

  it('an old last call is not shown as connected', async () => {
    connect = { agentUrl: null, lastAgentCallAt: '2026-01-01T00:00:00.000Z' };
    renderApp(<SettingsPage />);
    const pill = await screen.findByText(/ultima chiamata/);
    expect(pill.textContent).not.toContain('collegato');
  });
});

describe('Test patterns', () => {
  it('adds with Enter, refuses duplicates, removes, and saves with the form', async () => {
    const user = userEvent.setup();
    renderApp(<SettingsPage />);
    const input = await screen.findByLabelText('Nuovo schema');
    await user.type(input, '  make check  {Enter}');
    expect(screen.getByText('make check')).toBeTruthy();
    expect(patches).toHaveLength(0); // Enter did not submit the form
    await user.type(input, 'make check');
    await user.click(screen.getByRole('button', { name: 'Aggiungi' }));
    expect(screen.getByRole('alert').textContent).toContain('già nell’elenco');
    await user.click(screen.getByRole('button', { name: 'Rimuovi pytest' }));
    expect(screen.queryByText('pytest')).toBeNull();
    await user.click(screen.getByRole('button', { name: 'Salva' }));
    await waitFor(() => expect(patches).toHaveLength(1));
    const saved = patches[0]?.testCommandPatterns ?? [];
    expect(saved).toContain('make check');
    expect(saved).not.toContain('pytest');
    expect(patches[0]?.diaryNudgeTurns).toBe(5);
  });
});
