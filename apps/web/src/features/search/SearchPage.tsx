import type { SearchHit } from '@heph/schema';
import { useQuery } from '@tanstack/react-query';
import { Fragment } from 'react';
import { Link, useSearchParams } from 'react-router';
import { api } from '../../api/client.js';
import { Alert, Box, Button, EmptyState, Skeleton } from '../../components/ui.js';
import { type MessageKey, useT } from '../../i18n/index.js';
import { errorKey } from '../../lib/errors.js';

const GROUPS: { key: MessageKey; kinds: SearchHit['kind'][] }[] = [
  { key: 'search.tasks', kinds: ['task', 'phase'] },
  { key: 'search.diary', kinds: ['diary'] },
  { key: 'search.docs', kinds: ['internal_docs', 'repo_docs'] },
  { key: 'search.projects', kinds: ['project'] },
];

/** Search (mockup 30): results grouped by kind, matches highlighted. */
export function SearchPage() {
  const t = useT();
  const [params] = useSearchParams();
  const q = (params.get('q') ?? '').trim();
  const res = useQuery({
    queryKey: ['search', q],
    queryFn: () => api.search(q),
    enabled: q.length > 0,
    refetchInterval: false,
  });
  return (
    <main className="page">
      <h1 className="page-title">{q ? t('search.titleFor', { q }) : t('search.title')}</h1>
      {!q ? (
        <p className="muted">{t('search.hint')}</p>
      ) : res.isPending ? (
        <Skeleton lines={5} />
      ) : res.isError ? (
        <Alert
          tone="danger"
          action={<Button onClick={() => res.refetch()}>{t('common.retry')}</Button>}
        >
          {t(errorKey(res.error))}
        </Alert>
      ) : res.data.length === 0 ? (
        <Box>
          <EmptyState title={t('search.none.title')} text={t('search.none.text')} />
        </Box>
      ) : (
        <div className="stack">
          {GROUPS.map((g) => {
            const hits = res.data.filter((h) => g.kinds.includes(h.kind));
            return hits.length ? (
              <Box key={g.key} title={t(g.key)} meta={String(hits.length)}>
                <ul className="hits">
                  {hits.map((h) => (
                    <li key={`${h.kind}-${h.refId}`}>
                      <Link to={hitLink(h)}>{h.title || h.projectName}</Link>
                      <span className="tag">{h.projectName}</span>
                      <p className="snippet">
                        <Snippet html={h.snippet} />
                      </p>
                    </li>
                  ))}
                </ul>
              </Box>
            ) : null;
          })}
        </div>
      )}
    </main>
  );
}

function hitLink(h: SearchHit): string {
  const base = `/p/${h.projectSlug}`;
  if (h.kind === 'task' || h.kind === 'phase') return `${base}/roadmap`;
  if (h.kind === 'diary') return `${base}/diary`;
  if (h.kind === 'internal_docs' || h.kind === 'repo_docs') return `${base}/docs`;
  return base;
}

/**
 * The server snippet is HTML-escaped text with `<mark>` around matches. Render it as
 * text nodes and <mark> elements, never as HTML.
 */
export function Snippet({ html }: { html: string }) {
  const parts = html.split(/(<mark>|<\/mark>)/);
  let marked = false;
  return (
    <>
      {parts.map((p, i) => {
        if (p === '<mark>') {
          marked = true;
          return null;
        }
        if (p === '</mark>') {
          marked = false;
          return null;
        }
        const text = decode(p);
        // biome-ignore lint/suspicious/noArrayIndexKey: static split
        return marked ? <mark key={i}>{text}</mark> : <Fragment key={i}>{text}</Fragment>;
      })}
    </>
  );
}

function decode(s: string): string {
  return s
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&amp;/g, '&');
}
