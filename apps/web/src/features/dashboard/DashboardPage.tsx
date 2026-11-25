import {
  ACTIVITY_STATES,
  type ActivityState,
  LIFECYCLE_STATUSES,
  type LifecycleStatus,
  type ProjectSummary,
} from '@heph/schema';
import { BeakerIcon, PlusIcon, ProjectIcon } from '@primer/octicons-react';
import { useMemo, useState } from 'react';
import { Link, useNavigate } from 'react-router';
import { usePendingProposals, useProjects } from '../../api/queries.js';
import {
  Alert,
  Box,
  Button,
  EmptyState,
  ProgressBar,
  RelativeTime,
  Segmented,
  SegmentedProgress,
  Skeleton,
  StatusLabel,
  TagChip,
} from '../../components/ui.js';
import { type MessageKey, useI18n, useT } from '../../i18n/index.js';
import { errorKey } from '../../lib/errors.js';
import {
  applyFilters,
  CLOSED,
  counts,
  EMPTY_FILTERS,
  type Filters,
  type Sort,
  sortProjects,
  toggle,
} from './filter.js';
import { TestsTab } from './TestsTab.js';

type View = 'tiles' | 'table';
const TABLE_PAGE = 50;

/** Dashboard (mockups 01, 02, 50, 54). */
export function DashboardPage({ tab }: { tab: 'projects' | 'tests' }) {
  const t = useT();
  const projects = useProjects();
  const proposals = usePendingProposals();
  const all = projects.data ?? [];
  const testing = all.filter((p) => p.lifecycleStatus === 'awaiting_manual_test');

  return (
    <main className="page">
      <nav className="tabs" aria-label={t('dash.tabs')}>
        <Link
          to="/"
          className={tab === 'projects' ? 'active' : ''}
          aria-current={tab === 'projects' ? 'page' : undefined}
        >
          <ProjectIcon size={16} /> {t('dash.tab.projects')}
          <span className="counter">
            {all.filter((p) => !CLOSED.includes(p.lifecycleStatus)).length}
          </span>
        </Link>
        <Link
          to="/tests"
          className={tab === 'tests' ? 'active' : ''}
          aria-current={tab === 'tests' ? 'page' : undefined}
        >
          <BeakerIcon size={16} /> {t('dash.tab.tests')}
          <span className={`counter${testing.length ? ' counter-attention' : ''}`}>
            {testing.length}
          </span>
        </Link>
        <span className="tab-disabled" title={t('common.groupB')}>
          {t('dash.tab.proposals')}
          <span className="counter counter-ai">{proposals.data?.length ?? 0}</span>
        </span>
      </nav>
      {projects.isPending ? (
        <Skeleton lines={6} />
      ) : projects.isError ? (
        <Alert
          tone="danger"
          action={<Button onClick={() => projects.refetch()}>{t('common.retry')}</Button>}
        >
          {t(errorKey(projects.error))}
        </Alert>
      ) : tab === 'tests' ? (
        <TestsTab projects={testing} />
      ) : all.length === 0 ? (
        <FirstProject />
      ) : (
        <ProjectsTab projects={all} />
      )}
    </main>
  );
}

function FirstProject() {
  const t = useT();
  const navigate = useNavigate();
  return (
    <Box>
      <EmptyState
        icon={<ProjectIcon size={24} />}
        title={t('dash.empty.title')}
        text={t('dash.empty.text')}
        actions={
          <Button variant="primary" onClick={() => navigate('/new')}>
            <PlusIcon size={16} /> {t('nav.newProject')}
          </Button>
        }
      />
    </Box>
  );
}

