import type {
  AddTaskInput,
  ChangeView,
  CreateProjectInput,
  DiaryEntryView,
  DiaryType,
  FileView,
  GitHubStatusView,
  GitHubVerifyView,
  MaterialInput,
  MaterialView,
  PhaseView,
  ProjectDetail,
  ProjectDocsView,
  ProjectSummary,
  ProposalView,
  SearchHit,
  Settings,
  Source,
  TaskView,
  UpdateProjectInput,
} from '@heph/schema';

/** Error from the REST API: `code` drives the fixed UI text (D44), never `message`. */
export class ApiError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
    /** Structured `error.details` from the server (e.g. a revert's `blockedBy`, D74). */
    readonly details?: unknown,
  ) {
    super(message);
  }
}

/** Network failure (server unreachable): its own code for a fixed UI text. */
export const NETWORK_ERROR = 'network';
/** Wrong current password on a password change (client-side code). */
export const WRONG_PASSWORD = 'wrong_password';

/**
 * Behind Cloudflare Access a stopped server answers with the proxy's own HTML error page
 * (502–504, 520–530): that is "server not answering", not an API error.
 */
function throwIfProxyError(res: Response, data: { error?: unknown } | null): void {
  const proxy =
    res.status === 502 ||
    res.status === 503 ||
    res.status === 504 ||
    (res.status >= 520 && res.status <= 530);
  if (!res.ok && !data?.error && proxy) throw new ApiError(0, NETWORK_ERROR, 'Server unreachable');
}

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
  throwIfProxyError(res, data);
  if (!res.ok) {
    throw new ApiError(
      res.status,
      data?.error?.code ?? 'http',
      data?.error?.message ?? res.statusText,
      data?.error?.details,
    );
  }
  return data as T;
}

/** Multipart upload; the browser sets the boundary. */
async function upload<T>(path: string, form: FormData): Promise<T> {
  let res: Response;
  try {
    res = await fetch(`/api${path}`, { method: 'POST', credentials: 'same-origin', body: form });
  } catch {
    throw new ApiError(0, NETWORK_ERROR, 'Network error');
  }
  const data = await res.json().catch(() => null);
  throwIfProxyError(res, data);
  if (!res.ok) {
    throw new ApiError(
      res.status,
      data?.error?.code ?? 'http',
      data?.error?.message ?? res.statusText,
      data?.error?.details,
    );
  }
  return data as T;
}

export const fileUrl = (id: number, opts: { thumb?: boolean; download?: boolean } = {}) =>
  `/api/files/${id}/${opts.thumb ? 'thumbnail' : 'content'}${opts.download ? '?download' : ''}`;

export interface DiaryFilter {
  limit?: number;
  source?: Source;
  type?: DiaryType;
  withFiles?: boolean;
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

  // account and settings
  /** A wrong current password is a 401 from the server, but the session is fine: it
   *  becomes its own code so the global "session expired" handling does not sign out. */
  changePassword: (currentPassword: string, newPassword: string) =>
    request<{ ok: true }>('POST', '/auth/password', { currentPassword, newPassword }).catch(
      (err: unknown) => {
        if (err instanceof ApiError && err.status === 401) {
          throw new ApiError(400, WRONG_PASSWORD, err.message);
        }
        throw err;
      },
    ),
  apiToken: () => request<{ apiToken: string }>('GET', '/settings/api-token'),
  rotateApiToken: () => request<{ apiToken: string }>('POST', '/settings/api-token/rotate'),
  /** Connect Claude Code page: public agent URL and the last Claude call (D60). */
  connect: () =>
    request<{ agentUrl: string | null; lastAgentCallAt: string | null }>(
      'GET',
      '/settings/connect',
    ),
  search: (q: string) => request<SearchHit[]>('GET', `/search?q=${encodeURIComponent(q)}`),

  // settings
  settings: () => request<Settings>('GET', '/settings'),
  updateSettings: (patch: Partial<Settings>) => request<Settings>('PATCH', '/settings', patch),
  // GitHub (phase 6, D61)
  githubStatus: () => request<GitHubStatusView>('GET', '/github/status'),
  githubVerify: () => request<GitHubVerifyView>('POST', '/github/verify'),
  githubSync: (ref: string | number) =>
    request<{
      skipped: 'no_token' | 'rate_limited' | null;
      repos?: { repo: string; error: string | null }[];
      status?: GitHubStatusView;
    }>('POST', `/projects/${ref}/github/sync`),

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

