/** Minimal REST client for the auth flows. Cookies carry the session. */
export class ApiError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
  ) {
    super(message);
  }
}

async function request<T>(method: string, path: string, body?: unknown): Promise<T> {
  const res = await fetch(`/api${path}`, {
    method,
    credentials: 'same-origin',
    headers: body === undefined ? {} : { 'content-type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
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

export const api = {
  status: () => request<{ setupDone: boolean; user: User | null }>('GET', '/auth/status'),
  setup: (username: string, password: string) =>
    request<{ user: User; apiToken: string }>('POST', '/setup', { username, password }),
  login: (username: string, password: string) =>
    request<{ user: User }>('POST', '/auth/login', { username, password }),
  logout: () => request<{ ok: true }>('POST', '/auth/logout'),
};
