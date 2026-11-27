// @vitest-environment happy-dom
// Independent verification (2026-11-27): tile progress row without a current phase.
// Invented data.
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

function serve(projects: ReturnType<typeof summary>[]) {
  server.use(
    http.get('/api/projects', () => HttpResponse.json(projects)),
    http.get('/api/proposals', () => HttpResponse.json([])),
  );
}

it('no phases: the plain bar is the first child, no phase element, only the percentage', async () => {
  serve([summary({ name: 'Senza fasi' })]);
  renderApp(<DashboardPage tab="projects" />);
  await screen.findByText('Senza fasi');
  const row = document.querySelector('.tile-progress') as HTMLElement;
  expect(row.firstElementChild?.classList.contains('progress')).toBe(true);
  expect(row.querySelector('.tile-phase')).toBeNull();
  expect(row.querySelector('.tile-pct')?.textContent).toBe('0%');
  expect(row.children).toHaveLength(2);
});

it('all done (no current phase): no dangling separator, percentage 100%', async () => {
  serve([
    summary({
      name: 'Finito',
      progress: { done: 2, total: 2, ratio: 1 },
      phaseProgress: [{ id: 1, title: 'Unica', progress: { done: 2, total: 2, ratio: 1 } }],
      currentPhase: null,
    }),
  ]);
  renderApp(<DashboardPage tab="projects" />);
  await screen.findByText('Finito');
  const row = document.querySelector('.tile-progress') as HTMLElement;
  expect(row.firstElementChild?.classList.contains('segprogress')).toBe(true);
  expect(row.textContent).not.toContain('·');
  expect(row.querySelector('.tile-pct')?.textContent).toBe('100%');
});
