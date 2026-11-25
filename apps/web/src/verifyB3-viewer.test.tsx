// @vitest-environment happy-dom
import type { FileView } from '@heph/schema';
import { DEFAULT_SETTINGS } from '@heph/schema';
import { act, cleanup, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { HttpResponse, http } from 'msw';
import { setupServer } from 'msw/node';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { FilesTab } from './features/project/FilesTab.js';
import { renderApp } from './test/render.js';

// Independent verification round 3, phase 4 group B (viewer). Invented data.
const f = (id: number, over: Partial<FileView> = {}): FileView => ({
  id,
  projectId: 1,
  phaseId: null,
  taskId: null,
  diaryEntryId: null,
  originalName: `foto-${id}.jpg`,
  mime: 'image/jpeg',
  size: 10,
  width: 10,
  height: 10,
  hasThumbnail: true,
  caption: null,
  pinned: false,
  source: 'ui',
  sessionId: null,
  createdAt: '2026-11-25T10:00:00.000Z',
  ...over,
});

let files: FileView[] = [];
let gets = 0;
const server = setupServer(
  http.get('/api/projects/:ref/files', () => {
    gets++;
    return HttpResponse.json(files);
  }),
  http.get('/api/settings', () => HttpResponse.json(DEFAULT_SETTINGS)),
  http.get('/api/projects', () => HttpResponse.json([])),
  http.patch('/api/files/:id', async ({ request, params }) => {
    const body = (await request.json()) as { pinned?: boolean };
    files = files.map((x) => (x.id === Number(params.id) ? { ...x, ...body } : x));
    return HttpResponse.json(files.find((x) => x.id === Number(params.id)));
  }),
  http.delete('/api/files/:id', ({ params }) => {
    files = files.filter((x) => x.id !== Number(params.id));
    return new HttpResponse(null, { status: 204 });
  }),
);
let errors: { mock: { calls: unknown[][] }; mockRestore: () => void };
beforeAll(() => server.listen({ onUnhandledFrame: 'error' }));
beforeEach(() => {
  files = [f(1), f(2), f(3), f(4)];
  gets = 0;
  errors = vi.spyOn(console, 'error');
});
afterEach(() => {
  const loops = errors.mock.calls.filter((c) => String(c[0]).includes('Maximum update depth'));
  errors.mockRestore();
  cleanup();
  expect(loops).toHaveLength(0);
});
afterAll(() => server.close());

const section = (name: string) =>
  screen.getByRole('heading', { name }).closest('section') as HTMLElement;
const meta = (d: HTMLElement) => d.querySelector('.viewer-side p.meta')?.textContent;
const title = (d: HTMLElement) => within(d).getByRole('heading', { level: 2 }).textContent;

async function setup() {
  const user = userEvent.setup();
  const r = renderApp(<FilesTab projectRef="banco" />);
  await screen.findByRole('heading', { name: 'Tutti i file' });
  const refetch = () =>
    act(async () => {
      await r.client.refetchQueries({ queryKey: ['files', 'banco'] });
    });
  const open = async (box: string, name: string) => {
    await user.click(within(section(box)).getByRole('button', { name: new RegExp(name) }));
    return screen.findByRole('dialog');
  };
  return { user, refetch, open };
}

describe('verifyB3 viewer', () => {
  it('Claude Code removes the shown file: next, then previous at the end, then closes', async () => {
    const { refetch, open } = await setup();
    const d = await open('Tutti i file', 'foto-3.jpg');
    files = files.filter((x) => x.id !== 3);
    await refetch();
    await waitFor(() => expect(title(d)).toBe('foto-4.jpg'));
    expect(meta(d)).toBe('3 / 3');
    // foto-4 is the last one: removing it shows the previous one.
    files = files.filter((x) => x.id !== 4);
    await refetch();
    await waitFor(() => expect(title(d)).toBe('foto-2.jpg'));
    expect(meta(d)).toBe('2 / 2');
    // A file added before it does not move the viewer off foto-2 (followed by id).
    files = [f(9), ...files];
    await refetch();
    await waitFor(() => expect(meta(d)).toBe('3 / 3'));
    expect(title(d)).toBe('foto-2.jpg');
    files = [];
    await refetch();
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
  });

  it('after the list emptied and the viewer closed, a new open shows the clicked file', async () => {
    const { refetch, open } = await setup();
    await open('Tutti i file', 'foto-1.jpg');
    files = [];
    await refetch();
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
    files = [f(5), f(6), f(7)];
    await refetch();
    await screen.findByRole('button', { name: /foto-6.jpg/ });
    const d = await open('Tutti i file', 'foto-7.jpg');
    expect(title(d)).toBe('foto-7.jpg');
    expect(meta(d)).toBe('3 / 3');
  });

  it('unpinning in Pinned follows the next file and arrows work from there', async () => {
    files = [f(1, { pinned: true }), f(2, { pinned: true }), f(3, { pinned: true })];
    const { user, open } = await setup();
    const d = await open('Fissati', 'foto-1.jpg');
    await user.click(within(d).getByRole('button', { name: /Togli da fissati/ }));
    await waitFor(() => expect(title(d)).toBe('foto-2.jpg'));
    expect(meta(d)).toBe('1 / 2');
    await user.keyboard('{ArrowRight}');
    expect(title(d)).toBe('foto-3.jpg');
    await user.keyboard('{ArrowLeft}{ArrowLeft}');
    expect(title(d)).toBe('foto-2.jpg');
    await user.keyboard('{Escape}');
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
  });

  it('local pin shows at once, then a refetched state from Claude Code wins', async () => {
    const { user, refetch, open } = await setup();
    const d = await open('Tutti i file', 'foto-1.jpg');
    await user.click(within(d).getByRole('button', { name: /Fissa/ }));
    await within(d).findByRole('button', { name: /Togli da fissati/ });
    // Moving away and back keeps the pinned state.
    await user.keyboard('{ArrowRight}{ArrowLeft}');
    expect(within(d).getByRole('button', { name: /Togli da fissati/ })).toBeTruthy();
    files = files.map((x) => (x.id === 1 ? { ...x, pinned: false } : x));
    await refetch();
    await waitFor(() =>
      expect(within(d).queryByRole('button', { name: /Togli da fissati/ })).toBeNull(),
    );
  });

  it('Cancel puts focus on Delete; a confirmed delete puts it on Chiudi', async () => {
    const { user, open } = await setup();
    const d = await open('Tutti i file', 'foto-2.jpg');
    await user.click(within(d).getByRole('button', { name: /Elimina/ }));
    const confirm = await within(d).findByRole('button', { name: 'Elimina davvero' });
    await waitFor(() => expect(document.activeElement).toBe(confirm));
    await user.click(within(d).getByRole('button', { name: 'Annulla' }));
    await waitFor(() =>
      expect(document.activeElement).toBe(within(d).getByRole('button', { name: /Elimina/ })),
    );
    await user.keyboard('{Enter}');
    await within(d).findByRole('button', { name: 'Elimina davvero' });
    await user.keyboard('{Enter}');
    await waitFor(() => expect(title(d)).toBe('foto-3.jpg'));
    expect(document.activeElement).toBe(within(d).getByRole('button', { name: 'Chiudi' }));
    // Tab still stays inside after the delete.
    for (let k = 0; k < 8; k++) {
      await user.tab();
      expect(d.contains(document.activeElement)).toBe(true);
    }
  });

  it('no repeated requests while the viewer is open and idle', async () => {
    const { user, open } = await setup();
    const d = await open('Tutti i file', 'foto-2.jpg');
    await user.click(within(d).getByRole('button', { name: /Fissa/ }));
    await within(d).findByRole('button', { name: /Togli da fissati/ });
    await new Promise((r) => setTimeout(r, 200));
    const after = gets;
    await new Promise((r) => setTimeout(r, 400));
    expect(gets).toBe(after);
    expect(after).toBeLessThanOrEqual(3);
  });
});
