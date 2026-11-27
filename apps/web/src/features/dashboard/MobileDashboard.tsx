import { LIFECYCLE_STATUSES, type LifecycleStatus, type ProjectSummary } from '@heph/schema';
import { useState } from 'react';
import { Link } from 'react-router';
import { api } from '../../api/client.js';
import { keys, useApiMutation, usePendingProposals } from '../../api/queries.js';
import { useNotices } from '../../app/notices.js';
import { ProgressBar, RelativeTime, StatusLabel } from '../../components/ui.js';
import { type MessageKey, useI18n, useT } from '../../i18n/index.js';
import { changesOf } from '../proposals/changes.js';
import { QueueRow, queueIsEmpty, useClaudeQueue } from './ClaudeQueue.js';
import {
  applyFilters,
  CLOSED,
  EMPTY_FILTERS,
  type Filters,
  sortProjects,
  toggle,
} from './filter.js';

/**
 * Phone dashboard (mockup 60): what needs attention with its actions in place, Claude
 * at work, then every project as a compact row with the filters behind "Filtri ▾".
 */
export function MobileDashboard({ projects }: { projects: ProjectSummary[] }) {
  const t = useT();
  const { lang } = useI18n();
  const proposals = usePendingProposals();
  const [f, setF] = useState<Filters>(EMPTY_FILTERS);
  const [showFilters, setShowFilters] = useState(false);
  const byId = new Map(projects.map((p) => [p.id, p]));
  const open = projects.filter((p) => !CLOSED.includes(p.lifecycleStatus));
  const testing = open.filter((p) => p.lifecycleStatus === 'awaiting_manual_test');
  const stuck = open.filter(
    (p) =>
      p.lifecycleStatus === 'in_development' &&
      (p.badge.kind === 'no_next_step' || p.badge.kind === 'inactive'),
  );
  const pending = proposals.data ?? [];
  const queue = useClaudeQueue();
  const attention = testing.length + pending.length + stuck.length;
  const shown = sortProjects(applyFilters(projects, f), 'attention', lang);

  return (
    <div className="stack m-dash">
      {attention > 0 && (
        <section className="box">
          <header className="box-head">
            <h2 className="box-title-text">{t('m.attention')}</h2>
            <span className="meta">{attention}</span>
          </header>
          <ul className="m-list">
            {testing.map((p) => (
              <TestRow key={`t${p.id}`} p={p} />
            ))}
            {pending.map((pr) => {
              const p = byId.get(pr.projectId);
              const c = changesOf(pr);
              const what =
                c.kind === 'delete_task' || c.kind === 'delete_phase'
                  ? c.lines[0]?.text.replace(/^#\d+ /, '')
                  : c.kind === 'set_status'
                    ? t(`lifecycle.${c.to}` as MessageKey)
                    : '';
              return (
                <ProposalRow
                  key={`p${pr.id}`}
                  id={pr.id}
                  project={p}
                  text={`${t(`proposals.kind.${pr.kind}` as MessageKey)}${what ? ` «${what}»` : ''}`}
                  at={pr.createdAt}
                />
              );
            })}
            {stuck.map((p) => (
              <li key={`s${p.id}`} className="m-item">
                <span className="m-dot m-dot-danger" aria-hidden="true" />
                <div className="m-body">
                  <div className="m-row">
                    <Link className="m-name" to={`/p/${p.slug}`}>
                      {p.name}
                    </Link>
                    <span className="meta">
                      <RelativeTime iso={p.lastActivityAt} />
                    </span>
                  </div>
                  <p className="m-text">{t(p.nextTask ? 'm.stalled' : 'badge.no_next_step')}</p>
                  <Link className="btn btn-default btn-md" to={`/p/${p.slug}`}>
                    {t('dash.action.pickStep')}
                  </Link>
                </div>
              </li>
            ))}
          </ul>
        </section>
      )}

      {!queueIsEmpty(queue.data) && queue.data && (
        <section className="box box-ai m-claude" aria-label={t('queue.title')}>
          <div className="box-body">
            <h2 className="m-claude-title">
              {queue.data.running.length > 0 && (
                <span className="dot dot-live" aria-hidden="true" />
              )}
              {t('queue.title')}{' '}
              <span className="meta">
                {t('queue.counts', {
                  running: queue.data.running.length,
                  ended: queue.data.ended.length,
                })}
              </span>
            </h2>
            <ul className="claude-queue-list">
              {[...queue.data.running, ...queue.data.ended].map((item) => (
                <QueueRow key={item.sessionId} item={item} />
              ))}
            </ul>
          </div>
        </section>
      )}

      <section className="box">
        <header className="box-head">
          <h2 className="box-title-text">{t('m.all')}</h2>
          <button
            type="button"
            className="link-btn m-filters"
            aria-expanded={showFilters}
            onClick={() => setShowFilters(!showFilters)}
          >
            {t('dash.filters')} ▾
          </button>
        </header>
        {showFilters && (
          <div className="box-body m-filter-panel">
            <label className="sr-only" htmlFor="m-filter">
              {t('dash.filterText')}
            </label>
            <input
              id="m-filter"
              type="search"
              placeholder={t('dash.filterText')}
              value={f.text}
              onChange={(e) => setF({ ...f, text: e.target.value })}
            />
            <div className="m-chips">
              {LIFECYCLE_STATUSES.map((s: LifecycleStatus) => (
                <button
                  key={s}
                  type="button"
                  className={`chip${f.statuses.includes(s) ? ' active' : ''}`}
                  aria-pressed={f.statuses.includes(s)}
                  onClick={() => setF({ ...f, statuses: toggle(f.statuses, s) })}
                >
                  {t(`lifecycle.${s}` as MessageKey)}
                </button>
              ))}
            </div>
            <label className="check">
              <input
                type="checkbox"
                checked={f.showClosed}
                onChange={(e) => setF({ ...f, showClosed: e.target.checked })}
              />
              {t('dash.showClosed')}
            </label>
          </div>
        )}
        {shown.length === 0 ? (
          <p className="box-body muted">{t('dash.noMatch.title')}</p>
        ) : (
          <ul className="m-list">
            {shown.map((p) => (
              <li key={p.id} className="m-item m-project">
                <div className="m-row">
                  <Link className="m-name" to={`/p/${p.slug}`}>
                    {p.name}
                  </Link>
                  <StatusLabel badge={p.badge} />
                </div>
                <p className={`m-text${p.nextTask ? '' : ' next-missing'}`}>
                  {p.nextTask?.title ??
                    (CLOSED.includes(p.lifecycleStatus) ? '' : t('badge.no_next_step'))}
                </p>
                <div className="m-row">
                  <ProgressBar progress={p.progress} />
                  <span className="meta m-pct">
                    {Math.round(p.progress.ratio * 100)}% · <RelativeTime iso={p.lastActivityAt} />
                  </span>
                </div>
              </li>
            ))}
          </ul>
        )}
      </section>
    </div>
  );
}

function TestRow({ p }: { p: ProjectSummary }) {
  const t = useT();
  const notices = useNotices();
  const record = useApiMutation((passed: boolean) => api.testOutcome(p.slug, { passed }), {
    invalidate: () => [keys.project(p.slug)],
    onSuccess: (_r, passed) =>
      notices.info(passed ? 'tests.recordedPassed' : 'tests.recordedFailed'),
  });
  return (
    <li className="m-item">
      <span className="m-dot m-dot-attention" aria-hidden="true" />
      <div className="m-body">
        <div className="m-row">
          <Link className="m-name" to={`/p/${p.slug}`}>
            {p.name}
          </Link>
          <span className="meta">
            <RelativeTime iso={p.statusChangedAt} />
          </span>
        </div>
        <p className="m-text">
          {t('m.test')}: {p.statusNote || t('tests.noNote')}
        </p>
        <div className="m-actions">
          <button
            type="button"
            className="btn btn-default btn-md"
            disabled={record.isPending}
            onClick={() => record.mutate(true)}
          >
            {t('tests.passed')}
          </button>
          <button
            type="button"
            className="btn btn-default btn-md"
            disabled={record.isPending}
            onClick={() => record.mutate(false)}
          >
            {t('tests.failed')}
          </button>
        </div>
      </div>
    </li>
  );
}

function ProposalRow({
  id,
  project,
  text,
  at,
}: {
  id: number;
  project?: ProjectSummary;
  text: string;
  at: string;
}) {
  const t = useT();
  const notices = useNotices();
  const decide = useApiMutation(
    (approve: boolean) => (approve ? api.approveProposal(id) : api.rejectProposal(id)),
    {
      invalidate: () => [
        ['proposals'],
        keys.proposals,
        ...(project ? [keys.project(project.slug)] : []),
      ],
      onSuccess: (_r, approve) =>
        notices.info(approve ? 'proposals.approved' : 'proposals.rejected'),
    },
  );
  return (
    <li className="m-item">
      <span className="m-dot m-dot-ai" aria-hidden="true" />
      <div className="m-body">
        <div className="m-row">
          {project ? (
            <Link className="m-name" to={`/p/${project.slug}`}>
              {project.name}
            </Link>
          ) : (
            <span className="m-name">#{id}</span>
          )}
          <span className="meta">
            <RelativeTime iso={at} />
          </span>
        </div>
        <p className="m-text">
          {t('m.proposal')}: {text}
        </p>
        <div className="m-actions">
          <button
            type="button"
            className="btn btn-default btn-md"
            disabled={decide.isPending}
            onClick={() => decide.mutate(true)}
          >
            {t('proposals.approve')}
          </button>
          <button
            type="button"
            className="btn btn-default btn-md"
            disabled={decide.isPending}
            onClick={() => decide.mutate(false)}
          >
            {t('proposals.reject')}
          </button>
        </div>
      </div>
    </li>
  );
}
