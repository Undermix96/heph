// @vitest-environment happy-dom
import type { FileView } from '@heph/schema';
import { DEFAULT_SETTINGS } from '@heph/schema';
import { cleanup, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { HttpResponse, http } from 'msw';
import { setupServer } from 'msw/node';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { FilesTab } from './features/project/FilesTab.js';
import { renderApp } from './test/render.js';

// Independent verification, phase 4 group B (files tab + viewer). Invented data.
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
const server = setupServer(
  http.get('/api/projects/:ref/files', () => HttpResponse.json(files)),
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
beforeAll(() => server.listen({ onUnhandledFrame: 'error' }));
beforeEach(() => {
  files = [f(1), f(2), f(3)];
});
afterEach(() => cleanup());
afterAll(() => server.close());

async function openViewerOn(name: string) {
  const user = userEvent.setup();
  renderApp(<FilesTab projectRef="banco" />);
  const all = await screen.findByRole('heading', { name: 'Tutti i file' });
  const box = all.closest('section, div.box') as HTMLElement;
  const cards = within(box ?? document.body).getAllByRole('button', { name: new RegExp(name) });
  await user.click(cards[0] as HTMLElement);
  await screen.findByRole('dialog');
  return user;
}

describe('verifyB FilesTab viewer', () => {
  it('Pin in the viewer flips to "Togli da fissati" once the server has pinned the file', async () => {
    const user = await openViewerOn('foto-2.jpg');
    const dialog = screen.getByRole('dialog');
    await user.click(within(dialog).getByRole('button', { name: /Fissa/ }));
    await waitFor(() => expect(files.find((x) => x.id === 2)?.pinned).toBe(true));
    // The file is pinned on the server: the viewer must offer to unpin it.
    await waitFor(
      () => expect(within(dialog).getByRole('button', { name: /Togli da fissati/ })).toBeTruthy(),
      { timeout: 2000 },
    );
  });

  it('after deleting the middle file the viewer does not keep showing the deleted file', async () => {
    const user = await openViewerOn('foto-2.jpg');
    const dialog = screen.getByRole('dialog');
    expect(within(dialog).getByRole('heading', { name: 'foto-2.jpg' })).toBeTruthy();
    await user.click(within(dialog).getByRole('button', { name: /Elimina/ }));
    await user.click(within(dialog).getByRole('button', { name: 'Elimina davvero' }));
    await waitFor(() => expect(files.map((x) => x.id)).toEqual([1, 3]));
    await waitFor(
      () => {
        const d = screen.queryByRole('dialog');
        if (d) expect(within(d).queryByRole('heading', { name: 'foto-2.jpg' })).toBeNull();
      },
      { timeout: 2000 },
    );
  });
});
