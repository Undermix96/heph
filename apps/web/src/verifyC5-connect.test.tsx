// @vitest-environment happy-dom
// Independent verification, phase 5 group C: Connect Claude Code page and test patterns
// (D60, mockup 31). Invented data.
import { DEFAULT_SETTINGS, type DiaryEntryView, type Settings } from '@heph/schema';
import { QueryClientProvider } from '@tanstack/react-query';
import { act, cleanup, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { HttpResponse, http } from 'msw';
import { setupServer } from 'msw/node';
import { MemoryRouter } from 'react-router';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { makeQueryClient } from './api/queries.js';
import { NoticesProvider } from './app/notices.js';
import { DiaryView } from './features/diary/DiaryView.js';
import { SettingsPage } from './features/settings/SettingsPage.js';
import { I18nProvider } from './i18n/index.js';
import { renderApp, summary } from './test/render.js';

let settings: Settings = { ...DEFAULT_SETTINGS, githubToken: null };
let connect: { agentUrl: string | null; lastAgentCallAt: string | null } = {
  agentUrl: 'http://192.168.1.10:8081',
  lastAgentCallAt: null,
};
let connectStatus = 200;
let connectCalls = 0;
const patches: Partial<Settings>[] = [];

const entry = (id: number, sessionId: string | null, body: string): DiaryEntryView => ({
  id,
  projectId: 1,
  type: 'note',
  eventKind: null,
  body,
  data: null,
  source: 'claude_code',
  sessionId,
  occurredAt: new Date(Date.now() - id * 60_000).toISOString(),
  files: [],
});
let liveIds: string[] = [];

const server = setupServer(
  http.get('/api/settings', () => HttpResponse.json(settings)),
  http.get('/api/settings/connect', () => {
    connectCalls++;
    return connectStatus === 200
      ? HttpResponse.json(connect)
      : HttpResponse.json({ error: { code: 'internal' } }, { status: connectStatus });
  }),
  http.get('/api/settings/api-token', () => HttpResponse.json({ apiToken: 'heph_invented_token' })),
  http.patch('/api/settings', async ({ request }) => {
    const body = (await request.json()) as Partial<Settings>;
    patches.push(body);
    settings = { ...settings, ...body };
    return HttpResponse.json(settings);
  }),
  http.get('/api/auth/me', () => HttpResponse.json({ setupDone: true, user: { username: 'io' } })),
  http.get('/api/projects', () => HttpResponse.json([summary({ liveSessionIds: liveIds })])),
  http.get('/api/projects/:ref/diary/months', () => HttpResponse.json([])),
  http.get('/api/projects/:ref/diary', () =>
    HttpResponse.json([
      entry(1, 'sess-live', 'Montata la lente.'),
      entry(2, 'sess-live', 'Regolato il fuoco.'),
      entry(30, 'sess-old', 'Pulito il banco.'),
      entry(31, 'sess-old', 'Riordinati gli attrezzi.'),
    ]),
  ),
);
beforeAll(() => server.listen());
beforeEach(() => {
  settings = { ...DEFAULT_SETTINGS, githubToken: null };
  connect = { agentUrl: 'http://192.168.1.10:8081', lastAgentCallAt: null };
  connectStatus = 200;
  connectCalls = 0;
  liveIds = [];
});
afterEach(() => {
  cleanup();
  patches.length = 0;
});
afterAll(() => server.close());

const claudeBox = async () =>
  (await screen.findByRole('heading', { name: /Collega Claude Code/ })).closest(
    'section',
  ) as HTMLElement;

describe('verifyC5: Connect Claude Code', () => {
  it('section order in the page matches the order of the in-page navigation', async () => {
    const { container } = renderApp(<SettingsPage />);
    await screen.findByLabelText('Nuovo schema');
    await claudeBox();
    const navOrder = [...container.querySelectorAll('.settings-nav a')].map((a) =>
      a.getAttribute('href')?.slice(1),
    );
    const domOrder = [...container.querySelectorAll('section[id^="s-"]')].map((s) => s.id);
    expect(domOrder).toEqual(navOrder);
  });

  it('every nav link points to an existing section', async () => {
    const { container } = renderApp(<SettingsPage />);
    await screen.findByLabelText('Nuovo schema');
    for (const a of container.querySelectorAll('.settings-nav a')) {
      const id = a.getAttribute('href')?.slice(1) ?? '';
      expect(container.querySelector(`#${id}`), id).not.toBeNull();
    }
  });

  it('a failed /settings/connect shows an error with an action, not a silent gap', async () => {
    connectStatus = 500;
    renderApp(<SettingsPage />);
    const box = await claudeBox();
    // Commands that do not depend on the server are still there.
    expect(within(box).getByText('claude plugin install heph@heph --scope user')).toBeTruthy();
    await waitFor(() => expect(connectCalls).toBeGreaterThan(0));
    // Never fail silently: some error text and a retry inside the Claude box.
    await waitFor(() => expect(within(box).getByRole('button', { name: /Riprova/ })).toBeTruthy());
  });

  it('a very long agent URL is shown whole and copyable', async () => {
    const long = `https://heph-agent.${'molto-lungo.'.repeat(15)}casa.lan:8081`;
    connect = { agentUrl: long, lastAgentCallAt: null };
    renderApp(<SettingsPage />);
    const box = await claudeBox();
    expect(await within(box).findByText(long)).toBeTruthy();
    expect(within(box).getByRole('button', { name: `Copia: ${long}` })).toBeTruthy();
  });

  it('copy button copies the exact command', async () => {
    const user = userEvent.setup();
    renderApp(<SettingsPage />);
    const box = await claudeBox();
    const btn = within(box).getByRole('button', {
      name: 'Copia: claude plugin install heph@heph --scope user',
    });
    await user.click(btn);
    expect(await navigator.clipboard.readText()).toBe(
      'claude plugin install heph@heph --scope user',
    );
  });

  it('the status pill is not colour-only: it has text for each state', async () => {
    connect = { agentUrl: null, lastAgentCallAt: new Date(Date.now() - 5 * 60_000).toISOString() };
    renderApp(<SettingsPage />);
    const box = await claudeBox();
    const pill = await within(box).findByText(/collegato · ultima chiamata/);
    expect(pill.textContent).toMatch(/min|minuti/);
  });

  it('English: page texts switch language', async () => {
    const client = makeQueryClient();
    render(
      <QueryClientProvider client={client}>
        <I18nProvider lang="en">
          <NoticesProvider>
            <MemoryRouter>
              <SettingsPage />
            </MemoryRouter>
          </NoticesProvider>
        </I18nProvider>
      </QueryClientProvider>,
    );
    expect(await screen.findByRole('heading', { name: /Connect Claude Code/ })).toBeTruthy();
    expect(await screen.findByText('no call from Claude yet')).toBeTruthy();
    expect(screen.getByLabelText('New pattern')).toBeTruthy();
    expect(screen.getByText(/Ask Claude for a diary note after/)).toBeTruthy();
    client.clear();
  });

  it('polls /settings/connect (D52, 10 s) so the pill follows the last call', async () => {
    const client = makeQueryClient();
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
    const box = await claudeBox();
    expect(await within(box).findByText('ancora nessuna chiamata da Claude')).toBeTruthy();
    connect = { ...connect, lastAgentCallAt: new Date().toISOString() };
    await waitFor(() => expect(within(box).getByText(/collegato · ultima chiamata/)).toBeTruthy(), {
      timeout: 13_000,
    });
    client.clear();
  }, 20_000);
});

describe('verifyC5: test patterns', () => {
  it('whitespace-only input adds nothing and saves nothing', async () => {
    const user = userEvent.setup();
    const { container } = renderApp(<SettingsPage />);
    const input = await screen.findByLabelText('Nuovo schema');
    const before = container.querySelectorAll('.patterns li').length;
    await user.type(input, '    {Enter}');
    expect(container.querySelectorAll('.patterns li').length).toBe(before);
    expect(screen.queryByRole('alert')).toBeNull();
  });

  it('a trimmed duplicate of a default pattern is refused', async () => {
    const user = userEvent.setup();
    const { container } = renderApp(<SettingsPage />);
    const input = await screen.findByLabelText('Nuovo schema');
    const before = container.querySelectorAll('.patterns li').length;
    await user.type(input, '   npm test   {Enter}');
    expect(container.querySelectorAll('.patterns li').length).toBe(before);
    expect(screen.getByRole('alert').textContent).toContain('già nell’elenco');
  });

  it('input is capped at 200 characters', async () => {
    const user = userEvent.setup();
    renderApp(<SettingsPage />);
    const input = (await screen.findByLabelText('Nuovo schema')) as HTMLInputElement;
    await user.type(input, 'x'.repeat(230));
    expect(input.value.length).toBeLessThanOrEqual(200);
  });

  it('with 100 patterns the 101st is refused with a message, and the list saves 100', async () => {
    const user = userEvent.setup();
    settings = {
      ...settings,
      testCommandPatterns: Array.from({ length: 100 }, (_, i) => `cmd-${i}`),
    };
    const { container } = renderApp(<SettingsPage />);
    const input = await screen.findByLabelText('Nuovo schema');
    await user.type(input, 'cmd-new{Enter}');
    expect(screen.getByRole('alert').textContent).toContain('100');
    expect(container.querySelectorAll('.patterns li').length).toBe(100);
  });

  it('the "full" message goes away once a pattern is removed', async () => {
    const user = userEvent.setup();
    settings = {
      ...settings,
      testCommandPatterns: Array.from({ length: 100 }, (_, i) => `cmd-${i}`),
    };
    renderApp(<SettingsPage />);
    const input = await screen.findByLabelText('Nuovo schema');
    await user.type(input, 'cmd-new{Enter}');
    expect(screen.getByRole('alert')).toBeTruthy();
    await user.click(screen.getByRole('button', { name: 'Rimuovi cmd-0' }));
    // The list now has room: the stale "At most 100" message should not stay.
    expect(screen.queryByRole('alert')).toBeNull();
  });

  it('the duplicate message goes away when the user edits the draft', async () => {
    const user = userEvent.setup();
    renderApp(<SettingsPage />);
    const input = await screen.findByLabelText('Nuovo schema');
    await user.type(input, 'npm test{Enter}');
    expect(screen.getByRole('alert')).toBeTruthy();
    await user.clear(input);
    await user.type(input, 'make check');
    expect(screen.queryByRole('alert')).toBeNull();
  });

  it('keyboard only: removing a pattern keeps focus inside the pattern editor', async () => {
    const user = userEvent.setup();
    renderApp(<SettingsPage />);
    const btn = await screen.findByRole('button', { name: 'Rimuovi npm test' });
    btn.focus();
    await user.keyboard('{Enter}');
    expect(screen.queryByRole('button', { name: 'Rimuovi npm test' })).toBeNull();
    // Focus should land on a neighbour (next remove button or the input), not on <body>.
    expect(document.activeElement).not.toBe(document.body);
    expect(document.activeElement?.closest('.patterns')).not.toBeNull();
  });

  it('removed and added patterns, plus diary thresholds, go in one PATCH', async () => {
    const user = userEvent.setup();
    renderApp(<SettingsPage />);
    const input = await screen.findByLabelText('Nuovo schema');
    await user.click(screen.getByRole('button', { name: 'Rimuovi npm test' }));
    await user.type(input, 'make check{Enter}');
    const turns = screen.getByLabelText(/Chiedi a Claude una voce di diario dopo/);
    await user.clear(turns);
    await user.type(turns, '8');
    const minutes = screen.getByLabelText(/oppure dopo \(minuti\)/);
    await user.clear(minutes);
    await user.type(minutes, '45');
    await user.click(screen.getByRole('button', { name: 'Salva' }));
    await waitFor(() => expect(patches).toHaveLength(1));
    const p = patches[0] as Partial<Settings>;
    expect(p.testCommandPatterns).not.toContain('npm test');
    expect(p.testCommandPatterns).toContain('make check');
    expect(p.diaryNudgeTurns).toBe(8);
    expect(p.diaryNudgeMinutes).toBe(45);
  });

  it('a pattern added while a long list is open is visible and the input empties', async () => {
    const user = userEvent.setup();
    renderApp(<SettingsPage />);
    const input = (await screen.findByLabelText('Nuovo schema')) as HTMLInputElement;
    await user.type(input, 'npx vitest run --reporter=dot{Enter}');
    expect(screen.getByText('npx vitest run --reporter=dot')).toBeTruthy();
    expect(input.value).toBe('');
    await act(async () => {});
  });
});

describe('verifyC5: diary live session label', () => {
  it('shows "in corso" only on the live session block', async () => {
    liveIds = ['sess-live'];
    const { container } = renderApp(<DiaryView projectRef="banco" />);
    await screen.findByText('Montata la lente.');
    await waitFor(() => expect(screen.getAllByText('in corso')).toHaveLength(1));
    const blocks = [...container.querySelectorAll('.box-ai')];
    const live = blocks.find((b) => b.textContent?.includes('Montata la lente.'));
    const old = blocks.find((b) => b.textContent?.includes('Pulito il banco.'));
    expect(live?.textContent).toContain('in corso');
    expect(old?.textContent).not.toContain('in corso');
  });

  it('no live session: no "in corso" label anywhere', async () => {
    liveIds = [];
    renderApp(<DiaryView projectRef="banco" />);
    await screen.findByText('Montata la lente.');
    expect(screen.queryByText('in corso')).toBeNull();
  });
});
