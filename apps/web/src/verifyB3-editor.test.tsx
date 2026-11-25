// @vitest-environment happy-dom
import type { FileView } from '@heph/schema';
import { DEFAULT_SETTINGS } from '@heph/schema';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { delay, HttpResponse, http } from 'msw';
import { setupServer } from 'msw/node';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { DiaryView } from './features/diary/DiaryView.js';
import { Snippet } from './features/search/SearchPage.js';
import { renderApp, summary } from './test/render.js';

// Independent verification round 3, phase 4 group B (uploads, snippets). Invented data.
const file = (id: number, name: string): FileView => ({
  id,
  projectId: 1,
  phaseId: null,
  taskId: null,
  diaryEntryId: null,
  originalName: name,
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
});

let uploadDelays: number[] = [];
let uploadFail: number[] = [];
let uploadSeq = 0;
const notes: { body: string; fileIds: number[] }[] = [];
const server = setupServer(
  http.get('/api/settings', () => HttpResponse.json(DEFAULT_SETTINGS)),
  http.get('/api/projects', () => HttpResponse.json([summary({ slug: 'banco' })])),
  http.get('/api/projects/:ref/diary', () => HttpResponse.json([])),
  http.post('/api/projects/:ref/files', async () => {
    const n = uploadSeq++;
    await delay(uploadDelays[n] ?? 50);
    if (uploadFail.includes(n)) {
      return HttpResponse.json(
        { error: { code: 'internal', message: 'disk full' } },
        { status: 500 },
      );
    }
    return HttpResponse.json([file(70 + n, `foto-${n}.jpg`)], { status: 201 });
  }),
  http.post('/api/projects/:ref/diary', async ({ request }) => {
    notes.push((await request.json()) as { body: string; fileIds: number[] });
    return HttpResponse.json({}, { status: 201 });
  }),
);
beforeAll(() => server.listen({ onUnhandledFrame: 'error' }));
beforeEach(() => {
  uploadDelays = [];
  uploadFail = [];
  uploadSeq = 0;
  notes.length = 0;
});
afterEach(() => cleanup());
afterAll(() => server.close());

async function setupDiary() {
  const user = userEvent.setup();
  const r = renderApp(<DiaryView projectRef="banco" />);
  const box = await screen.findByLabelText('Scrivi una nota', { selector: 'textarea' });
  await user.type(box, 'Montate le gambe');
  const input = r.container.querySelector('input[type=file]') as HTMLInputElement;
  const publish = screen.getByRole('button', { name: 'Pubblica' }) as HTMLButtonElement;
  return { user, box, input, publish };
}
const drop = (box: HTMLElement, name: string) =>
  fireEvent.drop(box, { dataTransfer: { files: [new File(['x'], name, { type: 'image/jpeg' })] } });
const chips = () =>
  screen.queryAllByRole('button', { name: /^Togli / }).map((b) => b.getAttribute('aria-label'));

describe('verifyB3 editor uploads', () => {
  it('chips appear in order of completion (second drop finishes first)', async () => {
    uploadDelays = [500, 100];
    const { box, publish } = await setupDiary();
    drop(box, 'a.jpg');
    drop(box, 'b.jpg');
    await waitFor(() => expect(chips()).toEqual(['Togli foto-1.jpg']));
    expect(publish.disabled).toBe(true);
    await waitFor(() => expect(chips()).toEqual(['Togli foto-1.jpg', 'Togli foto-0.jpg']));
    expect(publish.disabled).toBe(false);
  });

  it('drop then the file input: both uploads end up as chips and publish carries both', async () => {
    uploadDelays = [300, 100];
    const { user, box, input, publish } = await setupDiary();
    drop(box, 'a.jpg');
    await user.upload(input, new File(['x'], 'b.jpg', { type: 'image/jpeg' }));
    await waitFor(() => expect(chips()).toHaveLength(2), { timeout: 2000 });
    await waitFor(() => expect(publish.disabled).toBe(false));
    await user.click(publish);
    await waitFor(() => expect(notes).toHaveLength(1));
    expect(notes[0]?.fileIds).toEqual([71, 70]);
  });

  it('a failed upload shows the fixed error and does not block publishing', async () => {
    uploadDelays = [100, 300];
    uploadFail = [1];
    const { user, box, publish } = await setupDiary();
    drop(box, 'a.jpg');
    drop(box, 'b.jpg');
    const alert = await screen.findByRole('alert', {}, { timeout: 2000 });
    expect(alert.textContent).toContain('Qualcosa è andato storto. Riprova tra poco.');
    expect(alert.textContent).not.toContain('disk full');
    await waitFor(() => expect(publish.disabled).toBe(false));
    expect(chips()).toEqual(['Togli foto-0.jpg']);
    await user.click(box);
    await user.keyboard('{Control>}{Enter}{/Control}');
    await waitFor(() => expect(notes).toHaveLength(1));
    expect(notes[0]?.fileIds).toEqual([70]);
  });

  it('removing a chip while another upload runs keeps the other result', async () => {
    uploadDelays = [50, 500];
    const { user, box, publish } = await setupDiary();
    drop(box, 'a.jpg');
    drop(box, 'b.jpg');
    await waitFor(() => expect(chips()).toEqual(['Togli foto-0.jpg']));
    await user.click(screen.getByRole('button', { name: 'Togli foto-0.jpg' }));
    expect(chips()).toEqual([]);
    await waitFor(() => expect(chips()).toEqual(['Togli foto-1.jpg']), { timeout: 2000 });
    await waitFor(() => expect(publish.disabled).toBe(false));
    await user.click(publish);
    await waitFor(() => expect(notes).toHaveLength(1));
    expect(notes[0]?.fileIds).toEqual([71]);
  });
});

describe('verifyB3 search snippets', () => {
  const text = (html: string) => render(<Snippet html={html} />).container;

  it('decodes each entity exactly once, also uppercase hex', () => {
    const c = text('&#38;#60; &#38;#x3C; &#X3C;x&#X3E; &#38;&#35;38; &#38;quot;');
    expect(c.textContent).toBe('&#60; &#x3C; <x> &#38; &quot;');
  });

  it('unknown named entities stay as written; only <mark> becomes an element', () => {
    const c = text('&nbsp; &copy; &foo; <mark>&#60;mark&#62;x&#60;/mark&#62;</mark> &#60;i&#62;');
    expect(c.textContent).toBe('&nbsp; &copy; &foo; <mark>x</mark> <i>');
    expect(c.querySelectorAll('mark')).toHaveLength(1);
    expect(c.querySelectorAll('i')).toHaveLength(0);
  });
});