function ProjectsTab({ projects }: { projects: ProjectSummary[] }) {
  const t = useT();
  const { lang } = useI18n();
  const [f, setF] = useState<Filters>(EMPTY_FILTERS);
  const [sort, setSort] = useState<Sort>('attention');
  const [view, setView] = useState<View>('tiles');
  const shown = useMemo(
    () => sortProjects(applyFilters(projects, f), sort, lang),
    [projects, f, sort, lang],
  );
  // Side counts ignore their own filter so other choices stay visible.
  const statusCounts = counts(
    applyFilters(projects, { ...f, statuses: [], showClosed: true }),
    (p) => p.lifecycleStatus,
  );
  const activityCounts = counts(
    applyFilters(projects, { ...f, activities: [] }),
    (p) => p.activityState,
  );
  const tagCounts = counts(applyFilters(projects, { ...f, tags: [] }), (p) => p.tags);
  const tags = [...tagCounts.keys()].sort();
  const filtered = JSON.stringify(f) !== JSON.stringify(EMPTY_FILTERS);

  return (
    <div className="with-sidebar">
      <aside className="filters" aria-label={t('dash.filters')}>
        <FilterGroup<LifecycleStatus>
          title={t('dash.filter.status')}
          values={[...LIFECYCLE_STATUSES]}
          label={(v) => t(`lifecycle.${v}` as MessageKey)}
          counts={statusCounts}
          selected={f.statuses}
          onToggle={(v) => setF({ ...f, statuses: toggle(f.statuses, v) })}
        />
        <FilterGroup<ActivityState>
          title={t('dash.filter.activity')}
          values={[...ACTIVITY_STATES]}
          label={(v) => t(`activity.${v}` as MessageKey)}
          counts={activityCounts}
          selected={f.activities}
          onToggle={(v) => setF({ ...f, activities: toggle(f.activities, v) })}
        />
        {tags.length > 0 && (
          <FilterGroup<string>
            title={t('dash.filter.tags')}
            values={tags}
            label={(v) => v}
            counts={tagCounts}
            selected={f.tags}
            onToggle={(v) => setF({ ...f, tags: toggle(f.tags, v) })}
          />
        )}
        <Box className="queue-placeholder" title={t('dash.queue.title')}>
          <p className="muted small">{t('dash.queue.soon')}</p>
        </Box>
      </aside>
      <section className="content">
        <div className="toolbar">
          <label className="sr-only" htmlFor="dash-filter">
            {t('dash.filterText')}
          </label>
          <input
            id="dash-filter"
            type="search"
            placeholder={t('dash.filterText')}
            value={f.text}
            onChange={(e) => setF({ ...f, text: e.target.value })}
          />
          <label className="sr-only" htmlFor="dash-sort">
            {t('dash.sort')}
          </label>
          <select id="dash-sort" value={sort} onChange={(e) => setSort(e.target.value as Sort)}>
            <option value="attention">{t('dash.sort.attention')}</option>
            <option value="updated">{t('dash.sort.updated')}</option>
            <option value="name">{t('dash.sort.name')}</option>
          </select>
          <label className="check">
            <input
              type="checkbox"
              checked={f.showClosed}
              onChange={(e) => setF({ ...f, showClosed: e.target.checked })}
            />
            {t('dash.showClosed')}
          </label>
          <Segmented<View>
            label={t('dash.view')}
            value={view}
            onChange={setView}
            options={[
              { value: 'tiles', label: t('dash.view.tiles') },
              { value: 'table', label: t('dash.view.table') },
            ]}
          />
        </div>
        {shown.length === 0 ? (
          <Box>
            <EmptyState
              title={t('dash.noMatch.title')}
              text={t('dash.noMatch.text')}
              actions={
                filtered && (
                  <Button onClick={() => setF(EMPTY_FILTERS)}>{t('dash.clearFilters')}</Button>
                )
              }
            />
          </Box>
        ) : view === 'tiles' ? (
          <div className="tiles">
            {shown.map((p) => (
              <ProjectTile key={p.id} p={p} />
            ))}
          </div>
        ) : (
          <ProjectTable projects={shown} />
        )}
      </section>
    </div>
  );
}

function FilterGroup<T extends string>({
  title,
  values,
  label,
  counts: c,
  selected,
  onToggle,
}: {
  title: string;
  values: T[];
  label: (v: T) => string;
  counts: Map<T, number>;
  selected: T[];
  onToggle: (v: T) => void;
}) {
  return (
    <fieldset className="filter-group">
      <legend>{title}</legend>
      {values.map((v) => (
        <label key={v} className="check">
          <input type="checkbox" checked={selected.includes(v)} onChange={() => onToggle(v)} />
          <span className="filter-label">{label(v)}</span>
          <span className="counter">{c.get(v) ?? 0}</span>
        </label>
      ))}
    </fieldset>
  );
}

function NextStep({ p }: { p: ProjectSummary }) {
  const t = useT();
  if (p.nextTask) {
    return (
      <p className="next">
        <span className="muted small">{t('dash.next')}</span> {p.nextTask.title}
      </p>
    );
  }
  if (CLOSED.includes(p.lifecycleStatus)) return null;
  return <p className="next next-missing">{t('badge.no_next_step')}</p>;
}

