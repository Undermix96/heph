// @vitest-environment happy-dom
// Dashboard tile: a long phase title is its own truncatable element, so the bar and the
// percentage always stay visible (owner report 2026-11-27). Invented data.
import { cleanup, screen } from '@testing-library/react';
import { HttpResponse, http } from 'msw';
import { setupServer } from 'msw/node';
import { afterAll, afterEach, beforeAll, expect, it } from 'vitest';
import { renderApp, summary } from '../../test/render.js';
import { DashboardPage } from './DashboardPage.js';

const server = setupServer();
beforeAll(() => server.listen({ onUnhandledFrame: 'error' }));
afterEach(() => {
  cleanup();
  server.resetHandlers();
});
afterAll(() => server.close());

const LONG = 'Fase 4 — Schedulazione, log, gestione errori, consegna e molto altro';

it('renders the bar, the phase title (with its full text as title) and the percentage apart', async () => {
  server.use(
    http.get('/api/projects', () =>
      HttpResponse.json([
        summary({
          progress: { done: 3, total: 5, ratio: 0.6 },
          phaseProgress: [{ id: 4, title: LONG, progress: { done: 3, total: 5, ratio: 0.6 } }],
          currentPhase: { id: 4, title: LONG, position: 3 },
        }),
      ]),
    ),
    http.get('/api/proposals', () => HttpResponse.json([])),
  );
  renderApp(<DashboardPage tab="projects" />);
  const phase = await screen.findByTitle(LONG);
  expect(phase.classList.contains('tile-phase')).toBe(true);
  const row = phase.closest('.tile-progress') as HTMLElement;
  expect(row.firstElementChild?.classList.contains('segprogress')).toBe(true);
  expect(row.querySelector('.tile-pct')?.textContent).toBe('60%');
  expect(phase.textContent).not.toContain('%');
});
