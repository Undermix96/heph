import type { ProjectDetail, Settings } from '@heph/schema';
import { ChevronLeftIcon, GearIcon, PlusIcon, SearchIcon } from '@primer/octicons-react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { useEffect, useRef, useState } from 'react';
import { Link, useLocation, useMatch, useNavigate } from 'react-router';
import { api } from '../api/client.js';
import { keys, useApiMutation } from '../api/queries.js';
import { Menu } from '../components/ui.js';
import { type Lang, useI18n, useT } from '../i18n/index.js';
import { PHONE, useMedia } from '../lib/media.js';

/** Top bar (design §4): logo, path, language, New project, settings, account. */
export function TopBar() {
  const t = useT();
  const { lang } = useI18n();
  const qc = useQueryClient();
  const navigate = useNavigate();
  const [query, setQuery] = useState('');
  const search = useRef<HTMLInputElement>(null);
  // "/" focuses the search field unless the user is typing somewhere (design §4).
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const el = e.target as HTMLElement;
      if (e.key !== '/' || el.closest('input, textarea, select, [contenteditable]')) return;
      e.preventDefault();
      search.current?.focus();
    };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, []);
  const project = useMatch('/p/:slug/*');
  // The project page already has this query cached; show the name, not the slug.
  const slug = project?.params.slug ?? '';
  const projectName = useQuery<ProjectDetail>({
    queryKey: keys.project(slug),
    queryFn: () => api.project(slug),
    enabled: false,
  }).data?.name;
  const phone = useMedia(PHONE);
  const location = useLocation();
  const setLang = useApiMutation((l: Lang) => api.updateSettings({ uiLanguage: l }), {
    onSuccess: (s: Settings) => qc.setQueryData(keys.settings, s),
  });
  const logout = useApiMutation(() => api.logout(), {
    onSuccess: () => qc.setQueryData(['auth'], { setupDone: true, user: null }),
  });

  if (phone) {
    const onDashboard = ['/', '/tests', '/diary', '/proposals'].includes(location.pathname);
    const title = slug
      ? (projectName ?? slug)
      : t(
          location.pathname.startsWith('/settings')
            ? 'nav.settings'
            : location.pathname.startsWith('/new')
              ? 'nav.newProject'
              : location.pathname.startsWith('/search')
                ? 'nav.search'
                : 'nav.projectsTitle',
        );
    // Back goes one level up: from the edit page to the project, otherwise home
    // (the project tabs are siblings of the overview, not children).
    const backTo = slug && location.pathname.endsWith('/edit') ? `/p/${slug}` : '/';
    // Phone top bar (mockups 60–62): back or logo, title, search, + or ⋯.
    return (
      <header className="topbar topbar-phone">
        {onDashboard ? (
          <Link to="/" className="logo" aria-label={t('nav.home')}>
            H
          </Link>
        ) : (
          <Link to={backTo} className="icon-btn icon-btn-boxed" aria-label={t('nav.back')}>
            <ChevronLeftIcon size={20} />
          </Link>
        )}
        <h1 className="topbar-title">{title}</h1>
        <Link to="/search" className="icon-btn icon-btn-boxed" aria-label={t('nav.search')}>
          <SearchIcon size={18} />
        </Link>
        {onDashboard && (
          <Link
            to="/new"
            className="btn btn-primary btn-md btn-square"
            aria-label={t('nav.newProject')}
          >
            <PlusIcon size={18} />
          </Link>
        )}
        <Menu
          label={t('nav.more')}
          items={[
            slug ? { label: t('roadmap.edit'), onSelect: () => navigate(`/p/${slug}/edit`) } : null,
            onDashboard ? null : { label: t('nav.newProject'), onSelect: () => navigate('/new') },
            { label: t('nav.settings'), onSelect: () => navigate('/settings') },
            {
              label: lang === 'it' ? 'English' : 'Italiano',
              onSelect: () => setLang.mutate(lang === 'it' ? 'en' : 'it'),
            },
            { label: t('auth.signOut'), onSelect: () => logout.mutate(undefined) },
          ]}
        />
      </header>
    );
  }

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
      <search className="topbar-search">
        <form
          onSubmit={(e) => {
            e.preventDefault();
            if (query.trim()) navigate(`/search?q=${encodeURIComponent(query.trim())}`);
          }}
        >
          <label className="sr-only" htmlFor="top-search">
            {t('nav.search')}
          </label>
          <input
            id="top-search"
            ref={search}
            type="search"
            placeholder={t('nav.searchPlaceholder')}
            value={query}
            onChange={(e) => setQuery(e.target.value)}
          />
        </form>
      </search>
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
      <button
        type="button"
        className="btn btn-primary btn-md"
        aria-label={t('nav.newProject')}
        onClick={() => navigate('/new')}
      >
        <PlusIcon size={16} /> <span className="hide-phone">{t('nav.newProject')}</span>
      </button>
      <Link to="/settings" className="icon-btn" aria-label={t('nav.settings')}>
        <GearIcon size={16} />
      </Link>
      <Menu
        label={t('nav.account')}
        items={[{ label: t('auth.signOut'), onSelect: () => logout.mutate(undefined) }]}
      />
    </header>
  );
}
