// @vitest-environment happy-dom
import type { FileView, ProjectDocsView, ProposalView } from '@heph/schema';
import { DEFAULT_SETTINGS } from '@heph/schema';
import { QueryClientProvider } from '@tanstack/react-query';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { delay, HttpResponse, http } from 'msw';
import { setupServer } from 'msw/node';
import { MemoryRouter } from 'react-router';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { makeQueryClient } from './api/queries.js';
import { NoticesProvider } from './app/notices.js';
import { DiaryView } from './features/diary/DiaryView.js';
import { DocsTab } from './features/project/DocsTab.js';
import { ProposalsView } from './features/proposals/ProposalsView.js';
import { Snippet } from './features/search/SearchPage.js';
import { SettingsPage } from './features/settings/SettingsPage.js';
import { I18nProvider } from './i18n/index.js';
import { detail, renderApp, summary } from './test/render.js';

// Independent verification round 2, phase 4 group B (fixes 2-6). Invented data.
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

let passwordStatus = 401;
let settingsStatus = 200;
let uploadDelays: number[] = [];
let uploadSeq = 0;
let proposals: ProposalView[] = [];
let docs = {
  projectId: 1,
  source: 'internal',
  internal: '# Banco',
  repos: [],
} as unknown as ProjectDocsView;
const notes: { body: string; fileIds: number[] }[] = [];
const docPatches: unknown[] = [];

const server = setupServer(
  http.get('/api/settings', () =>
    settingsStatus === 200
      ? HttpResponse.json({ ...DEFAULT_SETTINGS, githubToken: null })
      : HttpResponse.json(
          { error: { code: 'unauthorized', message: 'Authentication required' } },
          { status: settingsStatus },
        ),
  ),
  http.get('/api/projects', () =>
    HttpResponse.json([summary({ slug: 'banco', lifecycleStatus: 'completed' })]),
  ),
  http.post('/api/auth/password', () =>
    passwordStatus === 200
      ? HttpResponse.json({ ok: true })
      : HttpResponse.json(
          { error: { code: 'unauthorized', message: 'Current password is wrong' } },
          { status: passwordStatus },
        ),
  ),
  http.get('/api/projects/:ref/diary', () => HttpResponse.json([])),
  http.post('/api/projects/:ref/files', async () => {
    const n = uploadSeq++;
    await delay(uploadDelays[n] ?? 100);
    return HttpResponse.json([file(70 + n, `foto-${n}.jpg`)], { status: 201 });
  }),
  http.post('/api/projects/:ref/diary', async ({ request }) => {
    notes.push((await request.json()) as { body: string; fileIds: number[] });
    return HttpResponse.json({}, { status: 201 });
  }),
  http.get('/api/proposals', ({ request }) => {
    const state = new URL(request.url).searchParams.get('state');
    return HttpResponse.json(proposals.filter((p) => p.state === state));
  }),
  http.get('/api/projects/:ref/docs', () => HttpResponse.json(docs)),
  http.patch('/api/projects/:ref', async ({ request }) => {
    const body = (await request.json()) as { internalDocs?: string };
    docPatches.push(body);
    if (body.internalDocs !== undefined) docs = { ...docs, internal: body.internalDocs };
    return HttpResponse.json(detail([]));
  }),
);
beforeAll(() => server.listen({ onUnhandledFrame: 'error' }));
beforeEach(() => {
  passwordStatus = 401;
  settingsStatus = 200;
  uploadDelays = [];
  uploadSeq = 0;
  notes.length = 0;
  docPatches.length = 0;
});
afterEach(() => cleanup());
afterAll(() => server.close());

function renderReal(ui: React.ReactNode) {
  const client = makeQueryClient();
  client.setQueryData(['auth'], { setupDone: true, user: { id: 1, username: 'mario' } });
  render(
    <QueryClientProvider client={client}>
      <I18nProvider lang="it">
        <NoticesProvider>
          <MemoryRouter>{ui}</MemoryRouter>
        </NoticesProvider>
      </I18nProvider>
    </QueryClientProvider>,
  );
  return client;
}
const signedIn = (c: ReturnType<typeof makeQueryClient>) =>
  c.getQueryData<{ user: unknown }>(['auth'])?.user != null;

