import type { ProjectDetail } from '@heph/schema';
import {
  MutationCache,
  QueryCache,
  QueryClient,
  type QueryKey,
  useMutation,
  useQuery,
  useQueryClient,
} from '@tanstack/react-query';
import { useNotices } from '../app/notices.js';
import { ApiError, api } from './client.js';

/** Visible-tab polling interval (D52). */
export const POLL_MS = 10_000;

export function makeQueryClient(): QueryClient {
  // An expired session anywhere sends the user back to sign-in instead of failing silently.
  const onError = (err: unknown) => {
    if (err instanceof ApiError && err.status === 401) {
      client.setQueryData(['auth'], { setupDone: true, user: null });
    }
  };
  const client: QueryClient = new QueryClient({
    queryCache: new QueryCache({ onError }),
    mutationCache: new MutationCache({ onError }),
    defaultOptions: {
      queries: {
        refetchInterval: POLL_MS,
        refetchIntervalInBackground: false,
        refetchOnWindowFocus: true,
        retry: 1,
        staleTime: 2_000,
      },
      mutations: { retry: 0 },
    },
  });
  return client;
}

export const keys = {
  projects: ['projects'] as const,
  project: (ref: string | number) => ['project', String(ref)] as const,
  settings: ['settings'] as const,
  tags: ['tags'] as const,
  proposals: ['proposals', 'pending'] as const,
};

export const useProjects = () =>
  useQuery({ queryKey: keys.projects, queryFn: () => api.projects() });
export const useProject = (ref: string) =>
  useQuery({ queryKey: keys.project(ref), queryFn: () => api.project(ref) });
export const useTags = () => useQuery({ queryKey: keys.tags, queryFn: api.tags });
export const usePendingProposals = () =>
  useQuery({ queryKey: keys.proposals, queryFn: () => api.proposals('pending') });

/**
 * A mutation that shows the fixed error text on failure (D44) and refetches the given
 * queries afterwards, so the server stays the source of truth.
 */
export function useApiMutation<A, R>(
  fn: (args: A) => Promise<R>,
  opts: {
    invalidate?: (args: A) => QueryKey[];
    /** Optimistic update; returns a rollback. */
    optimistic?: (args: A) => (() => void) | undefined;
    onSuccess?: (result: R, args: A) => void;
  } = {},
) {
  const qc = useQueryClient();
  const notices = useNotices();
  return useMutation({
    mutationFn: fn,
    onMutate: (args: A) => ({ rollback: opts.optimistic?.(args) }),
    onError: (err, _args, ctx) => {
      ctx?.rollback?.();
      notices.error(err);
    },
    onSuccess: (r, args) => opts.onSuccess?.(r, args),
    onSettled: (_r, _e, args) => {
      for (const k of [...(opts.invalidate?.(args) ?? []), keys.projects]) {
        void qc.invalidateQueries({ queryKey: k });
      }
    },
  });
}

/** Replaces the cached project detail and returns a rollback to the previous copy. */
export function setProjectCache(
  qc: QueryClient,
  ref: string,
  update: (p: ProjectDetail) => ProjectDetail,
): () => void {
  const key = keys.project(ref);
  const before = qc.getQueryData<ProjectDetail>(key);
  if (before) {
    void qc.cancelQueries({ queryKey: key });
    qc.setQueryData(key, update(before));
  }
  return () => qc.setQueryData(key, before);
}
