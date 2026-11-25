import type {
  AddTaskInput,
  CreateProjectInput,
  DiaryEntryView,
  DiaryType,
  FileView,
  MaterialInput,
  MaterialView,
  PhaseView,
  ProjectDetail,
  ProjectDocsView,
  ProjectSummary,
  ProposalView,
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

/** Multipart upload; the browser sets the boundary. */
async function upload<T>(path: string, form: FormData): Promise<T> {
  let res: Response;
  try {
    res = await fetch(`/api${path}`, { method: 'POST', credentials: 'same-origin', body: form });
  } catch {
    throw new ApiError(0, NETWORK_ERROR, 'Network error');
  }
  const data = await res.json().catch(() => null);
  if (!res.ok) {
    throw new ApiError(
      res.status,
      data?.error?.code ?? 'http',
      data?.error?.message ?? res.statusText,
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
  addNote: (ref: string | number, body: string, fileIds: number[]) =>
    request<DiaryEntryView>('POST', `/projects/${ref}/diary`, { body, fileIds }),

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
};
