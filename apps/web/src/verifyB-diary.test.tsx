// @vitest-environment happy-dom
import type { DiaryEntryView, FileView } from '@heph/schema';
import { cleanup, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { delay, HttpResponse, http } from 'msw';
import { setupServer } from 'msw/node';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { DiaryView } from './features/diary/DiaryView.js';
import { groupDiary } from './features/diary/group.js';
import { renderApp } from './test/render.js';

// Independent verification, phase 4 group B (diary). Invented data.
const file: FileView = {
  id: 7,
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
const entry = (id: number, over: Partial<DiaryEntryView> = {}): DiaryEntryView =>
  ({
    id,
    projectId: 1,
    type: 'note',
    eventKind: null,
    body: `Nota ${id}`,
    data: null,
    source: 'ui',
    sessionId: null,
    origin: null,
    files: [],
    occurredAt: '2026-11-25T10:00:00.000Z',
    createdAt: '2026-11-25T10:00:00.000Z',
    ...over,
  }) as DiaryEntryView;

const notes: unknown[] = [];
const diaryQueries: string[] = [];
const server = setupServer(
  http.get('/api/projects', () => HttpResponse.json([])),
  http.get('/api/projects/:ref/diary', ({ request }) => {
    diaryQueries.push(new URL(request.url).search);
    return HttpResponse.json([]);
  }),
  http.post('/api/projects/:ref/files', async () => {
    await delay(300);
    return HttpResponse.json([file], { status: 201 });
  }),
  http.post('/api/projects/:ref/diary', async ({ request }) => {
    notes.push(await request.json());
    return HttpResponse.json(entry(1), { status: 201 });
  }),
);
beforeAll(() => server.listen({ onUnhandledFrame: 'error' }));
afterEach(() => {
  cleanup();
  notes.length = 0;
  diaryQueries.length = 0;
});
afterAll(() => server.close());

describe('verifyB diary note composer', () => {
  it('Ctrl+Enter while the photo is still uploading does not publish the note without it', async () => {
    const user = userEvent.setup();
    const { container } = renderApp(<DiaryView projectRef="banco" />);
    const box = await screen.findByLabelText('Scrivi una nota', { selector: 'textarea' });
    await user.type(box, 'Montate le gambe del banco');
    const input = container.querySelector('input[type=file]') as HTMLInputElement;
    await user.upload(input, new File(['x'], 'banco.jpg', { type: 'image/jpeg' }));
    // The Publish button is disabled while uploading; the shortcut should be too.
    await user.click(box);
    await user.keyboard('{Control>}{Enter}{/Control}');
    await waitFor(() => expect(screen.queryByText('Caricamento…')).toBeNull(), { timeout: 2000 });
    await new Promise((r) => setTimeout(r, 50));
    for (const n of notes) expect((n as { fileIds: number[] }).fileIds).toContain(7);
  });
});

describe('verifyB diary grouping invariants', () => {
  it('keeps every entry exactly once, newest first, and never mixes days or sessions', () => {
    const list: DiaryEntryView[] = [];
    let id = 100;
    // A realistic day: UI note, a Claude session of 4 entries, an event, another session.
    const at = (h: number, m: number) =>
      `2026-11-24T${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}:00.000Z`;
    list.push(entry(id--, { occurredAt: at(18, 0) }));
    for (let i = 0; i < 4; i++)
      list.push(
        entry(id--, { source: 'claude_code', sessionId: 's1', occurredAt: at(17, 50 - i) }),
      );
    list.push(entry(id--, { type: 'event', eventKind: 'task_completed', occurredAt: at(15, 0) }));
    list.push(entry(id--, { source: 'claude_code', sessionId: 's2', occurredAt: at(12, 0) }));
    list.push(entry(id--, { source: 'claude_code', sessionId: 's2', occurredAt: at(11, 0) }));
    list.push(entry(id--, { source: 'claude_code', sessionId: 's3', occurredAt: at(10, 0) }));
    const days = groupDiary(list);
    const flat = days.flatMap((d) =>
      d.items.flatMap((it) => (it.kind === 'entry' ? [it.entry] : it.entries)),
    );
    expect(flat.map((e) => e.id)).toEqual(list.map((e) => e.id));
    for (const d of days)
      for (const it of d.items)
        if (it.kind === 'session') {
          expect(new Set(it.entries.map((e) => e.sessionId)).size).toBe(1);
          expect(it.entries.length).toBeGreaterThan(1);
          expect(it.start <= it.end).toBe(true);
        }
    const sessions = days.flatMap((d) => d.items).filter((it) => it.kind === 'session');
    expect(sessions.map((s) => s.kind === 'session' && s.sessionId)).toEqual(['s1', 's2']);
  });
});
