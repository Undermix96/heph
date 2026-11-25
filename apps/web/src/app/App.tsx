import type { Settings } from '@heph/schema';
import { QueryClientProvider, useQuery, useQueryClient } from '@tanstack/react-query';
import { lazy, type ReactNode, Suspense, useState } from 'react';
import { createBrowserRouter, Outlet, RouterProvider } from 'react-router';
import { api, type User } from '../api/client.js';
import { keys, makeQueryClient } from '../api/queries.js';
import { Alert, Button, Skeleton } from '../components/ui.js';
import { AuthShell, CredentialsForm, TokenNotice } from '../features/auth/AuthPages.js';
import { detectLang, I18nProvider, type Lang, useT } from '../i18n/index.js';
import { NoticesProvider } from './notices.js';
import { useOffline } from './online.js';
import { TopBar } from './TopBar.js';

// One chunk per page so the first load stays small (Markdown, drag and drop and the
// viewer load only where used).
const DashboardPage = lazy(() =>
  import('../features/dashboard/DashboardPage.js').then((m) => ({ default: m.DashboardPage })),
);
const ProjectPage = lazy(() =>
  import('../features/project/ProjectPage.js').then((m) => ({ default: m.ProjectPage })),
);
const EditProjectPage = lazy(() =>
  import('../features/project/EditProjectPage.js').then((m) => ({ default: m.EditProjectPage })),
);
const NewProjectPage = lazy(() =>
  import('../features/project/NewProjectPage.js').then((m) => ({ default: m.NewProjectPage })),
);
const SettingsPage = lazy(() =>
  import('../features/settings/SettingsPage.js').then((m) => ({ default: m.SettingsPage })),
);
const SearchPage = lazy(() =>
  import('../features/search/SearchPage.js').then((m) => ({ default: m.SearchPage })),
);

export const routes = [
  {
    element: <Layout />,
    children: [
      {
        // Errors while loading or rendering a page (e.g. a page chunk gone after an
        // update) stay inside the layout with a fixed text and Reload (D44).
        errorElement: <PageError />,
        children: [
          { path: '/', element: <DashboardPage tab="projects" /> },
          { path: '/tests', element: <DashboardPage tab="tests" /> },
          { path: '/diary', element: <DashboardPage tab="diary" /> },
          { path: '/proposals', element: <DashboardPage tab="proposals" /> },
          { path: '/new', element: <NewProjectPage /> },
          { path: '/p/:slug/edit', element: <EditProjectPage /> },
          { path: '/p/:slug/:tab?', element: <ProjectPage /> },
          { path: '/settings', element: <SettingsPage /> },
          { path: '/search', element: <SearchPage /> },
          { path: '*', element: <NotFound /> },
        ],
      },
    ],
  },
];

const router = createBrowserRouter(routes);

export function App({
  client = makeQueryClient(),
}: {
  client?: ReturnType<typeof makeQueryClient>;
}) {
  return (
    <QueryClientProvider client={client}>
      <Session>
        <RouterProvider router={router} />
      </Session>
    </QueryClientProvider>
  );
}

/**
 * Auth gate and language. The UI language is the `uiLanguage` setting; before sign-in
 * the browser language is used.
 */
export function Session({ children }: { children: ReactNode }) {
  const qc = useQueryClient();
  const status = useQuery({
    queryKey: ['auth'],
    queryFn: api.status,
    refetchInterval: false,
  });
  const settings = useQuery({
    queryKey: keys.settings,
    queryFn: api.settings,
    enabled: !!status.data?.user,
    refetchInterval: false,
  });
  const [token, setToken] = useState<string | null>(null);
  const lang: Lang = (settings.data?.uiLanguage as Lang | undefined) ?? detectLang();
  const signedIn = (user: User, apiToken?: string) => {
    qc.setQueryData(['auth'], { setupDone: true, user });
    if (apiToken) setToken(apiToken);
  };

  let body: ReactNode;
  if (status.isPending)
    body = (
      <AuthShell title="Hephaestus">
        <Skeleton lines={2} />
      </AuthShell>
    );
  else if (status.isError) body = <Unreachable onRetry={() => status.refetch()} />;
  else if (!status.data.user) {
    body = <CredentialsForm mode={status.data.setupDone ? 'login' : 'setup'} onDone={signedIn} />;
  } else if (token) body = <TokenNotice token={token} onContinue={() => setToken(null)} />;
  else body = children;

  return (
    <I18nProvider lang={lang}>
      <NoticesProvider>{body}</NoticesProvider>
    </I18nProvider>
  );
}

function Unreachable({ onRetry }: { onRetry: () => void }) {
  const t = useT();
  return (
    <AuthShell title="Hephaestus">
      <Alert tone="danger" action={<Button onClick={onRetry}>{t('common.retry')}</Button>}>
        {t('error.network')}
      </Alert>
    </AuthShell>
  );
}

function Layout() {
  return (
    <div className="app">
      <TopBar />
      <OfflineNotice />
      <Suspense
        fallback={
          <main className="page">
            <Skeleton lines={6} />
          </main>
        }
      >
        <Outlet />
      </Suspense>
    </div>
  );
}

function OfflineNotice() {
  const t = useT();
  const offline = useOffline();
  return offline ? (
    <div className="offline" role="alert">
      {t('error.offline')}
    </div>
  ) : null;
}

function PageError() {
  const t = useT();
  return (
    <main className="page">
      <Alert
        tone="danger"
        action={<Button onClick={() => window.location.reload()}>{t('common.retry')}</Button>}
      >
        {t('error.pageLoad')}
      </Alert>
    </main>
  );
}

function NotFound() {
  const t = useT();
  return (
    <main className="page">
      <Alert tone="attention">{t('error.pageNotFound')}</Alert>
    </main>
  );
}

export type { Settings };
