import type { ProjectDetail, Settings } from '@heph/schema';
import { GearIcon, PlusIcon } from '@primer/octicons-react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { Link, useMatch, useNavigate } from 'react-router';
import { api } from '../api/client.js';
import { keys, useApiMutation } from '../api/queries.js';
import { Menu } from '../components/ui.js';
import { type Lang, useI18n, useT } from '../i18n/index.js';

/** Top bar (design §4): logo, path, language, New project, settings, account. */
export function TopBar() {
  const t = useT();
  const { lang } = useI18n();
  const qc = useQueryClient();
  const navigate = useNavigate();
  const project = useMatch('/p/:slug/*');
  // The project page already has this query cached; show the name, not the slug.
  const slug = project?.params.slug ?? '';
  const projectName = useQuery<ProjectDetail>({
    queryKey: keys.project(slug),
    queryFn: () => api.project(slug),
    enabled: false,
  }).data?.name;
  const setLang = useApiMutation((l: Lang) => api.updateSettings({ uiLanguage: l }), {
    onSuccess: (s: Settings) => qc.setQueryData(keys.settings, s),
  });
  const logout = useApiMutation(() => api.logout(), {
    onSuccess: () => qc.setQueryData(['auth'], { setupDone: true, user: null }),
  });

  return (
    <header className="topbar">
      <Link to="/" className="logo" aria-label={t('nav.home')}>
        H
      </Link>
      <nav className="crumbs" aria-label={t('nav.path')}>
        <Link to="/">{t('nav.projects')}</Link>
        {project?.params.slug && (
          <>
            <span aria-hidden="true">/</span>
            <Link to={`/p/${project.params.slug}`}>{projectName ?? project.params.slug}</Link>
          </>
        )}
      </nav>
      <div className="topbar-spacer" />
      <label className="sr-only" htmlFor="lang">
        {t('nav.language')}
      </label>
      <select
        id="lang"
        className="lang"
        value={lang}
        onChange={(e) => setLang.mutate(e.target.value as Lang)}
      >
        <option value="it">IT</option>
        <option value="en">EN</option>
      </select>
      <button type="button" className="btn btn-primary btn-md" onClick={() => navigate('/new')}>
        <PlusIcon size={16} /> {t('nav.newProject')}
      </button>
      <button
        type="button"
        className="icon-btn"
        aria-label={t('nav.settings')}
        title={t('nav.settingsSoon')}
        disabled
      >
        <GearIcon size={16} />
      </button>
      <Menu
        label={t('nav.account')}
        items={[{ label: t('auth.signOut'), onSelect: () => logout.mutate(undefined) }]}
      />
    </header>
  );
}
