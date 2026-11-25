// @vitest-environment happy-dom
// Independent verification, phase 4 group C: long diary (design 55). Invented data.
import type { DiaryEntryView } from '@heph/schema';
import { cleanup, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { HttpResponse, http } from 'msw';
import { setupServer } from 'msw/node';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { DiaryView } from './features/diary/DiaryView.js';
import { renderApp } from './test/render.js';

const entry = (id: number, occurredAt: string, body = `Nota ${id}`): DiaryEntryView => ({
  id,
  projectId: 1,
  type: 'note',
  eventKind: null,
  body,
  data: null,
  source: id % 2 ? 'ui' : 'claude_code',
  sessionId: null,
  occurredAt,
  files: [],
});

// Ten days of November (one entry per day, newest first) plus older October entries.
const NOV = Array.from({ length: 10 }, (_, i) =>
  entry(100 - i, new Date(Date.UTC(2026, 10, 20 - i, 12)).toISOString(), `Novembre ${20 - i}`),
);
NOV[9] = { ...NOV[9]!, body: 'Ricerca: saldatura a punti' };
const OCT = [
  entry(10, '2026-10-15T12:00:00.000Z', 'Ottobre quindici'),
  entry(9, '2026-10-02T12:00:00.000Z', 'Ottobre due'),
];
const requests: URL[] = [];
const server = setupServer(
  http.get('/api/projects', () => HttpResponse.json([])),
  http.get('/api/projects/:ref/diary/months', () =>
    HttpResponse.json([
      { month: '2026-11', count: 10 },
      { month: '2026-10', count: 2 },
    ]),
  ),
  http.get('/api/projects/:ref/diary', ({ request }) => {
    const u = new URL(request.url);
    requests.push(u);
    const before = u.searchParams.get('before');
    const all = [...NOV, ...OCT];
    return HttpResponse.json(before ? all.filter((e) => e.occurredAt < before) : all);
  }),
);
beforeAll(() => server.listen({ onUnhandledFrame: 'error' }));
afterEach(() => {
  cleanup();
  requests.length = 0;
});
afterAll(() => server.close());

describe('verifyC: long diary', () => {
  it('opens the first 7 days and closes the older ones with a summary that opens on click', async () => {
    const user = userEvent.setup();
    renderApp(<DiaryView projectRef="banco" />);
    expect(await screen.findByText('Novembre 20')).toBeTruthy();
    const toggles = screen.getAllByRole('button').filter((b) => b.classList.contains('day-toggle'));
    expect(toggles.length).toBe(12);
    expect(toggles.slice(0, 7).every((b) => b.getAttribute('aria-expanded') === 'true')).toBe(true);
    expect(toggles.slice(7).every((b) => b.getAttribute('aria-expanded') === 'false')).toBe(true);
    expect(screen.queryByText('Novembre 13')).toBeNull();
    await user.click(toggles[7]!);
    expect(await screen.findByText('Novembre 13')).toBeTruthy();
  });

  it('jumping to a month asks the server from the end of that month and Latest returns', async () => {
    const user = userEvent.setup();
    renderApp(<DiaryView projectRef="banco" />);
    const bar = await screen.findByRole('navigation', { name: /mes/i });
    const oct = within(bar)
      .getAllByRole('button')
      .find((b) => /ott/i.test(b.textContent ?? ''));
    expect(oct?.textContent).toMatch(/2/);
    await user.click(oct!);
    expect(await screen.findByText('Ottobre quindici')).toBeTruthy();
    await waitFor(() => expect(screen.queryByText('Novembre 20')).toBeNull());
    expect(requests.some((u) => u.searchParams.get('before') === '2026-11-01T00:00:00.000Z')).toBe(
      true,
    );
    await user.click(within(bar).getAllByRole('button')[0]!);
    expect(await screen.findByText('Novembre 20')).toBeTruthy();
  });

  // Bug: DayBlock keeps its open state from the first render (useState(startOpen)), so
  // typing in the diary search leaves matching older days closed: the match is hidden.
  it('the text search shows matches that are in days that started closed', async () => {
    const user = userEvent.setup();
    renderApp(<DiaryView projectRef="banco" />);
    expect(await screen.findByText('Novembre 20')).toBeTruthy();
    await user.type(screen.getByRole('searchbox'), 'saldatura');
    expect(await screen.findByText('Ricerca: saldatura a punti')).toBeTruthy();
  });
});