describe('verifyB2 criterion 2: change password', () => {
  async function submit(current: string) {
    const user = userEvent.setup();
    const client = renderReal(<SettingsPage />);
    await user.type(await screen.findByLabelText('Password attuale'), current);
    await user.type(screen.getByLabelText('Nuova password'), 'nuovapassword1');
    await user.type(screen.getByLabelText(/Ripeti|Conferma/), 'nuovapassword1');
    await user.click(screen.getByRole('button', { name: 'Cambia password' }));
    return client;
  }

  it('a wrong current password shows the fixed text and keeps the user signed in', async () => {
    const client = await submit('sbagliata');
    expect(await screen.findByText('La password attuale non è corretta. Riprova.')).toBeTruthy();
    expect(signedIn(client)).toBe(true);
  });

  it('the right password reports success', async () => {
    passwordStatus = 200;
    await submit('giusta123');
    expect(await screen.findByText('Password cambiata.')).toBeTruthy();
  });

  it('a real expired session (401 on another call) still returns to sign-in', async () => {
    settingsStatus = 401;
    const client = renderReal(<SettingsPage />);
    // The app's client retries a query once before failing.
    await waitFor(() => expect(signedIn(client)).toBe(false), { timeout: 5000 });
  });
});

describe('verifyB2 criterion 3: search snippets', () => {
  const text = (html: string) => {
    const { container } = render(<Snippet html={html} />);
    return container;
  };

  it('decodes decimal, hex and named entities and keeps only <mark>', () => {
    const c = text(
      'a &#38; b &#x3C;c&#x3e; &lt;d&gt; &quot;e&quot; &#39;f&#39; <mark>g</mark> &#60;b&#62;h&#60;/b&#62; &#x1F600;',
    );
    expect(c.textContent).toBe('a & b <c> <d> "e" \'f\' g <b>h</b> 😀');
    expect(c.querySelectorAll('mark')).toHaveLength(1);
    expect(c.querySelectorAll('b')).toHaveLength(0);
  });

  it('a note that literally says "&lt;" shows "&lt;", not "<" (server sends &#38;lt;)', () => {
    // The server escapes "&" as "&#38;" (packages/core/src/search.ts), so "&lt;" arrives as
    // "&#38;lt;". Decoding it twice turns the user's text into "<".
    const c = text('usa <mark>entity</mark> &#38;lt; e &#38;amp; in HTML');
    expect(c.textContent).toBe('usa entity &lt; e &amp; in HTML');
  });
});

describe('verifyB2 criterion 4: attachments still uploading', () => {
  async function setupDiary() {
    const user = userEvent.setup();
    const r = renderApp(<DiaryView projectRef="banco" />);
    const box = await screen.findByLabelText('Scrivi una nota', { selector: 'textarea' });
    await user.type(box, 'Montate le gambe');
    return { user, box, container: r.container };
  }

  it('Publish button and Ctrl+Enter do nothing while uploading; the note then carries the id', async () => {
    uploadDelays = [300];
    const { user, box, container } = await setupDiary();
    const input = container.querySelector('input[type=file]') as HTMLInputElement;
    await user.upload(input, new File(['x'], 'a.jpg', { type: 'image/jpeg' }));
    const publish = screen.getByRole('button', { name: 'Pubblica' }) as HTMLButtonElement;
    expect(publish.disabled).toBe(true);
    await user.click(publish);
    await user.click(box);
    await user.keyboard('{Control>}{Enter}{/Control}');
    expect(notes).toHaveLength(0);
    await waitFor(() => expect(publish.disabled).toBe(false), { timeout: 2000 });
    await user.keyboard('{Control>}{Enter}{/Control}');
    await waitFor(() => expect(notes).toHaveLength(1));
    expect(notes[0]?.fileIds).toEqual([70]);
  });

  const drop = (box: HTMLElement, name: string) =>
    fireEvent.drop(box, {
      dataTransfer: { files: [new File(['x'], name, { type: 'image/jpeg' })] },
    });

  it('Ctrl+Enter waits while a second dropped photo is still uploading', async () => {
    uploadDelays = [100, 600];
    const { user, box } = await setupDiary();
    drop(box, 'a.jpg');
    drop(box, 'b.jpg');
    // The first upload is done, the second is still running.
    await new Promise((r) => setTimeout(r, 300));
    await user.click(box);
    await user.keyboard('{Control>}{Enter}{/Control}');
    expect(notes).toHaveLength(0);
  });

  it('two photos dropped one after the other both become chips', async () => {
    uploadDelays = [100, 300];
    const { box } = await setupDiary();
    drop(box, 'a.jpg');
    drop(box, 'b.jpg');
    await new Promise((r) => setTimeout(r, 600));
    const chips = screen
      .queryAllByRole('button', { name: /foto-\d\.jpg/ })
      .map((b) => b.getAttribute('aria-label'));
    expect(chips.sort()).toEqual(['Togli foto-0.jpg', 'Togli foto-1.jpg']);
  });
});