  // diary
  diary: (ref: string | number, limit = 5) =>
    request<DiaryEntryView[]>('GET', `/projects/${ref}/diary?limit=${limit}`),
  /** One page of the diary, newest first; `ref` null = all projects. */
  diaryPage: (
    ref: string | number | null,
    q: DiaryFilter & { before?: string; beforeId?: number },
  ) => {
    const qs = new URLSearchParams();
    qs.set('limit', String(q.limit ?? 50));
    if (q.before) qs.set('before', q.before);
    if (q.beforeId !== undefined) qs.set('beforeId', String(q.beforeId));
    if (q.source) qs.set('source', q.source);
    if (q.type) qs.set('type', q.type);
    if (q.withFiles) qs.set('withFiles', 'true');
    return request<DiaryEntryView[]>(
      'GET',
      `${ref === null ? '/diary' : `/projects/${ref}/diary`}?${qs}`,
    );
  },
  diaryMonths: (ref: string | number | null) =>
    request<{ month: string; count: number }[]>(
      'GET',
      ref === null ? '/diary/months' : `/projects/${ref}/diary/months`,
    ),
  addNote: (ref: string | number, body: string, fileIds: number[]) =>
    request<DiaryEntryView>('POST', `/projects/${ref}/diary`, { body, fileIds }),

  // repos and project lifecycle
  linkRepo: (ref: string | number, fullName: string) =>
    request<ProjectDetail>('POST', `/projects/${ref}/repos`, { fullName }),
  updateRepo: (id: number, input: { docsPath?: string; showCommits?: boolean }) =>
    request<ProjectDetail>('PATCH', `/repos/${id}`, {
      docsPath: input.docsPath,
      showCommits: input.showCommits,
    }),
  unlinkRepo: (id: number) => request<ProjectDetail>('DELETE', `/repos/${id}`),
  deleteProject: (ref: string | number) => request<null>('DELETE', `/projects/${ref}`),

  // docs and materials
  docs: (ref: string | number) => request<ProjectDocsView>('GET', `/projects/${ref}/docs`),
  updateProject: (ref: string | number, input: UpdateProjectInput) =>
    request<ProjectDetail>('PATCH', `/projects/${ref}`, input),
  materials: (ref: string | number) => request<MaterialView[]>('GET', `/projects/${ref}/materials`),
  addMaterial: (ref: string | number, input: MaterialInput) =>
    request<MaterialView>('POST', `/projects/${ref}/materials`, input),
  updateMaterial: (id: number, input: Partial<MaterialInput>) =>
    request<MaterialView>('PATCH', `/materials/${id}`, input),
  deleteMaterial: (id: number) => request<null>('DELETE', `/materials/${id}`),

  // files
  uploadFiles: (ref: string | number, files: File[], target: Record<string, string> = {}) => {
    const form = new FormData();
    for (const [k, v] of Object.entries(target)) form.append(k, v);
    for (const f of files) form.append('file', f, f.name);
    return upload<FileView[]>(`/projects/${ref}/files`, form);
  },
  files: (ref: string | number) => request<FileView[]>('GET', `/projects/${ref}/files`),
  updateFile: (id: number, input: { pinned?: boolean; caption?: string | null }) =>
    request<FileView>('PATCH', `/files/${id}`, input),
  deleteFile: (id: number) => request<null>('DELETE', `/files/${id}`),

  // proposals
  proposalsOf: (ref: string | number | null, state: string) =>
    request<ProposalView[]>(
      'GET',
      `${ref === null ? '/proposals' : `/projects/${ref}/proposals`}?state=${state}`,
    ),
  approveProposal: (id: number, note?: string) =>
    request<ProposalView>('POST', `/proposals/${id}/approve`, { note }),
  rejectProposal: (id: number, note?: string) =>
    request<ProposalView>('POST', `/proposals/${id}/reject`, { note }),
  proposals: (state = 'pending') => request<ProposalView[]>('GET', `/proposals?state=${state}`),

  // changes (D74)
  changes: (ref: string | number, q: { before?: number; limit?: number; revertible?: boolean }) => {
    const qs = new URLSearchParams();
    qs.set('limit', String(q.limit ?? 50));
    if (q.before !== undefined) qs.set('before', String(q.before));
    if (q.revertible) qs.set('revertible', 'true');
    return request<ChangeView[]>('GET', `/projects/${ref}/changes?${qs}`);
  },
  change: (id: number) => request<ChangeView>('GET', `/changes/${id}`),
  revertChange: (id: number) => request<ChangeView>('POST', `/changes/${id}/revert`),
};
