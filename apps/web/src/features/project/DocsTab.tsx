import type { ProjectDocsView } from '@heph/schema';
import { useQuery } from '@tanstack/react-query';
import { useState } from 'react';
import { Link } from 'react-router';
import { api } from '../../api/client.js';
import { useApiMutation } from '../../api/queries.js';
import { useNotices } from '../../app/notices.js';
import { Markdown, MarkdownEditor } from '../../components/markdown.js';
import { Alert, Box, Button, EmptyState, RelativeTime, Skeleton } from '../../components/ui.js';
import { useT } from '../../i18n/index.js';
import { errorKey } from '../../lib/errors.js';
import { repoErrorKey, useGitHubStatus } from '../github/GitHub.js';

/**
 * Documentation (mockup 13, D30): internal docs are edited here; repo docs are read
 * only, one section per linked repo, synced from GitHub (D61-D63) or the Stop hook (D58).
 */
export function DocsTab({ projectRef }: { projectRef: string }) {
  const t = useT();
  const q = useQuery({ queryKey: ['docs', projectRef], queryFn: () => api.docs(projectRef) });
  if (q.isPending) return <Skeleton lines={6} />;
  if (q.isError) {
    return (
      <Alert
        tone="danger"
        action={<Button onClick={() => q.refetch()}>{t('common.retry')}</Button>}
      >
        {t(errorKey(q.error))}
      </Alert>
    );
  }
  return q.data.source === 'internal' ? (
    <InternalDocs projectRef={projectRef} docs={q.data} />
  ) : (
    <RepoDocs projectRef={projectRef} docs={q.data} />
  );
}

function InternalDocs({ projectRef, docs }: { projectRef: string; docs: ProjectDocsView }) {
  const t = useT();
  const [editing, setEditing] = useState(false);
  const [text, setText] = useState(docs.internal);
  const save = useApiMutation(() => api.updateProject(projectRef, { internalDocs: text }), {
    invalidate: () => [['docs', projectRef]],
    onSuccess: () => setEditing(false),
  });
  if (editing) {
    return (
      <Box title={t('docs.internal')}>
        <MarkdownEditor
          label={t('docs.internal')}
          value={text}
          onChange={setText}
          rows={16}
          allowEmpty
          onSubmit={() => save.mutate(undefined)}
          submitLabel={t('common.save')}
          busy={save.isPending}
        />
        <Button
          onClick={() => {
            setText(docs.internal);
            setEditing(false);
          }}
        >
          {t('common.cancel')}
        </Button>
      </Box>
    );
  }
  return (
    <Box
      title={t('docs.internal')}
      actions={
        <Button
          size="sm"
          onClick={() => {
            setText(docs.internal);
            setEditing(true);
          }}
        >
          {t('roadmap.edit')}
        </Button>
      }
    >
      {docs.internal.trim() ? (
        <DocBody text={docs.internal} />
      ) : (
        <EmptyState title={t('docs.empty.title')} text={t('docs.empty.text')} />
      )}
    </Box>
  );
}

function RepoDocs({ projectRef, docs }: { projectRef: string; docs: ProjectDocsView }) {
  const t = useT();
  const notices = useNotices();
  const status = useGitHubStatus();
  const sync = useApiMutation(() => api.githubSync(projectRef), {
    invalidate: () => [['docs', projectRef], ['project', projectRef], ['diary'], ['github']],
    onSuccess: (r) => {
      if (r.skipped === 'rate_limited') notices.info('github.rateLimited');
      else if (r.skipped !== 'no_token') notices.info('github.synced');
    },
  });
  const noToken = status.data !== undefined && !status.data.tokenSet;
  if (docs.repos.length === 0) {
    return (
      <Box>
        <EmptyState title={t('docs.noRepo.title')} text={t('docs.noRepo.text')} />
      </Box>
    );
  }
  return (
    <div className="stack">
      {noToken && (
        <Alert
          tone="attention"
          action={
            <Link className="btn btn-default btn-sm" to="/settings#s-github">
              {t('github.setToken')}
            </Link>
          }
        >
          {t('github.noTokenDocs')}
        </Alert>
      )}
      {docs.repos.map((r) => {
        const err = repoErrorKey(r.lastSyncError);
        const blob = `https://github.com/${r.fullName}/blob/${r.defaultBranch ?? 'HEAD'}/${r.docsPath}`;
        return (
          <Box
            key={r.id}
            title={`${r.fullName} · ${r.docsPath}`}
            actions={
              <a className="btn btn-default btn-sm" href={blob} target="_blank" rel="noreferrer">
                {t('github.openOnGitHub')}
              </a>
            }
          >
            <Alert
              tone="info"
              action={
                <Button
                  size="sm"
                  disabled={noToken || sync.isPending}
                  title={noToken ? t('github.noToken') : undefined}
                  onClick={() => sync.mutate(undefined)}
                >
                  {t('docs.syncNow')}
                </Button>
              }
            >
              {t('docs.readOnly')}{' '}
              {r.docsUpdatedAt ? (
                <>
                  {t(r.docsOrigin === 'hook' ? 'docs.fromHook' : 'docs.fromGitHub')}{' '}
                  <RelativeTime iso={r.docsUpdatedAt} />
                </>
              ) : (
                t('docs.notSynced')
              )}
            </Alert>
            {err && <Alert tone="danger">{t(err)}</Alert>}
            {r.commits.length > 0 && (
              <details className="doc-commits">
                <summary>
                  {t('docs.lastChange', {
                    author: r.commits[0]?.author ?? '?',
                    sha: r.commits[0]?.sha.slice(0, 7) ?? '',
                  })}{' '}
                  <RelativeTime iso={r.commits[0]?.date ?? ''} />
                </summary>
                <ul className="gh-commits">
                  {r.commits.map((c) => (
                    <li key={c.sha}>
                      <a href={c.url} target="_blank" rel="noreferrer">
                        <code>{c.sha.slice(0, 7)}</code>
                      </a>{' '}
                      {c.message} <span className="meta">· {c.author ?? '?'}</span>
                    </li>
                  ))}
                </ul>
              </details>
            )}
            {r.content?.trim() ? <DocBody text={r.content} /> : null}
          </Box>
        );
      })}
    </div>
  );
}

/** Rendered document with an index of its headings (mockup 13). */
function DocBody({ text }: { text: string }) {
  const t = useT();
  const index = headings(text);
  return (
    <div className="doc">
      {index.length > 2 && (
        <nav className="doc-index" aria-label={t('docs.index')}>
          <ol>
            {index.map((h, i) => (
              // biome-ignore lint/suspicious/noArrayIndexKey: headings can repeat
              <li key={i} className={`lvl-${h.level}`}>
                {h.text}
              </li>
            ))}
          </ol>
        </nav>
      )}
      <Markdown text={text} />
    </div>
  );
}

/** ATX headings (levels 1–3) outside fenced code. */
export function headings(md: string): { level: number; text: string }[] {
  const out: { level: number; text: string }[] = [];
  let fence = false;
  for (const line of md.split(/\r?\n/)) {
    if (/^\s{0,3}(```|~~~)/.test(line)) fence = !fence;
    if (fence) continue;
    const m = /^\s{0,3}(#{1,3})\s+(.+?)\s*#*\s*$/.exec(line);
    if (m?.[1] && m[2]) out.push({ level: m[1].length, text: m[2] });
  }
  return out;
}