describe('verifyB2 criterion 5: empty text', () => {
  it('internal docs can be saved empty and the empty text is sent', async () => {
    const user = userEvent.setup();
    renderApp(<DocsTab projectRef="banco" />);
    await user.click(await screen.findByRole('button', { name: 'Modifica' }));
    const box = screen.getByLabelText('Documentazione interna', { selector: 'textarea' });
    await user.clear(box);
    await user.keyboard('{Control>}{Enter}{/Control}');
    await waitFor(() => expect(docPatches).toEqual([{ internalDocs: '' }]));
  });

  it('a diary note refuses an empty or blank text (button and Ctrl+Enter)', async () => {
    const user = userEvent.setup();
    renderApp(<DiaryView projectRef="banco" />);
    const box = await screen.findByLabelText('Scrivi una nota', { selector: 'textarea' });
    await user.type(box, '   ');
    const publish = screen.getByRole('button', { name: 'Pubblica' }) as HTMLButtonElement;
    expect(publish.disabled).toBe(true);
    await user.keyboard('{Control>}{Enter}{/Control}');
    await new Promise((r) => setTimeout(r, 50));
    expect(notes).toHaveLength(0);
  });
});

describe('verifyB2 criterion 6: status proposals', () => {
  const base = {
    projectId: 1,
    createdBy: 'claude_code',
    reason: 'Tutti i task sono fatti',
    createdAt: '2026-11-25T09:00:00.000Z',
    kind: 'set_status',
  } as const;
  const p = (id: number, state: string, payload: Record<string, unknown>) =>
    ({
      ...base,
      id,
      state,
      payload,
      decidedAt: state === 'pending' ? null : '2026-11-25T10:00:00.000Z',
      decisionNote: null,
    }) as unknown as ProposalView;

  async function line(state: 'pending' | 'approved') {
    const user = userEvent.setup();
    renderApp(<ProposalsView />);
    if (state === 'approved') {
      await user.click(
        await screen
          .findByRole('radio', { name: 'Approvate' })
          .catch(() => screen.findByRole('button', { name: 'Approvate' })),
      );
    }
    return (await screen.findByText(/Stato:/)).textContent;
  }

  it('pending with from shows the stored status', async () => {
    proposals = [p(1, 'pending', { status: 'completed', note: '', from: 'on_hold' })];
    expect(await line('pending')).toBe('Stato: In pausa → Completato');
  });

  it('approved with from shows the stored status', async () => {
    proposals = [p(2, 'approved', { status: 'completed', note: '', from: 'awaiting_manual_test' })];
    expect(await line('approved')).toBe('Stato: In attesa del mio test → Completato');
  });

  it('old pending without from shows the current status', async () => {
    proposals = [p(3, 'pending', { status: 'abandoned', note: '' })];
    expect(await line('pending')).toBe('Stato: Completato → Abbandonato');
  });

  it('old approved without from shows a dash', async () => {
    proposals = [p(4, 'approved', { status: 'completed', note: '' })];
    expect(await line('approved')).toBe('Stato: — → Completato');
  });
});
