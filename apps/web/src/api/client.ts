import type {
  AddTaskInput,
  CreateProjectInput,
  DiaryEntryView,
  PhaseView,
  ProjectDetail,
  ProjectSummary,
  ProposalView,
  Settings,
  TaskView,
} from '@heph/schema';

/** Error from the REST API: `code` drives the fixed UI text (D44), never `message`. */
export class ApiError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
  ) {
    super(message);
  }
}

/** Network failure (server unreachable): its own code for a fixed UI text. */
export const NETWORK_ERROR = 'network';

async function request<T>(method: string, path: string, body?: unknown): Promise<T> {
  let res: Response;
  try {
    res = await fetch(`/api${path}`, {
      method,
      credentials: 'same-origin',
      headers: body === undefined ? {} : { 'content-type': 'application/json' },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
  } catch {
    throw new ApiError(0, NETWORK_ERROR, 'Network error');
  }
  const data = res.status === 204 ? null : await res.json().catch(() => null);
  if (!res.ok) {
    throw new ApiError(
      res.status,
      data?.error?.code ?? 'http',
      data?.error?.message ?? res.statusText,
    );
  }
  return data as T;
}

export interface User {
  id: number;
  username: string;
}

/** A change that may come back as a proposal instead (graduated trust). */
export type MaybeProposal<T> = T | { proposal: ProposalView };

export function isProposal<T>(r: MaybeProposal<T>): r is { proposal: ProposalView } {
  return typeof r === 'object' && r !== null && 'proposal' in r;
}

export const api = {
  // auth
  status: () => request<{ setupDone: boolean; user: User | null }>('GET', '/auth/status'),
  setup: (username: string, password: string) =>
    request<{ user: User; apiToken: string }>('POST', '/setup', { username, password }),
  login: (username: string, password: string) =>
    request<{ user: User }>('POST', '/auth/login', { username, password }),
  logout: () => request<null>('POST', '/auth/logout'),

  // settings
  settings: () => request<Settings>('GET', '/settings'),
  updateSettings: (patch: Partial<Settings>) => request<Settings>('PATCH', '/settings', patch),

  // projects
  projects: (includeClosed = true) =>
    request<ProjectSummary[]>('GET', `/projects${includeClosed ? '?includeClosed=true' : ''}`),
  project: (ref: string | number) => request<ProjectDetail>('GET', `/projects/${ref}`),
  createProject: (input: CreateProjectInput) => request<ProjectDetail>('POST', '/projects', input),
  tags: () => request<{ name: string; count: number }[]>('GET', '/tags'),
  setStatus: (ref: string | number, input: { status: string; note?: string }) =>
    request<MaybeProposal<ProjectDetail>>('POST', `/projects/${ref}/status`, input),
  testOutcome: (ref: string | number, input: { passed: boolean; notes?: string }) =>
    request<ProjectDetail>('POST', `/projects/${ref}/test-outcome`, input),
  setNextTask: (ref: string | number, taskId: number | null) =>
    request<unknown>('PUT', `/projects/${ref}/next-task`, { taskId }),

  // roadmap
  addPhase: (ref: string | number, input: { title: string; position?: number }) =>
    request<PhaseView>('POST', `/projects/${ref}/phases`, input),
  updatePhase: (id: number, input: { title?: string; description?: string; status?: string }) =>
    request<PhaseView>('PATCH', `/phases/${id}`, input),
  movePhase: (id: number, position: number) =>
    request<unknown>('POST', `/phases/${id}/move`, { position }),
  deletePhase: (id: number) => request<MaybeProposal<null>>('DELETE', `/phases/${id}`),
  addTask: (phaseId: number, input: AddTaskInput) =>
    request<TaskView>('POST', `/phases/${phaseId}/tasks`, input),
  updateTask: (id: number, input: { title?: string; notes?: string }) =>
    request<TaskView>('PATCH', `/tasks/${id}`, input),
  moveTask: (id: number, position: number, phaseId?: number) =>
    request<unknown>('POST', `/tasks/${id}/move`, { position, phaseId }),
  completeTask: (id: number) => request<unknown>('POST', `/tasks/${id}/complete`),
  reopenTask: (id: number) => request<unknown>('POST', `/tasks/${id}/reopen`),
  deleteTask: (id: number) => request<MaybeProposal<null>>('DELETE', `/tasks/${id}`),

  // diary (read-only in group A)
  diary: (ref: string | number, limit = 5) =>
    request<DiaryEntryView[]>('GET', `/projects/${ref}/diary?limit=${limit}`),

  // proposals (counts only in group A)
  proposals: (state = 'pending') => request<ProposalView[]>('GET', `/proposals?state=${state}`),
};
