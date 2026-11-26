// @vitest-environment happy-dom
import type { DiaryEntryView, ProjectDocsView } from '@heph/schema';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { cleanup, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { HttpResponse, http } from 'msw';
import { setupServer } from 'msw/node';
import { MemoryRouter } from 'react-router';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { NoticesProvider } from './app/notices.js';
import { groupDiary } from './features/diary/group.js';
import { GitHubEventBody } from './features/github/GitHub.js';
import { DocsTab } from './features/project/DocsTab.js';
import { I18nProvider } from './i18n/index.js';
import { renderApp } from './test/render.js';

// Independent verification, phase 6 group C (D44, D61-D63). Invented data.

let syncReply: Record<string, unknown> = { skipped: null, repos: [], status: { error: null } };
let status = {
  tokenSet: true,
  pollMinutes: 15,
  lastSyncAt: '2026-11-26T10:00:00.000Z',
  error: null as null | 'token_invalid' | 'rate_limited',
  resetAt: null as string | null,
};
const repo = (over: Record<string, unknown> = {}) => ({
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
  content: '# Decisioni (invented)\n',
  commits: [],
  ...over,
});
let docs: ProjectDocsView = {
  projectId: 1,
  source: 'repo',
  internal: '',
  repos: [repo()],
} as unknown as ProjectDocsView;

const server = setupServer(
  http.get('/api/github/status', () => HttpResponse.json(status)),
  http.get('/api/projects/:ref/docs', () => HttpResponse.json(docs)),
  http.post('/api/projects/:ref/github/sync', () => HttpResponse.json(syncReply)),
);
beforeAll(() => server.listen());
afterEach(() => {
  cleanup();
  syncReply = { skipped: null, repos: [], status: { error: null } };
  status = { ...status, error: null, tokenSet: true };
  docs = { ...docs, repos: [repo()] } as unknown as ProjectDocsView;
});
afterAll(() => server.close());

function renderEn(ui: React.ReactNode) {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false, refetchInterval: false }, mutations: { retry: 0 } },
  });
  return render(
    <QueryClientProvider client={client}>
      <I18nProvider lang="en">
        <NoticesProvider>
          <MemoryRouter>{ui}</MemoryRouter>
        </NoticesProvider>
      </I18nProvider>
    </QueryClientProvider>,
  );
}

const commitsEvent = (
  id: number,
  occurredAt: string,
  shas: string[],
  over: Partial<DiaryEntryView> = {},
  repoName = 'example/meteo',
  day = occurredAt.slice(0, 10),
): DiaryEntryView =>
  ({
    id,
    projectId: 1,
    type: 'event',
    eventKind: 'commits',
    body: `${shas.length} commits on main`,
    source: 'github',
    sessionId: null,
    occurredAt,
    files: [],
    data: {
      repo: repoName,
      branch: 'main',
      day,
      count: shas.length,
      commits: shas.map((s) => ({
        sha: s.padEnd(40, '0'),
        message: `msg ${s}`,
        url: `https://github.com/${repoName}/commit/${s}`,
      })),
    },
    ...over,
  }) as unknown as DiaryEntryView;

const note = (id: number, occurredAt: string): DiaryEntryView =>
  ({
    id,
    projectId: 1,
    type: 'note',
    eventKind: null,
    body: 'invented note',
    source: 'claude_code',
    sessionId: 'sess-1',
    occurredAt,
    files: [],
    data: null,
  }) as unknown as DiaryEntryView;

describe('verifyC6: Sync now outcome (D44: fixed text with an action)', () => {
  it('a Sync now that hits a refused token does not say "Synced with GitHub"', async () => {
    const user = userEvent.setup();
    syncReply = {
      skipped: null,
      repos: [],
      status: { error: 'token_invalid', lastSyncAt: null, resetAt: null },
    };
    renderEn(<DocsTab projectRef="meteo" />);
    await user.click(await screen.findByRole('button', { name: 'Sync now' }));
    await waitFor(() => expect(document.querySelector('.notices')?.textContent ?? '').not.toBe(''));
    expect(screen.queryByText('Synced with GitHub.')).toBeNull();
    expect(screen.getByText(/token was refused/)).toBeTruthy();
  });

  it('a Sync now that hits the rate limit midway does not say "Synced with GitHub"', async () => {
    const user = userEvent.setup();
    syncReply = {
      skipped: null,
      repos: [],
      status: { error: 'rate_limited', lastSyncAt: null, resetAt: '2026-11-26T11:00:00.000Z' },
    };
    renderEn(<DocsTab projectRef="meteo" />);
    await user.click(await screen.findByRole('button', { name: 'Sync now' }));
    await waitFor(() => expect(document.querySelector('.notices')?.textContent ?? '').not.toBe(''));
    expect(screen.queryByText('Synced with GitHub.')).toBeNull();
  });

  it('a Sync now whose repo failed does not say "Synced with GitHub"', async () => {
    const user = userEvent.setup();
    syncReply = {
      skipped: null,
      repos: [
        {
          repo: 'example/meteo',
          commitEvents: 0,
          releaseEvents: 0,
          docsUpdated: false,
          error: 'unavailable',
        },
      ],
      status: { error: null, lastSyncAt: '2026-11-26T10:00:00.000Z', resetAt: null },
    };
    renderEn(<DocsTab projectRef="meteo" />);
    await user.click(await screen.findByRole('button', { name: 'Sync now' }));
    await waitFor(() => expect(document.querySelector('.notices')?.textContent ?? '').not.toBe(''));
    expect(screen.queryByText('Synced with GitHub.')).toBeNull();
  });

  it('the rate-limit notice is a complete sentence (no dangling "sync resumes")', async () => {
    const user = userEvent.setup();
    syncReply = { skipped: 'rate_limited', repos: [] };
    renderEn(<DocsTab projectRef="meteo" />);
    await user.click(await screen.findByRole('button', { name: 'Sync now' }));
    await waitFor(() =>
      expect(document.querySelector('.notices')?.textContent ?? '').toMatch(/limiting/),
    );
    expect(document.querySelector('.notices')?.textContent?.trim()).not.toMatch(/resumes$/);
  });
});

