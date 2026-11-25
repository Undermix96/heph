// @vitest-environment happy-dom
// Independent verification round 2, phase 4 group C fixes: proxy error pages, diary
// search opening closed days. Fake API (MSW), invented data only.
import type { DiaryEntryView } from '@heph/schema';
import { act, cleanup, renderHook, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { HttpResponse, http } from 'msw';
import { setupServer } from 'msw/node';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { ApiError, api, NETWORK_ERROR } from './api/client.js';
import { makeQueryClient } from './api/queries.js';
import { setOffline, useOffline } from './app/online.js';
import { DiaryView } from './features/diary/DiaryView.js';
import { renderApp } from './test/render.js';

const html = (status: number) =>
  new HttpResponse('<html><body>Bad gateway (invented)</body></html>', {
    status,
    headers: { 'content-type': 'text/html' },
  });

const entry = (id: number, day: number, body: string): DiaryEntryView => ({
  id,
  projectId: 1,
  type: 'note',
  eventKind: null,
  body,
  data: null,
  source: 'ui',
  sessionId: null,
  occurredAt: new Date(Date.UTC(2026, 10, day, 12)).toISOString(),
  files: [],
});
// Ten days, newest first; days 3 and 2 start closed (only 7 open).
const DIARY = Array.from({ length: 10 }, (_, i) => entry(100 - i, 20 - i, `Giorno ${20 - i}`));
DIARY[8] = { ...DIARY[8]!, body: 'Trapano a colonna (inventato)' };
DIARY[9] = { ...DIARY[9]!, body: 'Trapano a mano (inventato)' };

const server = setupServer(
  http.get('/api/projects', () => HttpResponse.json([])),
  http.get('/api/projects/:ref/diary/months', () =>
    HttpResponse.json([{ month: '2026-11', count: 10 }]),
  ),
  http.get('/api/projects/:ref/diary', () => HttpResponse.json(DIARY)),
);
beforeAll(() => server.listen({ onUnhandledFrame: 'error' }));
afterEach(() => {
  cleanup();
  server.resetHandlers();
  setOffline(false);
});
afterAll(() => server.close());

async function codeOf(p: Promise<unknown>): Promise<{ status: number; code: string }> {
  try {
    await p;
  } catch (e) {
    if (e instanceof ApiError) return { status: e.status, code: e.code };
    throw e;
  }
  throw new Error('no error');
}

describe('verifyC2: proxy error pages', () => {
  it('HTML 502, 503, 504, 520, 524 and 530 count as server not answering', async () => {
    for (const s of [502, 503, 504, 520, 524, 530]) {
      server.use(http.get('/api/projects', () => html(s)));
      expect((await codeOf(api.projects())).code, String(s)).toBe(NETWORK_ERROR);
    }
  });

  it('a JSON API error with 503 keeps its own code; HTML 500 and 531 are not network', async () => {
    server.use(
      http.get('/api/projects', () =>
        HttpResponse.json({ error: { code: 'github_unavailable', message: 'x' } }, { status: 503 }),
      ),
    );
    expect(await codeOf(api.projects())).toEqual({
      status: 503,
      code: 'github_unavailable',
    });
    server.use(http.get('/api/projects', () => html(500)));
    expect((await codeOf(api.projects())).code).toBe('http');
    server.use(http.get('/api/projects', () => html(531)));
    expect((await codeOf(api.projects())).code).toBe('http');
  });

  // Uploading a photo while the server is down behind the tunnel is normal use.
  it('a file upload answered by a proxy 502 HTML page is also server not answering', async () => {
    server.use(http.post('/api/projects/:ref/files', () => html(502)));
    const f = new File([new Uint8Array([1, 2, 3])], 'foto.png', {
      type: 'image/png',
    });
    expect((await codeOf(api.uploadFiles('banco', [f]))).code).toBe(NETWORK_ERROR);
  });

  it('the notice set by a failed query clears after a successful save', async () => {
    const client = makeQueryClient();
    setOffline(true);
    const hook = renderHook(() => useOffline());
    expect(hook.result.current).toBe(true);
    server.use(http.post('/api/projects', () => HttpResponse.json({ id: 1 }, { status: 201 })));
    await act(async () => {
      await client
        .getMutationCache()
        .build(client, {
          mutationFn: () => api.createProject({ name: 'x' } as never),
        })
        .execute(undefined);
    });
    expect(hook.result.current).toBe(false);
  });
});

describe('verifyC2: diary search', () => {
  it('opens closed days with matches, and clearing keeps them open without crashing', async () => {
    const user = userEvent.setup();
    renderApp(<DiaryView projectRef="banco" />);
    expect(await screen.findByText('Giorno 20')).toBeTruthy();
    expect(screen.queryByText('Trapano a mano (inventato)')).toBeNull();
    const box = screen.getByRole('searchbox');
    await user.type(box, 'trapano');
    expect(await screen.findByText('Trapano a mano (inventato)')).toBeTruthy();
    expect(screen.getByText('Trapano a colonna (inventato)')).toBeTruthy();
    await user.clear(box);
    expect(await screen.findByText('Giorno 20')).toBeTruthy();
    // The days opened by the search stay open; no loop or crash.
    await waitFor(() => expect(screen.getByText('Trapano a mano (inventato)')).toBeTruthy());
    const toggles = [...document.querySelectorAll('.day-toggle')];
    expect(toggles.length).toBe(10);
  });

  it('a day the user closes during a search stays closed while typing more', async () => {
    const user = userEvent.setup();
    renderApp(<DiaryView projectRef="banco" />);
    expect(await screen.findByText('Giorno 20')).toBeTruthy();
    const box = screen.getByRole('searchbox');
    await user.type(box, 'trapano');
    expect(await screen.findByText('Trapano a mano (inventato)')).toBeTruthy();
    const last = [...document.querySelectorAll<HTMLButtonElement>('.day-toggle')].at(-1)!;
    await user.click(last);
    expect(screen.queryByText('Trapano a mano (inventato)')).toBeNull();
    await user.type(box, ' a');
    expect(screen.queryByText('Trapano a mano (inventato)')).toBeNull();
  });
});
