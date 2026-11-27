// @vitest-environment happy-dom
import type { ChangeView } from '@heph/schema';
import { cleanup, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { HttpResponse, http } from 'msw';
import { setupServer } from 'msw/node';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { en } from '../../i18n/en.js';
import { it as itTexts, type MessageKey } from '../../i18n/it.js';
import { renderApp } from '../../test/render.js';
import { ChangesTab } from './ChangesTab.js';
import { changeText, refusalOf } from './describe.js';

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

const tIt = (key: MessageKey, params: Record<string, string | number> = {}) =>
  (itTexts[key] as string).replace(/\{(\w+)\}/g, (_, k) => String(params[k] ?? `{${k}}`));

describe('changeText', () => {
  it('translates known kinds with label, fields, status and operation count', () => {
    expect(changeText(c(1), tIt)).toBe('Chiuso il task «Task 1»');
    expect(changeText(c(2, { action: 'update', fields: ['title', 'notes'] }), tIt)).toBe(
      'Modificato il task «Task 2» (titolo, note)',
    );
    expect(
      changeText(
        c(3, {
          entity: 'project',
          action: 'set_status',
          label: null,
          status: { from: 'in_development', to: 'on_hold' },
        }),
        tIt,
      ),
    ).toBe('Stato: In sviluppo → In pausa');
    expect(changeText(c(4, { entity: 'project', action: 'set_next_task', label: null }), tIt)).toBe(
      'Prossimo passo tolto',
    );
    expect(
      changeText(
        c(5, { entity: 'roadmap', action: 'restructure', label: null, operations: 3 }),
        tIt,
      ),
    ).toBe('Roadmap riorganizzata (3 operazioni)');
  });

  it('falls back to #id without a label and to the server summary for unknown kinds', () => {
    expect(changeText(c(6, { label: null }), tIt)).toBe('Chiuso il task «#16»');
    expect(changeText(c(7, { entity: 'settings', action: 'update', summary: 'raw' }), tIt)).toBe(
      'raw',
    );
  });

  it('every known kind has a text in both languages', () => {
    for (const k of Object.keys(itTexts).filter((x) => x.startsWith('changes.'))) {
      expect(en[k as MessageKey], k).toBeTruthy();
    }
  });
});

describe('refusalOf', () => {
  it('reads the server reason', () => {
    expect(refusalOf({ reason: 'blocked', blockedBy: 9 })).toEqual({
      kind: 'blocked',
      blockedBy: 9,
    });
    expect(refusalOf({ reason: 'already_reverted' })).toEqual({ kind: 'already' });
    expect(refusalOf({ reason: 'gone' })).toEqual({ kind: 'gone' });
    expect(refusalOf(undefined)).toEqual({ kind: 'other' });
  });
});

const server = setupServer();
beforeAll(() => server.listen({ onUnhandledFrame: 'error' }));
afterEach(() => {
  server.resetHandlers();
  cleanup();
});
afterAll(() => server.close());

describe('ChangesTab', () => {
  it('lists revertible changes by default and reverts one after confirming', async () => {
    let list = [c(2), c(1, { revertible: false, revertedAt: '2026-11-27T11:00:00.000Z' })];
    const seen: string[] = [];
    server.use(
      http.get('/api/projects/banco/changes', ({ request }) => {
        seen.push(new URL(request.url).search);
        return HttpResponse.json(list);
      }),
      http.post('/api/changes/2/revert', () => {
        list = [c(2, { revertible: false, revertedAt: '2026-11-27T12:00:00.000Z' }), list[1]!];
        return HttpResponse.json(list[0]);
      }),
    );
    renderApp(<ChangesTab projectRef="banco" />);
    expect(await screen.findByText('Chiuso il task «Task 2»')).toBeTruthy();
    expect(seen[0]).toContain('revertible=true');
    // The undone one shows its state, no button.
    const rows = screen.getAllByRole('row');
    expect(within(rows[2]!).getByText(/Annullata/)).toBeTruthy();

    await userEvent.click(
      screen.getByRole('button', { name: 'Annulla modifica: Chiuso il task «Task 2»' }),
    );
    const dialog = screen.getByRole('dialog');
    expect(within(dialog).getByText('Annullare questa modifica?')).toBeTruthy();
    await userEvent.click(within(dialog).getByRole('button', { name: 'Annulla modifica' }));
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
    expect(await screen.findByText('Modifica annullata.')).toBeTruthy();
    await waitFor(() =>
      expect(screen.queryAllByRole('button', { name: /Annulla modifica:/ })).toHaveLength(0),
    );
  });

  it('a blocked revert names the later change and highlights it', async () => {
    server.use(
      http.get('/api/projects/banco/changes', () => HttpResponse.json([c(3), c(2)])),
      http.post('/api/changes/2/revert', () =>
        HttpResponse.json(
          {
            error: {
              code: 'conflict',
              message: 'Revert change 3 first',
              details: { reason: 'blocked', blockedBy: 3 },
            },
          },
          { status: 409 },
        ),
      ),
      http.get('/api/changes/3', () => HttpResponse.json(c(3))),
    );
    renderApp(<ChangesTab projectRef="banco" />);
    await userEvent.click(
      await screen.findByRole('button', { name: 'Annulla modifica: Chiuso il task «Task 2»' }),
    );
    const dialog = screen.getByRole('dialog');
    await userEvent.click(within(dialog).getByRole('button', { name: 'Annulla modifica' }));
    expect(
      await within(dialog).findByText(/annulla prima quella \(#3, «Chiuso il task «Task 3»»\)/),
    ).toBeTruthy();
    // No generic error notice on top of the dialog's explanation.
    expect(screen.queryByText(/Qualcuno ha appena modificato/)).toBeNull();
    const row3 = screen.getByText('Chiuso il task «Task 3»').closest('tr')!;
    expect(row3.className).toContain('row-highlight');
  });

  it('switching to "All" asks without the filter; an empty list explains what appears', async () => {
    const seen: string[] = [];
    server.use(
      http.get('/api/projects/banco/changes', ({ request }) => {
        seen.push(new URL(request.url).search);
        return HttpResponse.json([]);
      }),
    );
    renderApp(<ChangesTab projectRef="banco" />);
    expect(await screen.findByText('Nessuna modifica da mostrare')).toBeTruthy();
    await userEvent.click(screen.getByRole('button', { name: 'Tutte' }));
    await waitFor(() => expect(seen.some((s) => !s.includes('revertible'))).toBe(true));
  });

  it('loads older changes with the last id as cursor', async () => {
    const page = Array.from({ length: 50 }, (_, i) => c(200 - i));
    const seen: string[] = [];
    server.use(
      http.get('/api/projects/banco/changes', ({ request }) => {
        const q = new URL(request.url).searchParams;
        seen.push(q.get('before') ?? '');
        return HttpResponse.json(q.get('before') ? [c(5)] : page);
      }),
    );
    renderApp(<ChangesTab projectRef="banco" />);
    await userEvent.click(
      await screen.findByRole('button', { name: 'Mostra modifiche più vecchie' }),
    );
    expect(await screen.findByText('Chiuso il task «Task 5»')).toBeTruthy();
    expect(seen).toEqual(['', '151']);
  });
});
