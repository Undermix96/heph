import type { PhaseView, ProjectDetail, ProjectSummary, TaskView } from '@heph/schema';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { render } from '@testing-library/react';
import type { ReactNode } from 'react';
import { MemoryRouter } from 'react-router';
import { NoticesProvider } from '../app/notices.js';
import { I18nProvider } from '../i18n/index.js';

/** Renders with the app providers: Italian texts, no polling, no retries. */
export function renderApp(ui: ReactNode, { path = '/' }: { path?: string } = {}) {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false, refetchInterval: false }, mutations: { retry: 0 } },
  });
  return {
    client,
    ...render(
      <QueryClientProvider client={client}>
        <I18nProvider lang="it">
          <NoticesProvider>
            <MemoryRouter initialEntries={[path]}>{ui}</MemoryRouter>
          </NoticesProvider>
        </I18nProvider>
      </QueryClientProvider>,
    ),
  };
}

// ------------------------------------------------------------ invented fixtures

const T0 = '2026-11-25T08:00:00.000Z';

export function task(
  id: number,
  phaseId: number,
  position: number,
  over: Partial<TaskView> = {},
): TaskView {
  return {
    id,
    phaseId,
    projectId: 1,
    title: `Task ${id}`,
    notes: '',
    position,
    done: false,
    doneAt: null,
    link: null,
    createdAt: T0,
    updatedAt: T0,
    ...over,
  };
}

export function phase(
  id: number,
  position: number,
  tasks: TaskView[],
  over: Partial<PhaseView> = {},
): PhaseView {
  const done = tasks.filter((t) => t.done).length;
  return {
    id,
    projectId: 1,
    title: `Phase ${id}`,
    description: '',
    position,
    status: 'todo',
    completedAt: null,
    progress: { done, total: tasks.length, ratio: tasks.length ? done / tasks.length : 0 },
    tasks,
    createdAt: T0,
    updatedAt: T0,
    ...over,
  };
}

export function summary(over: Partial<ProjectSummary> = {}): ProjectSummary {
  return {
    id: 1,
    slug: 'banco',
    name: 'Banco da lavoro',
    description: '',
    tags: [],
    lifecycleStatus: 'in_development',
    statusNote: '',
    statusChangedAt: T0,
    coverFileId: null,
    progress: { done: 0, total: 0, ratio: 0 },
    phaseProgress: [],
    currentPhase: null,
    nextTask: null,
    lastActivityAt: T0,
    activityState: 'recently_active',
    badge: { kind: 'recently_active' },
    attentionGroup: 4,
    pendingProposals: 0,
    repos: [],
    createdAt: T0,
    updatedAt: T0,
    ...over,
  };
}

export function detail(phases: PhaseView[], over: Partial<ProjectDetail> = {}): ProjectDetail {
  const first = phases.flatMap((p) => p.tasks).find((t) => !t.done);
  return {
    ...summary(),
    nextTask: first
      ? {
          id: first.id,
          title: first.title,
          phaseId: first.phaseId,
          phaseTitle: 'Phase',
          overridden: false,
        }
      : null,
    docsSource: 'internal',
    internalDocs: '',
    claudeWriteEnabled: true,
    origin: null,
    links: [],
    repoDetails: [],
    phases,
    liveSessions: [],
    ...over,
  };
}