describe('verifyC6: Documentation tab details', () => {
  it('a repo error shows its fixed text next to the docs (D44)', async () => {
    docs = {
      ...docs,
      repos: [repo({ lastSyncError: 'not_found' })],
    } as unknown as ProjectDocsView;
    renderEn(<DocsTab projectRef="meteo" />);
    expect(await screen.findByText(/Repository not found or the token has no access/)).toBeTruthy();
  });

  it('local copy from the hook says so (origin hook)', async () => {
    docs = { ...docs, repos: [repo({ docsOrigin: 'hook' })] } as unknown as ProjectDocsView;
    renderEn(<DocsTab projectRef="meteo" />);
    expect(await screen.findByText(/Local copy from Claude Code/)).toBeTruthy();
  });
});

describe('verifyC6: commit event body', () => {
  it('one commit reads "1 commit" in English', () => {
    renderEn(<GitHubEventBody entry={commitsEvent(1, '2026-11-26T08:00:00.000Z', ['abc1234'])} />);
    expect(screen.getByText(/^1 commit on main$/)).toBeTruthy();
  });

  it('Italian: one commit', () => {
    renderApp(<GitHubEventBody entry={commitsEvent(1, '2026-11-26T08:00:00.000Z', ['abc1234'])} />);
    expect(screen.getByText('1 commit su main')).toBeTruthy();
  });
});

describe('verifyC6: one box per repo and day (owner decision 2026-11-26)', () => {
  it('two syncs of the same day merge, newest commits first, counts added', () => {
    const days = groupDiary([
      commitsEvent(2, '2026-11-26T15:00:00', ['c3']),
      commitsEvent(1, '2026-11-26T10:00:00', ['c2', 'c1']),
    ]);
    expect(days).toHaveLength(1);
    expect(days[0]?.items).toHaveLength(1);
    const it0 = days[0]?.items[0];
    expect(it0?.kind).toBe('entry');
    if (it0?.kind === 'entry') {
      expect(it0.entry.data?.count).toBe(3);
      expect(
        ((it0.entry.data?.commits ?? []) as { sha: string }[]).map((c) => c.sha.slice(0, 2)),
      ).toEqual(['c3', 'c2', 'c1']);
    }
  });

  it('two repos on the same day stay separate', () => {
    const days = groupDiary([
      commitsEvent(2, '2026-11-26T15:00:00', ['a1'], {}, 'example/a'),
      commitsEvent(1, '2026-11-26T10:00:00', ['b1'], {}, 'example/b'),
    ]);
    expect(days[0]?.items).toHaveLength(2);
  });

  it('a note logged between two pushes of the same day still gives one box for that repo+day', () => {
    // Normal use: push, Claude Code logs progress, push again, each sync adds its own event.
    const days = groupDiary([
      commitsEvent(3, '2026-11-26T15:00:00', ['c3']),
      note(2, '2026-11-26T12:00:00'),
      commitsEvent(1, '2026-11-26T10:00:00', ['c2', 'c1']),
    ]);
    const boxes = days[0]?.items.filter(
      (i) => i.kind === 'entry' && i.entry.eventKind === 'commits',
    );
    expect(boxes).toHaveLength(1);
  });

  it('two repos interleaved on the same day give one box per repo', () => {
    const days = groupDiary([
      commitsEvent(4, '2026-11-26T16:00:00', ['a2'], {}, 'example/a'),
      commitsEvent(3, '2026-11-26T15:00:00', ['b2'], {}, 'example/b'),
      commitsEvent(2, '2026-11-26T11:00:00', ['a1'], {}, 'example/a'),
      commitsEvent(1, '2026-11-26T10:00:00', ['b1'], {}, 'example/b'),
    ]);
    expect(days[0]?.items).toHaveLength(2);
  });

  it('grouping does not mutate the input entries (refetch shows the same counts)', () => {
    const a = commitsEvent(2, '2026-11-26T15:00:00', ['c3']);
    const b = commitsEvent(1, '2026-11-26T10:00:00', ['c2']);
    groupDiary([a, b]);
    const again = groupDiary([a, b]);
    const it0 = again[0]?.items[0];
    expect(it0?.kind === 'entry' && it0.entry.data?.count).toBe(2);
    expect(a.data?.count).toBe(1);
  });
});
