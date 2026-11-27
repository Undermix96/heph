import type { ClaudeQueueView, QueueItemView } from '@heph/schema';
import { useQuery } from '@tanstack/react-query';
import { useState } from 'react';
import { Link } from 'react-router';
import { api } from '../../api/client.js';
import { RelativeTime } from '../../components/ui.js';
import { useT } from '../../i18n/index.js';

const COLLAPSED_KEY = 'heph.queue.collapsed';

/** Start of the viewer's local day, as the server expects it (D76). */
export function startOfLocalDay(now = new Date()): string {
  const d = new Date(now);
  d.setHours(0, 0, 0, 0);
  return d.toISOString();
}

/** First line of a diary entry as plain text: no heading, list or emphasis markers. */
export function firstLine(body: string): string {
  const line = body.split('\n').find((l) => l.trim() !== '') ?? '';
  return line
    .trim()
    .replace(/^(#{1,6}\s+|[-*+]\s+(\[[ xX]\]\s+)?|>\s*|\d+[.)]\s+)/, '')
    .replace(/\*\*|__|`/g, '')
    .trim();
}

/** Claude's queue data, polled like the rest of the dashboard (D52). */
export function useClaudeQueue() {
  const since = startOfLocalDay();
  return useQuery({
    queryKey: ['claude-queue', since],
    queryFn: () => api.claudeQueue(since),
  });
}

export function queueIsEmpty(q: ClaudeQueueView | undefined): boolean {
  return !q || (q.running.length === 0 && q.ended.length === 0);
}

/**
 * Floating "Claude's queue" (mockup 01, D76): running sessions first, then the
 * ones that ended today; collapsible, the choice kept in the browser. Hidden
 * when there is nothing to show.
 */
export function ClaudeQueue() {
  const t = useT();
  const q = useClaudeQueue();
  const [collapsed, setCollapsed] = useState(() => {
    try {
      return localStorage.getItem(COLLAPSED_KEY) === '1';
    } catch {
      return false;
    }
  });
  if (queueIsEmpty(q.data)) return null;
  const data = q.data as ClaudeQueueView;
  const toggle = () => {
    const next = !collapsed;
    setCollapsed(next);
    try {
      localStorage.setItem(COLLAPSED_KEY, next ? '1' : '0');
    } catch {
      // Private mode: the choice lasts until reload.
    }
  };
  return (
    <aside className="claude-queue" aria-label={t('queue.title')}>
      <header className="claude-queue-head">
        {data.running.length > 0 && <span className="dot dot-live" aria-hidden="true" />}
        <h2>{t('queue.title')}</h2>
        <span className="meta">
          {t('queue.counts', { running: data.running.length, ended: data.ended.length })}
        </span>
        <button
          type="button"
          className="claude-queue-toggle"
          aria-expanded={!collapsed}
          aria-controls="claude-queue-list"
          aria-label={t(collapsed ? 'queue.expand' : 'queue.collapse')}
          onClick={toggle}
        >
          {collapsed ? '▴' : '▾'}
        </button>
      </header>
      {!collapsed && (
        <ul className="claude-queue-list" id="claude-queue-list">
          {[...data.running, ...data.ended].map((item) => (
            <QueueRow key={item.sessionId} item={item} />
          ))}
        </ul>
      )}
    </aside>
  );
}

export function QueueRow({ item }: { item: QueueItemView }) {
  const t = useT();
  return (
    <li className={`claude-queue-item claude-queue-${item.state}`}>
      <div className="claude-queue-line">
        <Link to={`/p/${item.projectSlug}`}>{item.projectName}</Link>
        <span className="claude-queue-state">
          {item.state === 'ended' && item.endedAt ? (
            <>
              {t('queue.state.ended')} <RelativeTime iso={item.endedAt} />
            </>
          ) : (
            t(`queue.state.${item.state}`)
          )}
        </span>
      </div>
      <p className="claude-queue-text">
        {item.lastEntry ? firstLine(item.lastEntry.body) : t('queue.noEntry')}
      </p>
    </li>
  );
}