function ProjectTile({ p }: { p: ProjectSummary }) {
  const t = useT();
  const pct = Math.round(p.progress.ratio * 100);
  const note =
    p.statusNote &&
    (p.lifecycleStatus === 'awaiting_manual_test' || p.lifecycleStatus === 'on_hold')
      ? p.statusNote
      : null;
  return (
    <article className={`box tile tile-${p.badge.kind}`}>
      <header className="tile-head">
        <h2 className="tile-name">
          <Link to={`/p/${p.slug}`} title={p.name}>
            {p.name}
          </Link>
        </h2>
        <StatusLabel badge={p.badge} />
      </header>
      <NextStep p={p} />
      {note && <p className="tile-note">{note}</p>}
      <div className="tile-progress">
        {p.phaseProgress.length > 0 ? (
          <SegmentedProgress phases={p.phaseProgress} />
        ) : (
          <ProgressBar progress={p.progress} />
        )}
        <span className="meta">
          {p.currentPhase ? `${p.currentPhase.title} · ` : ''}
          {pct}%
        </span>
      </div>
      {p.tags.length > 0 && (
        <div className="tags">
          {p.tags.map((tag) => (
            <TagChip key={tag} name={tag} />
          ))}
        </div>
      )}
      <footer className="tile-foot">
        <span className="meta">
          {t('dash.updated')} <RelativeTime iso={p.lastActivityAt} />
        </span>
        {p.lifecycleStatus === 'awaiting_manual_test' ? (
          <Link className="btn btn-default btn-sm" to="/tests">
            {t('dash.action.testOutcome')}
          </Link>
        ) : !p.nextTask && !CLOSED.includes(p.lifecycleStatus) ? (
          <Link className="btn btn-default btn-sm" to={`/p/${p.slug}`}>
            {t('dash.action.pickStep')}
          </Link>
        ) : null}
      </footer>
    </article>
  );
}

const GROUP_KEY: Record<number, MessageKey> = {
  1: 'dash.group.1',
  2: 'dash.group.2',
  3: 'dash.group.3',
  4: 'dash.group.4',
  5: 'dash.group.5',
  6: 'dash.group.6',
};

/** Table view (mockup 54): attention groups that open and close, sticky header, paging. */
function ProjectTable({ projects }: { projects: ProjectSummary[] }) {
  const t = useT();
  const [closed, setClosed] = useState<number[]>([]);
  const [limit, setLimit] = useState(TABLE_PAGE);
  const page = projects.slice(0, limit);
  const groups = [...new Set(page.map((p) => p.attentionGroup))];
  return (
    <div className="table-wrap">
      <table className="table">
        <thead>
          <tr>
            <th scope="col">{t('dash.col.name')}</th>
            <th scope="col">{t('dash.col.status')}</th>
            <th scope="col">{t('dash.col.next')}</th>
            <th scope="col">{t('dash.col.progress')}</th>
            <th scope="col">{t('dash.col.updated')}</th>
          </tr>
        </thead>
        {groups.map((g) => {
          const rows = page.filter((p) => p.attentionGroup === g);
          const isClosed = closed.includes(g);
          return (
            <tbody key={g}>
              <tr className="group-row">
                <th colSpan={5} scope="rowgroup">
                  <button
                    type="button"
                    className="link-btn"
                    aria-expanded={!isClosed}
                    onClick={() => setClosed(toggle(closed, g))}
                  >
                    {t(GROUP_KEY[g] ?? 'dash.group.4')} ({rows.length})
                  </button>
                </th>
              </tr>
              {!isClosed &&
                rows.map((p) => (
                  <tr key={p.id}>
                    <td className="truncate">
                      <Link to={`/p/${p.slug}`} title={p.name}>
                        {p.name}
                      </Link>
                    </td>
                    <td>
                      <StatusLabel badge={p.badge} />
                    </td>
                    <td className="truncate" title={p.nextTask?.title}>
                      {p.nextTask?.title ??
                        (CLOSED.includes(p.lifecycleStatus) ? '' : t('badge.no_next_step'))}
                    </td>
                    <td>
                      <span className="table-progress">
                        <SegmentedProgress phases={p.phaseProgress} />
                      </span>{' '}
                      <span className="meta">{Math.round(p.progress.ratio * 100)}%</span>
                    </td>
                    <td>
                      <RelativeTime iso={p.lastActivityAt} />
                    </td>
                  </tr>
                ))}
            </tbody>
          );
        })}
      </table>
      {projects.length > limit && (
        <Button onClick={() => setLimit(limit + TABLE_PAGE)}>
          {t('dash.showMore', { n: Math.min(TABLE_PAGE, projects.length - limit) })}
        </Button>
      )}
    </div>
  );
}
