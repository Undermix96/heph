import type { LifecycleStatus, ProjectDetail } from '@heph/schema';
import { TriangleDownIcon } from '@primer/octicons-react';
import { useRef, useState } from 'react';
import { Link, NavLink, useParams } from 'react-router';
import { api, isProposal } from '../../api/client.js';
import { keys, useApiMutation, useProject, useProjects } from '../../api/queries.js';
import { useNotices } from '../../app/notices.js';
import {
  Alert,
  Button,
  Field,
  Skeleton,
  StatusLabel,
  TagChip,
  useDismiss,
} from '../../components/ui.js';
import { type MessageKey, useT } from '../../i18n/index.js';
import { errorKey } from '../../lib/errors.js';
import { DiaryView } from '../diary/DiaryView.js';
import { FormDialog, RoadmapBoard } from '../roadmap/RoadmapBoard.js';
import { DocsTab } from './DocsTab.js';
import { FilesTab } from './FilesTab.js';
import { MaterialsTab } from './MaterialsTab.js';
import { Overview } from './Overview.js';

const TABS = ['overview', 'roadmap', 'diary', 'docs', 'materials', 'files'] as const;
type Tab = (typeof TABS)[number];

/** Project page (mockups 10, 11, 53): one sidebar, header, tabs. */
export function ProjectPage() {
  const t = useT();
  const { slug = '', tab: rawTab } = useParams();
  const tab: Tab = (TABS as readonly string[]).includes(rawTab ?? '')
    ? (rawTab as Tab)
    : 'overview';
  const project = useProject(slug);

  return (
    <div className="with-sidebar">
      <ProjectList current={slug} />
      <main className="content">
        {project.isPending ? (
          <Skeleton lines={8} />
        ) : project.isError ? (
          <Alert
            tone={errorKey(project.error) === 'error.not_found' ? 'attention' : 'danger'}
            action={<Button onClick={() => project.refetch()}>{t('common.retry')}</Button>}
          >
            {t(
              errorKey(project.error) === 'error.not_found'
                ? 'project.notFound'
                : errorKey(project.error),
            )}
          </Alert>
        ) : (
          <>
            <ProjectHeader p={project.data} />
            <nav className="tabs" aria-label={t('project.tabs')}>
              {TABS.map((k) => (
                <NavLink
                  key={k}
                  to={k === 'overview' ? `/p/${slug}` : `/p/${slug}/${k}`}
                  end
                  className={({ isActive }) => (isActive ? 'active' : '')}
                >
                  {t(`project.tab.${k}` as MessageKey)}
                </NavLink>
              ))}
            </nav>
            {tab === 'overview' && <Overview p={project.data} />}
            {tab === 'roadmap' && <RoadmapBoard project={project.data} />}
            {tab === 'diary' && <DiaryView projectRef={project.data.slug} />}
            {tab === 'docs' && <DocsTab projectRef={project.data.slug} />}
            {tab === 'materials' && <MaterialsTab projectRef={project.data.slug} />}
            {tab === 'files' && <FilesTab projectRef={project.data.slug} />}
          </>
        )}
      </main>
    </div>
  );
}

function ProjectList({ current }: { current: string }) {
  const t = useT();
  const projects = useProjects();
  const [q, setQ] = useState('');
  const list = (projects.data ?? []).filter((p) =>
    p.name.toLowerCase().includes(q.trim().toLowerCase()),
  );
  return (
    <aside className="project-list hide-phone" aria-label={t('project.list')}>
      <label className="sr-only" htmlFor="pl-filter">
        {t('project.listFilter')}
      </label>
      <input
        id="pl-filter"
        type="search"
        placeholder={t('project.listFilter')}
        value={q}
        onChange={(e) => setQ(e.target.value)}
      />
      <ul>
        {list.map((p) => (
          <li key={p.id}>
            <Link
              to={`/p/${p.slug}`}
              className={p.slug === current ? 'active' : ''}
              aria-current={p.slug === current ? 'page' : undefined}
              title={p.name}
            >
              {p.name}
            </Link>
          </li>
        ))}
      </ul>
    </aside>
  );
}

