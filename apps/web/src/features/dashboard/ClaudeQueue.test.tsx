// @vitest-environment happy-dom
import type { ClaudeQueueView, QueueItemView } from '@heph/schema';
import { cleanup, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { HttpResponse, http } from 'msw';
import { setupServer } from 'msw/node';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { renderApp } from '../../test/render.js';
import { ClaudeQueue, firstLine, startOfLocalDay } from './ClaudeQueue.js';

// Invented sessions.
const item = (id: string, over: Partial<QueueItemView> = {}): QueueItemView => ({
  sessionId: id,
  projectId: 1,
  projectSlug: 'banco',
  projectName: 'Banco da lavoro',
  state: 'working',
  startedAt: '2026-11-27T08:00:00.000Z',
  endedAt: null,
  lastEntry: null,
  ...over,
});

describe('firstLine', () => {
  it('takes the first non-empty line without Markdown markers', () => {
    expect(firstLine('\n\n## Gruppo A fatto\nresto')).toBe('Gruppo A fatto');
    expect(firstLine('- [x] **Chiuso** il task `#36`')).toBe('Chiuso il task #36');
    expect(firstLine('1. Primo passo')).toBe('Primo passo');
    expect(firstLine('> citazione')).toBe('citazione');
    expect(firstLine('')).toBe('');
  });
});

describe('startOfLocalDay', () => {
  it('is local midnight of the given day, as UTC ISO', () => {
    const d = new Date(2026, 10, 27, 15, 30);
    const s = new Date(startOfLocalDay(d));
    expect([s.getFullYear(), s.getMonth(), s.getDate(), s.getHours(), s.getMinutes()]).toEqual([
      2026, 10, 27, 0, 0,
    ]);
  });
});

const server = setupServer();
beforeAll(() => server.listen({ onUnhandledFrame: 'error' }));
beforeEach(() => localStorage.clear());
afterEach(() => {
  server.resetHandlers();
  cleanup();
});
afterAll(() => server.close());

const serve = (q: ClaudeQueueView, seen: string[] = []) =>
  server.use(
    http.get('/api/claude-queue', ({ request }) => {
      seen.push(new URL(request.url).searchParams.get('since') ?? '');
      return HttpResponse.json(q);
    }),
  );

describe('ClaudeQueue', () => {
  it('shows running sessions first, then ended ones, with state and last note', async () => {
    const seen: string[] = [];
    serve(
      {
        running: [
          item('a', {
            state: 'testing',
            lastEntry: { body: '## Test in corso', occurredAt: '2026-11-27T09:00:00.000Z' },
          }),
        ],
        ended: [
          item('b', {
            projectName: 'Radio Grundig',
            projectSlug: 'radio',
            state: 'ended',
            endedAt: '2026-11-27T07:00:00.000Z',
            lastEntry: { body: 'Chiusi 3 task', occurredAt: '2026-11-27T07:00:00.000Z' },
          }),
        ],
      },
      seen,
    );
    renderApp(<ClaudeQueue />);
    const box = await screen.findByRole('complementary', { name: 'Coda di Claude' });
    expect(within(box).getByText('1 in corso · 1 oggi')).toBeTruthy();
    const rows = within(box).getAllByRole('listitem');
    expect(rows[0]!.textContent).toContain('Banco da lavoro');
    expect(rows[0]!.textContent).toContain('esegue test');
    expect(rows[0]!.textContent).toContain('Test in corso');
    expect(rows[1]!.textContent).toMatch(/finita/);
    expect(within(rows[1]!).getByRole('link', { name: 'Radio Grundig' }).getAttribute('href')).toBe(
      '/p/radio',
    );
    expect(seen[0]).toBe(startOfLocalDay());
  });

  it('says when a running session has no note yet', async () => {
    serve({ running: [item('a')], ended: [] });
    renderApp(<ClaudeQueue />);
    expect(await screen.findByText('Ancora nessuna nota nel diario')).toBeTruthy();
    expect(screen.getByText('al lavoro')).toBeTruthy();
  });

  it('is not shown when there is nothing to show', async () => {
    const seen: string[] = [];
    serve({ running: [], ended: [] }, seen);
    renderApp(<ClaudeQueue />);
    await waitFor(() => expect(seen).toHaveLength(1));
    expect(screen.queryByRole('complementary')).toBeNull();
  });

  it('collapses with the keyboard and remembers it', async () => {
    serve({ running: [item('a')], ended: [] });
    const first = renderApp(<ClaudeQueue />);
    const toggle = await screen.findByRole('button', { name: 'Riduci la coda di Claude' });
    expect(toggle.getAttribute('aria-expanded')).toBe('true');
    toggle.focus();
    await userEvent.keyboard('{Enter}');
    expect(screen.queryByRole('listitem')).toBeNull();
    expect(
      screen.getByRole('button', { name: 'Apri la coda di Claude' }).getAttribute('aria-expanded'),
    ).toBe('false');
    first.unmount();
    renderApp(<ClaudeQueue />);
    expect(await screen.findByRole('button', { name: 'Apri la coda di Claude' })).toBeTruthy();
    expect(screen.queryByRole('listitem')).toBeNull();
  });
});
