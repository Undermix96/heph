// @vitest-environment happy-dom
// Independent verification C9: Claude's queue in the UI (D76). Invented sessions.
import type { ClaudeQueueView, QueueItemView } from '@heph/schema';
import { cleanup, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { HttpResponse, http } from 'msw';
import { setupServer } from 'msw/node';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { en } from '../../i18n/en.js';
import { it as itMsgs } from '../../i18n/it.js';
import { renderApp, summary } from '../../test/render.js';
import { ClaudeQueue, firstLine, startOfLocalDay } from './ClaudeQueue.js';
import { MobileDashboard } from './MobileDashboard.js';

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
const ended = (id: string, over: Partial<QueueItemView> = {}) =>
  item(id, {
    state: 'ended',
    endedAt: '2026-11-27T07:00:00.000Z',
    lastEntry: { body: `Nota ${id}`, occurredAt: '2026-11-27T07:00:00.000Z' },
    ...over,
  });

const server = setupServer(
  http.get('/api/claude-queue', () => HttpResponse.json({ running: [], ended: [] })),
  http.get('/api/proposals', () => HttpResponse.json([])),
);
beforeAll(() => server.listen());
beforeEach(() => localStorage.clear());
afterEach(() => {
  server.resetHandlers();
  cleanup();
});
afterAll(() => server.close());

const serve = (q: ClaudeQueueView | (() => Response)) =>
  server.use(
    http.get('/api/claude-queue', () => (typeof q === 'function' ? q() : HttpResponse.json(q))),
  );

describe('C9 firstLine on realistic notes', () => {
  it('handles common Markdown openings', () => {
    expect(firstLine('**Gruppo B9**: chiusi 5 task')).toBe('Gruppo B9: chiusi 5 task');
    expect(firstLine('#36 chiuso')).toBe('#36 chiuso');
    expect(firstLine('   \n\t\n* item')).toBe('item');
    expect(firstLine('2) secondo')).toBe('secondo');
  });

  it('a note that opens with a code fence does not show the fence language', () => {
    // Claude sometimes starts a note with a command block.
    expect(firstLine('```powershell\nnpm test\n```')).not.toBe('powershell');
  });

  it('a note that opens with a link shows the link text, not the Markdown', () => {
    expect(firstLine('[PR #12](https://github.com/me/x/pull/12) unita')).toBe('PR #12 unita');
  });
});

describe('C9 startOfLocalDay', () => {
  it('a minute before and after local midnight give different days', () => {
    const a = startOfLocalDay(new Date(2026, 10, 27, 23, 59));
    const b = startOfLocalDay(new Date(2026, 10, 28, 0, 1));
    expect(Date.parse(b) - Date.parse(a)).toBeGreaterThanOrEqual(23 * 3600_000);
    expect(a.endsWith('Z')).toBe(true);
  });
});

describe('C9 ClaudeQueue box', () => {
  it('only ended sessions: shown, no live dot, counts say 0 running', async () => {
    serve({ running: [], ended: [ended('a')] });
    const { container } = renderApp(<ClaudeQueue />);
    const box = await screen.findByRole('complementary', { name: 'Coda di Claude' });
    expect(within(box).getByText('0 in corso · 1 oggi')).toBeTruthy();
    expect(container.querySelector('.dot-live')).toBeNull();
    // State is in words, not only colour.
    expect(within(box).getByRole('listitem').textContent).toMatch(/finita/);
    expect(box.querySelector('time')?.getAttribute('dateTime')).toBe('2026-11-27T07:00:00.000Z');
  });

  it('a failing request hides the box without crashing', async () => {
    let hits = 0;
    serve(() => {
      hits++;
      return HttpResponse.json({ error: { code: 'internal' } }, { status: 500 });
    });
    renderApp(<ClaudeQueue />);
    await waitFor(() => expect(hits).toBeGreaterThan(0));
    expect(screen.queryByRole('complementary')).toBeNull();
  });

  it('two sessions on the same project are two rows, each linking to the project', async () => {
    serve({ running: [item('a'), item('b', { state: 'testing' })], ended: [] });
    renderApp(<ClaudeQueue />);
    const links = await screen.findAllByRole('link', { name: 'Banco da lavoro' });
    expect(links).toHaveLength(2);
    for (const l of links) expect(l.getAttribute('href')).toBe('/p/banco');
    expect(screen.getByText('esegue test')).toBeTruthy();
  });

  it('long names and 300-character notes are shown in full (no JS truncation)', async () => {
    const name = 'Restauro della radio Grundig del nonno con amplificatore valvolare'.repeat(2);
    const body = `${'parola '.repeat(42).trim()}…`;
    serve({
      running: [
        item('a', {
          projectName: name,
          lastEntry: { body, occurredAt: '2026-11-27T08:00:00.000Z' },
        }),
      ],
      ended: [],
    });
    renderApp(<ClaudeQueue />);
    expect(await screen.findByRole('link', { name })).toBeTruthy();
    expect(screen.getByText(body)).toBeTruthy();
  });

  it('Tab reaches the links and the toggle; Space toggles too', async () => {
    serve({
      running: [item('a')],
      ended: [ended('b', { projectName: 'Radio', projectSlug: 'radio' })],
    });
    renderApp(<ClaudeQueue />);
    await screen.findByRole('complementary');
    const user = userEvent.setup();
    await user.tab();
    expect(document.activeElement?.getAttribute('aria-label')).toBe('Riduci la coda di Claude');
    await user.tab();
    expect(document.activeElement?.textContent).toBe('Banco da lavoro');
    await user.tab();
    expect(document.activeElement?.textContent).toBe('Radio');
    screen.getByRole('button').focus();
    await user.keyboard(' ');
    expect(screen.queryByRole('list')).toBeNull();
    await user.keyboard(' ');
    expect(screen.getAllByRole('listitem')).toHaveLength(2);
    expect(localStorage.getItem('heph.queue.collapsed')).toBe('0');
  });

  it('collapsed: aria-controls does not point to a missing element', async () => {
    localStorage.setItem('heph.queue.collapsed', '1');
    serve({ running: [item('a')], ended: [] });
    renderApp(<ClaudeQueue />);
    const toggle = await screen.findByRole('button', { name: 'Apri la coda di Claude' });
    const id = toggle.getAttribute('aria-controls');
    expect(id === null || document.getElementById(id) !== null).toBe(true);
  });

  it('a stored collapsed state survives the box disappearing and coming back', async () => {
    localStorage.setItem('heph.queue.collapsed', '1');
    serve({ running: [], ended: [] });
    const r = renderApp(<ClaudeQueue />);
    await waitFor(() => expect(screen.queryByRole('complementary')).toBeNull());
    r.unmount();
    serve({ running: [item('a')], ended: [] });
    renderApp(<ClaudeQueue />);
    expect(await screen.findByRole('button', { name: 'Apri la coda di Claude' })).toBeTruthy();
  });

  it('every queue text exists in both languages', () => {
    const keys = Object.keys(itMsgs).filter((k) => k.startsWith('queue.'));
    expect(keys.length).toBeGreaterThanOrEqual(8);
    for (const k of keys) expect(en[k as keyof typeof en], k).toBeTruthy();
  });
});

describe('C9 phone block', () => {
  it('is not shown when the queue is empty, even if a project says Claude is working', async () => {
    let hits = 0;
    server.use(
      http.get('/api/claude-queue', () => {
        hits++;
        return HttpResponse.json({ running: [], ended: [] });
      }),
    );
    renderApp(<MobileDashboard projects={[summary({ activityState: 'claude_working' })]} />);
    await waitFor(() => expect(hits).toBeGreaterThan(0));
    expect(screen.queryByRole('region', { name: 'Coda di Claude' })).toBeNull();
  });

  it('shows ended sessions with links and sits between attention and All', async () => {
    serve({ running: [], ended: [ended('a', { projectName: 'Radio', projectSlug: 'radio' })] });
    const { container } = renderApp(
      <MobileDashboard projects={[summary({ lifecycle: 'awaiting_manual_test' } as never)]} />,
    );
    const block = await screen.findByRole('region', { name: 'Coda di Claude' });
    expect(within(block).getByRole('link', { name: 'Radio' }).getAttribute('href')).toBe(
      '/p/radio',
    );
    expect(within(block).getByText('Nota a')).toBeTruthy();
    const sections = [...container.querySelectorAll('.m-dash > section')];
    const i = sections.indexOf(block);
    expect(i).toBeGreaterThanOrEqual(0);
    expect(sections[i + 1]?.textContent).toContain('Tutti');
  });
});