function ProjectHeader({ p }: { p: ProjectDetail }) {
  const t = useT();
  const [more, setMore] = useState(false);
  return (
    <header className="project-head">
      <div className="project-title-row">
        <h1 className="project-name">{p.name}</h1>
        <StatusLabel badge={p.badge} />
        <span className="meta">
          {p.progress.done}/{p.progress.total} · {Math.round(p.progress.ratio * 100)}%
        </span>
        <div className="topbar-spacer" />
        <Link className="btn btn-default btn-md" to={`/p/${p.slug}/edit`}>
          {t('roadmap.edit')}
        </Link>
        <StatusMenu p={p} />
      </div>
      {p.description && (
        <div className="project-desc">
          <p className={more ? 'pre' : 'clamp-2 pre'}>{p.description}</p>
          {p.description.length > 160 && (
            <button type="button" className="link-btn" onClick={() => setMore(!more)}>
              {t(more ? 'common.showLess' : 'common.showAll')}
            </button>
          )}
        </div>
      )}
      <div className="row small">
        {p.links.map((l) => (
          <a key={l.id} href={l.url} target="_blank" rel="noreferrer noopener">
            {l.label}
          </a>
        ))}
        {p.repos.map((r) => (
          <a key={r} href={`https://github.com/${r}`} target="_blank" rel="noreferrer noopener">
            {r}
          </a>
        ))}
        {p.tags.map((tag) => (
          <TagChip key={tag} name={tag} />
        ))}
      </div>
    </header>
  );
}

const STATUS_OPTIONS: LifecycleStatus[] = [
  'in_development',
  'awaiting_manual_test',
  'on_hold',
  'completed',
  'abandoned',
];

/** "Stato ▾": waiting for a test asks what to check, on hold asks why (design §6). */
export function StatusMenu({ p }: { p: ProjectDetail }) {
  const t = useT();
  const notices = useNotices();
  const [open, setOpen] = useState(false);
  const box = useRef<HTMLDivElement>(null);
  const trigger = useRef<HTMLButtonElement>(null);
  useDismiss(open, setOpen, box, trigger);
  const [asking, setAsking] = useState<LifecycleStatus | null>(null);
  const [note, setNote] = useState('');
  const set = useApiMutation(
    (a: { status: LifecycleStatus; note?: string }) => api.setStatus(p.slug, a),
    {
      invalidate: () => [keys.project(p.slug)],
      onSuccess: (r) => {
        setAsking(null);
        setNote('');
        if (isProposal(r)) notices.info('status.proposalCreated');
      },
    },
  );
  const choose = (s: LifecycleStatus) => {
    setOpen(false);
    // Focus the trigger first so the note dialog returns the focus there on close.
    trigger.current?.focus();
    if (s === 'awaiting_manual_test' || s === 'on_hold') {
      setNote(s === p.lifecycleStatus ? p.statusNote : '');
      setAsking(s);
    } else set.mutate({ status: s });
  };
  return (
    <div className="menu" ref={box}>
      <Button
        ref={trigger}
        aria-haspopup="true"
        aria-expanded={open}
        onClick={() => setOpen(!open)}
      >
        {t('status.menu')} <TriangleDownIcon size={16} />
      </Button>
      {open && (
        <ul className="menu-list">
          {STATUS_OPTIONS.map((s) => (
            <li key={s}>
              <button
                type="button"
                aria-current={s === p.lifecycleStatus}
                onClick={() => choose(s)}
              >
                {t(`lifecycle.${s}` as MessageKey)}
              </button>
            </li>
          ))}
        </ul>
      )}
      {asking && (
        <FormDialog
          title={t(`lifecycle.${asking}` as MessageKey)}
          onClose={() => setAsking(null)}
          busy={set.isPending}
          submitLabel={t('common.save')}
          onSubmit={() => note.trim() && set.mutate({ status: asking, note: note.trim() })}
        >
          <Field
            label={t(asking === 'on_hold' ? 'status.holdReason' : 'status.whatToTest')}
            htmlFor="status-note"
            hint={t('status.noteRequired')}
          >
            <textarea
              id="status-note"
              rows={5}
              value={note}
              onChange={(e) => setNote(e.target.value)}
            />
          </Field>
        </FormDialog>
      )}
    </div>
  );
}
