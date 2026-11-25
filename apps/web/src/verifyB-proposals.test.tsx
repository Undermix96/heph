// @vitest-environment happy-dom
import type { ProposalView } from '@heph/schema';
import { cleanup, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { HttpResponse, http } from 'msw';
import { setupServer } from 'msw/node';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { ProposalsView } from './features/proposals/ProposalsView.js';
import { renderApp, summary } from './test/render.js';

// Independent verification, phase 4 group B (proposals). Invented data.
const base = {
  projectId: 1,
  createdBy: 'claude_code',
  reason: 'Il task è un doppione',
  createdAt: '2026-11-25T09:00:00.000Z',
  decidedAt: null,
  decisionNote: null,
} as const;
let list: ProposalView[] = [];
const calls: { path: string; body: unknown }[] = [];
const server = setupServer(
  // The project is now completed: the approved proposal moved it there.
  http.get('/api/projects', () =>
    HttpResponse.json([summary({ lifecycleStatus: 'completed', slug: 'banco' })]),
  ),
  http.get('/api/proposals', ({ request }) => {
    const state = new URL(request.url).searchParams.get('state');
    return HttpResponse.json(list.filter((p) => p.state === state));
  }),
  http.post('/api/proposals/:id/:action', async ({ request, params }) => {
    const body = await request.json();
    calls.push({ path: `/proposals/${params.id}/${params.action}`, body });
    return HttpResponse.json(list[0]);
  }),
);
beforeAll(() => server.listen({ onUnhandledFrame: 'error' }));
afterEach(() => {
  cleanup();
  calls.length = 0;
});
afterAll(() => server.close());

describe('verifyB proposals', () => {
  it('reject sends the note to the reject route', async () => {
    list = [
      {
        ...base,
        id: 4,
        kind: 'delete_task',
        payload: { taskId: 12, title: 'Comprare viti' },
        state: 'pending',
      } as unknown as ProposalView,
    ];
    const user = userEvent.setup();
    renderApp(<ProposalsView />);
    expect(await screen.findByText(/#12 Comprare viti/)).toBeTruthy();
    await user.type(screen.getByLabelText('Nota per Claude'), 'Serve ancora, è per le gambe');
    await user.click(screen.getByRole('button', { name: 'Rifiuta' }));
    await waitFor(() =>
      expect(calls).toEqual([
        { path: '/proposals/4/reject', body: { note: 'Serve ancora, è per le gambe' } },
      ]),
    );
  });

  it('an approved status change shows the status it came from, not the current one', async () => {
    list = [
      {
        ...base,
        id: 5,
        kind: 'set_status',
        payload: { status: 'completed', note: '' },
        state: 'approved',
        decidedAt: '2026-11-25T10:00:00.000Z',
      } as unknown as ProposalView,
    ];
    const user = userEvent.setup();
    renderApp(<ProposalsView />);
    await user.click(
      await screen
        .findByRole('radio', { name: 'Approvate' })
        .catch(() => screen.findByRole('button', { name: 'Approvate' })),
    );
    const line = await screen.findByText(/Stato:/);
    // "Completato → Completato" says nothing about what changed.
    expect(line.textContent).not.toMatch(/Completat\w+ → Completat\w+/);
  });
});
