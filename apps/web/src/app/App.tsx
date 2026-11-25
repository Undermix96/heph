import type { Settings } from '@heph/schema';
import { QueryClientProvider, useQuery, useQueryClient } from '@tanstack/react-query';
import { type ReactNode, useState } from 'react';
import { createBrowserRouter, Outlet, RouterProvider } from 'react-router';
import { api, type User } from '../api/client.js';
import { keys, makeQueryClient } from '../api/queries.js';
import { Alert, Button, Skeleton } from '../components/ui.js';
import { AuthShell, CredentialsForm, TokenNotice } from '../features/auth/AuthPages.js';
import { DashboardPage } from '../features/dashboard/DashboardPage.js';
import { EditProjectPage } from '../features/project/EditProjectPage.js';
import { NewProjectPage } from '../features/project/NewProjectPage.js';
import { ProjectPage } from '../features/project/ProjectPage.js';
import { SearchPage } from '../features/search/SearchPage.js';
import { SettingsPage } from '../features/settings/SettingsPage.js';
import { detectLang, I18nProvider, type Lang, useT } from '../i18n/index.js';
import { NoticesProvider } from './notices.js';
import { useOffline } from './online.js';
import { TopBar } from './TopBar.js';

export const routes = [
  {
    element: <Layout />,
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
      <Outlet />
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

function NotFound() {
  const t = useT();
  return (
    <main className="page">
      <Alert tone="attention">{t('error.pageNotFound')}</Alert>
    </main>
  );
}

export type { Settings };
