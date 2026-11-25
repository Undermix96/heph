// @vitest-environment happy-dom
import type { FileView } from '@heph/schema';
import { DEFAULT_SETTINGS } from '@heph/schema';
import { act, cleanup, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { HttpResponse, http } from 'msw';
import { setupServer } from 'msw/node';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { FilesTab } from './features/project/FilesTab.js';
import { renderApp } from './test/render.js';

// Independent verification round 2, phase 4 group B (file viewer fixes). Invented data.
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
const patches: { id: number; body: unknown }[] = [];
const server = setupServer(
  http.get('/api/projects/:ref/files', () => HttpResponse.json(files)),
  http.get('/api/settings', () => HttpResponse.json(DEFAULT_SETTINGS)),
  http.get('/api/projects', () => HttpResponse.json([])),
  http.patch('/api/files/:id', async ({ request, params }) => {
    const body = (await request.json()) as { pinned?: boolean };
    patches.push({ id: Number(params.id), body });
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
  patches.length = 0;
});
afterEach(() => cleanup());
afterAll(() => server.close());

function section(title: string) {
  return screen.getByRole('heading', { name: title }).closest('section') as HTMLElement;
}

async function setup() {
  const user = userEvent.setup();
  const r = renderApp(<FilesTab projectRef="banco" />);
  await screen.findByRole('heading', { name: 'Tutti i file' });
  const refetch = () =>
    act(async () => {
      await r.client.refetchQueries({ queryKey: ['files', 'banco'] });
    });
  return { user, refetch };
}

async function openIn(user: ReturnType<typeof userEvent.setup>, box: string, name: string) {
  const card = within(section(box)).getByRole('button', { name: new RegExp(name) });
  await user.click(card);
  return { card, dialog: await screen.findByRole('dialog') };
}

const meta = (d: HTMLElement) => d.querySelector('.viewer-side p.meta')?.textContent;
const title = (d: HTMLElement) => within(d).getByRole('heading', { level: 2 }).textContent;

describe('verifyB2 viewer: criterion 1 (positive)', () => {
  it('first focus on Chiudi, Esc closes, focus returns to the opener', async () => {
    const { user } = await setup();
    const { card, dialog } = await openIn(user, 'Tutti i file', 'foto-2.jpg');
    expect(document.activeElement).toBe(within(dialog).getByRole('button', { name: 'Chiudi' }));
    await user.keyboard('{Escape}');
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
    expect(document.activeElement).toBe(card);
  });

  it('arrow keys move and stop at the ends', async () => {
    const { user } = await setup();
    const { dialog } = await openIn(user, 'Tutti i file', 'foto-1.jpg');
    await user.keyboard('{ArrowLeft}');
    expect(title(dialog)).toBe('foto-1.jpg');
    await user.keyboard('{ArrowRight}{ArrowRight}{ArrowRight}');
    expect(title(dialog)).toBe('foto-3.jpg');
    await user.keyboard('{ArrowLeft}');
    expect(title(dialog)).toBe('foto-2.jpg');
  });

  it('Tab and Shift+Tab wrap inside the dialog', async () => {
    const { user } = await setup();
    const { dialog } = await openIn(user, 'Tutti i file', 'foto-2.jpg');
    for (let k = 0; k < 15; k++) {
      await user.tab();
      expect(dialog.contains(document.activeElement)).toBe(true);
    }
    for (let k = 0; k < 15; k++) {
      await user.tab({ shift: true });
      expect(dialog.contains(document.activeElement)).toBe(true);
    }
  });

  it('Pin flips at once and sends true, then Unpin sends false', async () => {
    const { user } = await setup();
    const { dialog } = await openIn(user, 'Tutti i file', 'foto-2.jpg');
    await user.click(within(dialog).getByRole('button', { name: /Fissa/ }));
    await within(dialog).findByRole('button', { name: /Togli da fissati/ });
    await user.click(within(dialog).getByRole('button', { name: /Togli da fissati/ }));
    await within(dialog).findByRole('button', { name: /^.*Fissa$/ });
    expect(patches).toEqual([
      { id: 2, body: { pinned: true } },
      { id: 2, body: { pinned: false } },
    ]);
  });

  it('delete the last shows the previous; deleting the only one closes', async () => {
    files = [f(1), f(2)];
    const { user } = await setup();
    const { dialog } = await openIn(user, 'Tutti i file', 'foto-2.jpg');
    await user.click(within(dialog).getByRole('button', { name: /Elimina/ }));
    await user.click(within(dialog).getByRole('button', { name: 'Elimina davvero' }));
    await waitFor(() => expect(title(dialog)).toBe('foto-1.jpg'));
    await user.click(within(dialog).getByRole('button', { name: /Elimina/ }));
    await user.click(within(dialog).getByRole('button', { name: 'Elimina davvero' }));
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
  });

  it('a refetch that adds and removes other files keeps the current file', async () => {
    const { user, refetch } = await setup();
    const { dialog } = await openIn(user, 'Tutti i file', 'foto-2.jpg');
    files = [f(9), f(8), f(7), f(2)];
    await refetch();
    expect(title(dialog)).toBe('foto-2.jpg');
    await waitFor(() => expect(meta(dialog)).toBe('4 / 4'));
  });
});

describe('verifyB2 viewer: findings', () => {
  it('after unpinning the only pinned file, opening another file shows the clicked file', async () => {
    files = [f(1), f(2, { pinned: true }), f(3)];
    const { user } = await setup();
    const first = await openIn(user, 'Fissati', 'foto-2.jpg');
    await user.click(within(first.dialog).getByRole('button', { name: /Togli da fissati/ }));
    // The file leaves the pinned list: the viewer disappears from the screen.
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
    await waitFor(() => expect(screen.queryByRole('heading', { name: 'Fissati' })).toBeNull());
    // The user now opens foto-3 from "Tutti i file".
    await user.click(within(section('Tutti i file')).getByRole('button', { name: /foto-3.jpg/ }));
    const dialog = await screen.findByRole('dialog');
    expect(title(dialog)).toBe('foto-3.jpg');
  });

  it('a pin change made elsewhere (Claude Code) shows after a refetch', async () => {
    const { user, refetch } = await setup();
    const { dialog } = await openIn(user, 'Tutti i file', 'foto-2.jpg');
    await user.click(within(dialog).getByRole('button', { name: /Fissa/ }));
    await within(dialog).findByRole('button', { name: /Togli da fissati/ });
    // Claude Code unpins the same file; the list is refetched.
    files = [...files.map((x) => (x.id === 2 ? { ...x, pinned: false } : x)), f(4)];
    await refetch();
    await waitFor(() => expect(meta(dialog)).toBe('2 / 4'));
    expect(within(dialog).getByRole('button', { name: /^.*Fissa$/ })).toBeTruthy();
  });

  it('when the current file leaves the list, a later refetch keeps the file now shown', async () => {
    files = [f(1, { pinned: true }), f(2, { pinned: true }), f(3, { pinned: true })];
    const { user, refetch } = await setup();
    const { dialog } = await openIn(user, 'Fissati', 'foto-2.jpg');
    await user.click(within(dialog).getByRole('button', { name: /Togli da fissati/ }));
    await waitFor(() => expect(title(dialog)).toBe('foto-3.jpg'));
    // Claude Code pins another file that sorts first.
    files = [f(4, { pinned: true }), ...files];
    await refetch();
    await waitFor(() => expect(meta(dialog)).toMatch(/\/ 3$/));
    expect(title(dialog)).toBe('foto-3.jpg');
  });

  it('keyboard Delete keeps the focus inside the dialog', async () => {
    const { user } = await setup();
    const { dialog } = await openIn(user, 'Tutti i file', 'foto-2.jpg');
    within(dialog)
      .getByRole('button', { name: /Elimina/ })
      .focus();
    await user.keyboard('{Enter}');
    await within(dialog).findByRole('button', { name: 'Elimina davvero' });
    expect(dialog.contains(document.activeElement)).toBe(true);
  });
});
