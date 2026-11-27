// @vitest-environment happy-dom
// Independent verification B9 of the Changes tab and revert proposals (D74, D75, D44).
import type { ChangeView, ProposalView } from '@heph/schema';
import { cleanup, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { HttpResponse, http } from 'msw';
import { setupServer } from 'msw/node';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { en } from '../../i18n/en.js';
import { it as itTexts, type MessageKey } from '../../i18n/it.js';
import { renderApp } from '../../test/render.js';
import { ProposalsView } from '../proposals/ProposalsView.js';
import { ChangesTab } from './ChangesTab.js';
import { changeText } from './describe.js';

// Invented changes.
const c = (id: number, over: Partial<ChangeView> = {}): ChangeView => ({
  id,
  projectId: 1,
  entity: 'task',
  entityId: 10 + id,
  action: 'complete',
  label: `Task ${id}`,
  fields: [],
  status: null,
  operations: null,
  source: 'ui',
  sessionId: null,
  createdAt: '2026-11-27T10:00:00.000Z',
  revertible: true,
  revertedAt: null,
  summary: `Completed task "Task ${id}"`,
  ...over,
});

const refuse = (status: number, code: string, details: unknown, message = 'RAW SERVER TEXT') =>
  HttpResponse.json({ error: { code, message, details } }, { status });

const server = setupServer();
beforeAll(() => server.listen({ onUnhandledFrame: 'error' }));
afterEach(() => {
  server.resetHandlers();
  cleanup();
});
afterAll(() => server.close());

async function openConfirm(name = 'Annulla modifica: Chiuso il task «Task 2»') {
  await userEvent.click(await screen.findByRole('button', { name }));
  return screen.getByRole('dialog');
}

describe('B9 ChangesTab: confirmation', () => {
  it('"Keep it" and Escape close the dialog without calling revert', async () => {
    let posts = 0;
    server.use(
      http.get('/api/projects/banco/changes', () => HttpResponse.json([c(2)])),
      http.post('/api/changes/2/revert', () => {
        posts++;
        return HttpResponse.json(c(2, { revertedAt: '2026-11-27T12:00:00.000Z' }));
      }),
    );
    renderApp(<ChangesTab projectRef="banco" />);
    let dialog = await openConfirm();
    await userEvent.click(within(dialog).getByRole('button', { name: "Lascia com'è" }));
    expect(screen.queryByRole('dialog')).toBeNull();
    dialog = await openConfirm();
    await userEvent.keyboard('{Escape}');
    expect(screen.queryByRole('dialog')).toBeNull();
    expect(posts).toBe(0);
  });

  it('works with the keyboard only: Tab to the button, Enter, Tab to confirm, Enter', async () => {
    let posts = 0;
    server.use(
      http.get('/api/projects/banco/changes', () => HttpResponse.json([c(2)])),
      http.post('/api/changes/2/revert', () => {
        posts++;
        return HttpResponse.json(
          c(2, { revertible: false, revertedAt: '2026-11-27T12:00:00.000Z' }),
        );
      }),
    );
    renderApp(<ChangesTab projectRef="banco" />);
    const btn = await screen.findByRole('button', {
      name: 'Annulla modifica: Chiuso il task «Task 2»',
    });
    btn.focus();
    await userEvent.keyboard('{Enter}');
    const dialog = screen.getByRole('dialog');
    const confirm = within(dialog).getByRole('button', { name: 'Annulla modifica' });
    // Focus starts inside the dialog; Tab reaches the confirm button.
    for (let i = 0; i < 5 && document.activeElement !== confirm; i++) await userEvent.tab();
    expect(document.activeElement).toBe(confirm);
    await userEvent.keyboard('{Enter}');
    await waitFor(() => expect(posts).toBe(1));
  });
});

describe('B9 ChangesTab: refusals show fixed texts, never the server message', () => {
  const cases: [string, number, string, unknown, RegExp][] = [
    ['already', 409, 'conflict', { reason: 'already_reverted' }, /già stata annullata/],
    ['gone', 409, 'conflict', { reason: 'gone' }, /non esiste più/],
    [
      'not revertible',
      400,
      'validation',
      { reason: 'not_revertible' },
      /^Questa modifica non si può annullare\.$/,
    ],
    [
      'forbidden',
      403,
      'forbidden',
      undefined,
      new RegExp(itTexts['error.forbidden' as MessageKey]?.slice(0, 15)),
    ],
    ['unknown 500', 500, 'internal', undefined, /Qualcosa è andato storto/],
  ];
  for (const [name, status, code, details, text] of cases) {
    it(name, async () => {
      server.use(
        http.get('/api/projects/banco/changes', () => HttpResponse.json([c(2)])),
        http.post('/api/changes/2/revert', () => refuse(status, code, details)),
      );
      renderApp(<ChangesTab projectRef="banco" />);
      const dialog = await openConfirm();
      await userEvent.click(within(dialog).getByRole('button', { name: 'Annulla modifica' }));
      expect(await within(dialog).findByText(text)).toBeTruthy();
      expect(screen.queryByText(/RAW SERVER TEXT/)).toBeNull();
      // The dialog stays open; no row is highlighted.
      expect(document.querySelector('.row-highlight')).toBeNull();
    });
  }

  it('a network failure shows the network text', async () => {
    server.use(
      http.get('/api/projects/banco/changes', () => HttpResponse.json([c(2)])),
      http.post('/api/changes/2/revert', () => HttpResponse.error()),
    );
    renderApp(<ChangesTab projectRef="banco" />);
    const dialog = await openConfirm();
    await userEvent.click(within(dialog).getByRole('button', { name: 'Annulla modifica' }));
    const key = 'error.network' as MessageKey;
    expect(await within(dialog).findByText(itTexts[key] as string)).toBeTruthy();
  });
});

describe('B9 ChangesTab: blocked revert and highlight', () => {
  it('BUG: a blocker that is not revertible is hidden by the default filter, so nothing is highlighted', async () => {
    // Realistic: a task added later (not revertible) blocks reverting an older move.
    const added = c(3, { action: 'create', revertible: false, summary: 'Added task "Task 3"' });
    const moved = c(2, { action: 'move', summary: 'Moved task "Task 2"' });
    server.use(
      http.get('/api/projects/banco/changes', ({ request }) => {
        const rev = new URL(request.url).searchParams.get('revertible') === 'true';
        return HttpResponse.json(rev ? [moved] : [added, moved]);
      }),
      http.post('/api/changes/2/revert', () =>
        refuse(409, 'conflict', { reason: 'blocked', blockedBy: 3 }),
      ),
      http.get('/api/changes/3', () => HttpResponse.json(added)),
    );
    renderApp(<ChangesTab projectRef="banco" />);
    const dialog = await openConfirm('Annulla modifica: Spostato il task «Task 2»');
    await userEvent.click(within(dialog).getByRole('button', { name: 'Annulla modifica' }));
    // The text says the blocker is "highlighted in the list".
    expect(await within(dialog).findByText(/evidenziata nell'elenco/)).toBeTruthy();
    await userEvent.click(within(dialog).getByRole('button', { name: "Lascia com'è" }));
    expect(document.querySelector('.row-highlight')).not.toBeNull();
  });

  it('the highlight follows the filter switch and is cleared by a later successful revert', async () => {
    let list = [c(3), c(2)];
    server.use(
      http.get('/api/projects/banco/changes', () => HttpResponse.json(list)),
      http.post('/api/changes/2/revert', () =>
        refuse(409, 'conflict', { reason: 'blocked', blockedBy: 3 }),
      ),
      http.post('/api/changes/3/revert', () => {
        list = [c(3, { revertible: false, revertedAt: '2026-11-27T12:00:00.000Z' }), c(2)];
        return HttpResponse.json(list[0]);
      }),
      http.get('/api/changes/3', () => HttpResponse.json(c(3))),
    );
    renderApp(<ChangesTab projectRef="banco" />);
    let dialog = await openConfirm();
    await userEvent.click(within(dialog).getByRole('button', { name: 'Annulla modifica' }));
    await within(dialog).findByText(/annulla prima quella/);
    await userEvent.click(within(dialog).getByRole('button', { name: "Lascia com'è" }));
    expect(screen.getByText('Chiuso il task «Task 3»').closest('tr')?.className).toContain(
      'row-highlight',
    );
    dialog = await openConfirm('Annulla modifica: Chiuso il task «Task 3»');
    await userEvent.click(within(dialog).getByRole('button', { name: 'Annulla modifica' }));
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
    await waitFor(() => expect(document.querySelector('.row-highlight')).toBeNull());
  });
});

describe('B9 ChangesTab: paging and filter', () => {
  it('no "older" button when the first page is short; exactly 50 shows it and an empty page hides it', async () => {
    const page = Array.from({ length: 50 }, (_, i) => c(100 - i));
    server.use(
      http.get('/api/projects/banco/changes', ({ request }) =>
        HttpResponse.json(new URL(request.url).searchParams.get('before') ? [] : page),
      ),
    );
    renderApp(<ChangesTab projectRef="banco" />);
    const more = await screen.findByRole('button', { name: 'Mostra modifiche più vecchie' });
    await userEvent.click(more);
    await waitFor(() =>
      expect(screen.queryByRole('button', { name: 'Mostra modifiche più vecchie' })).toBeNull(),
    );
    expect(screen.getAllByRole('row')).toHaveLength(51);
  });

  it('switching filter restarts paging without a cursor and shows not-revertible rows', async () => {
    const seen: string[] = [];
    server.use(
      http.get('/api/projects/banco/changes', ({ request }) => {
        const q = new URL(request.url).searchParams;
        seen.push(q.toString());
        return HttpResponse.json(
          q.get('revertible')
            ? [c(2)]
            : [c(3, { entity: 'file', action: 'create', revertible: false }), c(2)],
        );
      }),
    );
    renderApp(<ChangesTab projectRef="banco" />);
    await screen.findByText('Chiuso il task «Task 2»');
    await userEvent.click(screen.getByRole('button', { name: 'Tutte' }));
    expect(await screen.findByText('Non annullabile')).toBeTruthy();
    expect(seen.at(-1)).not.toContain('before');
    expect(seen.at(-1)).not.toContain('revertible');
  });
});

describe('B9 texts', () => {
  it('every changes.* key exists in both languages, en has nothing it lacks', () => {
    const itKeys = Object.keys(itTexts).filter(
      (k) => k.startsWith('changes.') || k.includes('revert'),
    );
    const enKeys = Object.keys(en).filter((k) => k.startsWith('changes.') || k.includes('revert'));
    expect(enKeys.sort()).toEqual(itKeys.sort());
  });

  it('BUG (cosmetic): a one-operation restructure reads naturally in English', () => {
    const t = (key: MessageKey, p: Record<string, string | number> = {}) =>
      (en[key] as string).replace(/\{(\w+)\}/g, (_, k) => String(p[k]));
    const txt = changeText(
      c(1, { entity: 'roadmap', action: 'restructure', label: null, operations: 1 }),
      t,
    );
    expect(txt).not.toContain('1 operations');
  });
});

describe('B9 ProposalsView: revert_change proposal', () => {
  const prop: ProposalView = {
    id: 7,
    projectId: 1,
    kind: 'revert_change',
    payload: { changeId: 42, summary: 'Completed task "Saldatura"' },
    reason: 'Completed by mistake',
    createdBy: 'claude_code',
    sessionId: 'sess-1',
    state: 'pending',
    decisionNote: null,
    decidedAt: null,
    createdAt: '2026-11-27T10:00:00.000Z',
  };

  it('shows kind, translated change text and approves it', async () => {
    let approved = 0;
    server.use(
      http.get('/api/proposals', () => HttpResponse.json([prop])),
      http.get('/api/projects', () => HttpResponse.json([])),
      http.get('/api/changes/42', () =>
        HttpResponse.json(c(42, { label: 'Saldatura', summary: 'Completed task "Saldatura"' })),
      ),
      http.post('/api/proposals/7/approve', () => {
        approved++;
        return HttpResponse.json({ ...prop, state: 'approved' });
      }),
    );
    renderApp(<ProposalsView />);
    expect(await screen.findByText(/Annullare una modifica/)).toBeTruthy();
    expect(
      await screen.findByText('Annulla la modifica #42: Chiuso il task «Saldatura»'),
    ).toBeTruthy();
    await userEvent.click(screen.getByRole('button', { name: 'Approva' }));
    await waitFor(() => expect(approved).toBe(1));
  });

  it('falls back to the stored summary when the change cannot be loaded', async () => {
    server.use(
      http.get('/api/proposals', () => HttpResponse.json([prop])),
      http.get('/api/projects', () => HttpResponse.json([])),
      http.get('/api/changes/42', () => refuse(404, 'not_found', undefined)),
    );
    renderApp(<ProposalsView />);
    expect(
      await screen.findByText('Annulla la modifica #42: Completed task "Saldatura"'),
    ).toBeTruthy();
  });

  it('BUG: approving a blocked revert shows only the generic "someone just edited" conflict text', async () => {
    server.use(
      http.get('/api/proposals', () => HttpResponse.json([prop])),
      http.get('/api/projects', () => HttpResponse.json([])),
      http.get('/api/changes/42', () => HttpResponse.json(c(42))),
      http.post('/api/proposals/7/approve', () =>
        refuse(409, 'conflict', { reason: 'blocked', blockedBy: 50 }),
      ),
    );
    renderApp(<ProposalsView />);
    await userEvent.click(await screen.findByRole('button', { name: 'Approva' }));
    expect(await screen.findByText(/Qualcuno ha appena modificato|annulla prima/i)).toBeTruthy();
    expect(screen.queryByText(/RAW SERVER TEXT/)).toBeNull();
    // Spec: a blocked revert is explained; the generic conflict text says "someone just edited".
    expect(screen.queryByText(/annulla prima/i)).toBeTruthy();
  });
});
