// @vitest-environment happy-dom
import type { DiaryEntryView, ProjectDocsView } from '@heph/schema';
import { cleanup, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { HttpResponse, http } from 'msw';
import { setupServer } from 'msw/node';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { renderApp } from '../../test/render.js';
import { DocsTab } from '../project/DocsTab.js';
import { GitHubAlert, GitHubEventBody, GitHubSettings } from './GitHub.js';

// Invented data. Phase 6 group C: GitHub in the UI (D61-D63).
let status = {
  tokenSet: true,
  pollMinutes: 15,
  lastSyncAt: '2026-11-26T10:00:00.000Z',
  error: null as null | 'token_invalid' | 'rate_limited',
  resetAt: null as string | null,
};
let verify: Record<string, unknown> = { ok: true, login: 'invented-user', repoCount: 12 };
const syncs: string[] = [];
const patches: unknown[] = [];
const docs: ProjectDocsView = {
  projectId: 1,
  source: 'repo',
  internal: '',
  repos: [
    {
      id: 1,
      fullName: 'example/meteo',
      owner: 'example',
      name: 'meteo',
      docsPath: 'docs/DECISIONI.md',
      showCommits: true,
      docsUpdatedAt: '2026-11-26T09:00:00.000Z',
      docsOrigin: 'github',
      defaultBranch: 'main',
      lastPolledAt: '2026-11-26T10:00:00.000Z',
      lastSyncError: null,
      content: '# Decisioni\n\n## D1 — Sonno profondo\n',
      commits: [
        {
          sha: '9c01e7b0000000000000000000000000000000000',
          message: 'Docs: D1',
          author: 'Invented Dev',
          date: '2026-11-20T10:00:00.000Z',
          url: 'https://github.com/example/meteo/commit/9c01e7b',
        },
      ],
    },
  ],
};
const server = setupServer(
  http.get('/api/github/status', () => HttpResponse.json(status)),
  http.post('/api/github/verify', () => HttpResponse.json(verify)),
  http.get('/api/projects/:ref/docs', () => HttpResponse.json(docs)),
  http.post('/api/projects/:ref/github/sync', ({ params }) => {
    syncs.push(String(params.ref));
    return HttpResponse.json({ skipped: null, repos: [] });
  }),
  http.patch('/api/settings', async ({ request }) => {
    patches.push(await request.json());
    return HttpResponse.json({ githubToken: null });
  }),
);
beforeAll(() => server.listen());
afterEach(() => {
  cleanup();
  syncs.length = 0;
  patches.length = 0;
});
afterAll(() => server.close());

const commitsEntry = (count: number, shown: number): DiaryEntryView =>
  ({
    id: 1,
    projectId: 1,
    type: 'event',
    eventKind: 'commits',
    body: `${count} commits on main: last`,
    source: 'github',
    sessionId: null,
    occurredAt: '2026-11-26T08:00:00.000Z',
    files: [],
    data: {
      repo: 'example/meteo',
      branch: 'main',
      count,
      commits: Array.from({ length: shown }, (_, i) => ({
        sha: `${i}`.padStart(40, 'a'),
        message: `fix(sleep): step ${i}`,
        url: `https://github.com/example/meteo/commit/${i}`,
      })),
    },
  }) as unknown as DiaryEntryView;

describe('GitHub diary events', () => {
  it('a commit group lists short SHAs linked to GitHub, and says how many are hidden', () => {
    renderApp(<GitHubEventBody entry={commitsEntry(53, 50)} />);
    expect(screen.getByText('53 commit su main')).toBeTruthy();
    const link = screen.getAllByRole('link')[0] as HTMLAnchorElement;
    expect(link.textContent).toBe('aaaaaaa');
    expect(link.href).toBe('https://github.com/example/meteo/commit/0');
    expect(screen.getByText('…e altri 3')).toBeTruthy();
  });
});

describe('Settings > GitHub', () => {
  it('verify shows the account and repository count; remove sends null', async () => {
    const user = userEvent.setup();
    renderApp(<GitHubSettings tokenSet />);
    expect(await screen.findByText(/Ultima sincronizzazione/)).toBeTruthy();
    await user.click(screen.getByRole('button', { name: 'Verifica' }));
    expect(
      await screen.findByText('Valido · invented-user · accesso in lettura a 12 repository'),
    ).toBeTruthy();
    verify = { ok: false, error: 'unauthorized' };
    await user.click(screen.getByRole('button', { name: 'Verifica' }));
    expect(await screen.findByText(/GitHub ha rifiutato il token/)).toBeTruthy();
    await user.click(screen.getByRole('button', { name: 'Rimuovi token' }));
    await waitFor(() => expect(patches).toEqual([{ githubToken: null }]));
  });

  it('without a token it says so and offers no Verify', () => {
    renderApp(<GitHubSettings tokenSet={false} />);
    expect(screen.getByText(/Nessun token GitHub/)).toBeTruthy();
    expect(screen.queryByRole('button', { name: 'Verifica' })).toBeNull();
  });
});

describe('Dashboard alert', () => {
  it('an invalid token shows an alert with Update token', async () => {
    status = { ...status, error: 'token_invalid' };
    renderApp(<GitHubAlert />);
    expect(await screen.findByText(/il token è stato rifiutato/)).toBeTruthy();
    expect(screen.getByRole('link', { name: 'Aggiorna token' }).getAttribute('href')).toBe(
      '/settings#s-github',
    );
    status = { ...status, error: null };
  });
});

describe('Documentation tab', () => {
  it('origin, last change, Open on GitHub and Sync now', async () => {
    const user = userEvent.setup();
    renderApp(<DocsTab projectRef="meteo" />);
    expect(await screen.findByText(/Da GitHub, sincronizzata/)).toBeTruthy();
    expect(screen.getByText(/Ultima modifica: Invented Dev · commit 9c01e7b/)).toBeTruthy();
    expect((screen.getByRole('link', { name: 'Apri su GitHub' }) as HTMLAnchorElement).href).toBe(
      'https://github.com/example/meteo/blob/main/docs/DECISIONI.md',
    );
    await user.click(screen.getByRole('button', { name: 'Sincronizza ora' }));
    await waitFor(() => expect(syncs).toEqual(['meteo']));
  });

  it('without a token: notice with Set token, Sync now disabled', async () => {
    status = { ...status, tokenSet: false };
    renderApp(<DocsTab projectRef="meteo" />);
    expect(await screen.findByText(/Nessun token GitHub: la documentazione/)).toBeTruthy();
    expect(
      (screen.getByRole('button', { name: 'Sincronizza ora' }) as HTMLButtonElement).disabled,
    ).toBe(true);
    status = { ...status, tokenSet: true };
  });
});
