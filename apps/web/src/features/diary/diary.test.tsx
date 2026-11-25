// @vitest-environment happy-dom
import type { DiaryEntryView, FileView } from '@heph/schema';
import { cleanup, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { HttpResponse, http } from 'msw';
import { setupServer } from 'msw/node';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { renderApp } from '../../test/render.js';
import { DiaryView } from './DiaryView.js';

// Invented data.
const file: FileView = {
  id: 77,
  projectId: 1,
  phaseId: null,
  taskId: null,
  diaryEntryId: null,
  originalName: 'banco.jpg',
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
};
const entry = (id: number, over: Partial<DiaryEntryView> = {}): DiaryEntryView => ({
  id,
  projectId: 1,
  type: 'note',
  eventKind: null,
  body: `Nota ${id}`,
  data: null,
  source: 'ui',
  sessionId: null,
  occurredAt: '2026-11-25T10:00:00.000Z',
  files: [],
  ...over,
});

const posted: unknown[] = [];
const server = setupServer(
  http.get('/api/projects', () => HttpResponse.json([])),
  http.get('/api/projects/:ref/diary', ({ request }) => {
    const u = new URL(request.url);
    // A page of 50 so "Load earlier days" appears; the second page is short.
    if (u.searchParams.get('before')) return HttpResponse.json([entry(1, { body: 'Più vecchia' })]);
    return HttpResponse.json(
      Array.from({ length: 50 }, (_, i) =>
        entry(100 - i, {
          occurredAt: new Date(Date.UTC(2026, 10, 25, 10, 0, 50 - i)).toISOString(),
        }),
      ),
    );
  }),
  http.post('/api/projects/:ref/files', () => HttpResponse.json([file], { status: 201 })),
  http.post('/api/projects/:ref/diary', async ({ request }) => {
    posted.push(await request.json());
    return HttpResponse.json(entry(200), { status: 201 });
  }),
);
beforeAll(() => server.listen({ onUnhandledFrame: 'error' }));
afterEach(() => {
  cleanup();
  posted.length = 0;
});
afterAll(() => server.close());

describe('DiaryView', () => {
  it('publishes a note with the uploaded attachment ids and clears the editor', async () => {
    const user = userEvent.setup();
    const { container } = renderApp(<DiaryView projectRef="banco" />);
    await screen.findByText('Nota 100');
    const input = container.querySelector('input[type="file"]') as HTMLInputElement;
    await user.upload(input, new File(['x'], 'banco.jpg', { type: 'image/jpeg' }));
    expect(await screen.findByText('banco.jpg')).toBeTruthy();
    const box = screen.getByPlaceholderText('Scrivi una nota');
    await user.type(box, 'Piano in bolla');
    await user.keyboard('{Control>}{Enter}{/Control}');
    await waitFor(() => expect(posted).toEqual([{ body: 'Piano in bolla', fileIds: [77] }]));
    await waitFor(() => expect((box as HTMLTextAreaElement).value).toBe(''));
  });

  it('loads earlier days with the keyset cursor of the last entry', async () => {
    const user = userEvent.setup();
    renderApp(<DiaryView projectRef="banco" />);
    await user.click(await screen.findByRole('button', { name: 'Carica i giorni precedenti' }));
    expect(await screen.findByText('Più vecchia')).toBeTruthy();
    expect(screen.queryByRole('button', { name: 'Carica i giorni precedenti' })).toBeNull();
  });
});
