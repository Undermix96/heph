// @vitest-environment happy-dom
import type { FileView } from '@heph/schema';
import { cleanup, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { HttpResponse, http } from 'msw';
import { setupServer } from 'msw/node';
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { renderApp } from '../test/render.js';
import { Viewer } from './viewer.js';

// Invented files.
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

const calls: { method: string; path: string; body: unknown }[] = [];
const server = setupServer(
  http.patch('/api/files/:id', async ({ request, params }) => {
    calls.push({ method: 'PATCH', path: `/files/${params.id}`, body: await request.json() });
    return HttpResponse.json(f(Number(params.id), { pinned: true }));
  }),
  http.delete('/api/files/:id', ({ params }) => {
    calls.push({ method: 'DELETE', path: `/files/${params.id}`, body: null });
    return new HttpResponse(null, { status: 204 });
  }),
  http.get('/api/projects', () => HttpResponse.json([])),
);
beforeAll(() => server.listen({ onUnhandledFrame: 'error' }));
afterEach(() => {
  cleanup();
  calls.length = 0;
});
afterAll(() => server.close());

describe('Viewer', () => {
  it('moves with the arrow keys, stops at the ends and closes on Esc', async () => {
    const user = userEvent.setup();
    const onClose = vi.fn();
    renderApp(
      <Viewer files={[f(1), f(2), f(3)]} start={1} onClose={onClose} onChanged={() => {}} />,
    );
    expect(screen.getByRole('heading', { name: 'foto-2.jpg' })).toBeTruthy();
    await user.keyboard('{ArrowRight}{ArrowRight}');
    expect(screen.getByRole('heading', { name: 'foto-3.jpg' })).toBeTruthy();
    await user.keyboard('{ArrowLeft}{ArrowLeft}{ArrowLeft}');
    expect(screen.getByRole('heading', { name: 'foto-1.jpg' })).toBeTruthy();
    await user.keyboard('{Escape}');
    expect(onClose).toHaveBeenCalled();
  });

  it('pins, and deletes only after a second confirmation', async () => {
    const user = userEvent.setup();
    const onChanged = vi.fn();
    renderApp(<Viewer files={[f(1), f(2)]} start={0} onClose={() => {}} onChanged={onChanged} />);
    await user.click(screen.getByRole('button', { name: /Fissa/ }));
    await waitFor(() =>
      expect(calls).toEqual([{ method: 'PATCH', path: '/files/1', body: { pinned: true } }]),
    );
    await user.click(screen.getByRole('button', { name: /Elimina$/ }));
    expect(calls).toHaveLength(1);
    await user.click(screen.getByRole('button', { name: 'Elimina davvero' }));
    await waitFor(() =>
      expect(calls.at(-1)).toEqual({ method: 'DELETE', path: '/files/1', body: null }),
    );
    await waitFor(() => expect(onChanged).toHaveBeenCalledTimes(2));
  });
});
