import type { DiaryEntryView, GitHubVerifyView } from '@heph/schema';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { useState } from 'react';
import { Link } from 'react-router';
import { api } from '../../api/client.js';
import { keys, useApiMutation } from '../../api/queries.js';
import { Alert, Button, RelativeTime } from '../../components/ui.js';
import { type MessageKey, useT } from '../../i18n/index.js';

/** GitHub sync status (D61), polled like the rest of the visible screen (D52). */
export function useGitHubStatus() {
  return useQuery({ queryKey: ['github', 'status'], queryFn: api.githubStatus });
}

/** Dashboard alert (design 52): the token stopped working, or GitHub limits the calls. */
export function GitHubAlert() {
  const t = useT();
  const s = useGitHubStatus();
  if (!s.data?.tokenSet || !s.data.error) return null;
  if (s.data.error === 'token_invalid') {
    return (
      <Alert
        tone="danger"
        action={
          <Link className="btn btn-default btn-sm" to="/settings#s-github">
            {t('github.updateToken')}
          </Link>
        }
      >
        {t('github.tokenInvalid')}
      </Alert>
    );
  }
  return (
    <Alert tone="attention">
      {t('github.rateLimited')} {s.data.resetAt && <RelativeTime iso={s.data.resetAt} />}
    </Alert>
  );
}

/** Settings > GitHub: last sync, Verify and Remove token (mockup 31). */
export function GitHubSettings({ tokenSet }: { tokenSet: boolean }) {
  const t = useT();
  const qc = useQueryClient();
  const s = useGitHubStatus();
  const [verify, setVerify] = useState<GitHubVerifyView | null>(null);
  const check = useApiMutation(() => api.githubVerify(), { onSuccess: (r) => setVerify(r) });
  const remove = useApiMutation(() => api.updateSettings({ githubToken: null }), {
    onSuccess: (r) => {
      qc.setQueryData(keys.settings, r);
      setVerify(null);
      void qc.invalidateQueries({ queryKey: ['github'] });
    },
  });
  return (
    <div className="stack">
      <p className="meta">
        {!tokenSet ? (
          t('github.noToken')
        ) : s.data?.error === 'token_invalid' ? (
          t('github.tokenInvalid')
        ) : s.data?.lastSyncAt ? (
          <>
            {t('github.lastSync')} <RelativeTime iso={s.data.lastSyncAt} />
          </>
        ) : (
          t('github.neverSynced')
        )}
      </p>
      {tokenSet && (
        <div className="row">
          <Button size="sm" disabled={check.isPending} onClick={() => check.mutate(undefined)}>
            {t('github.verify')}
          </Button>
          <Button size="sm" variant="danger" onClick={() => remove.mutate(undefined)}>
            {t('github.removeToken')}
          </Button>
        </div>
      )}
      {verify && (
        <p className={`hint${verify.ok ? ' ok' : ' error'}`} role="status">
          {verify.ok
            ? t('github.valid', { login: verify.login, n: verify.repoCount })
            : t(`github.verify.${verify.error}` as MessageKey)}
        </p>
      )}
    </div>
  );
}

/** Fixed text per repo sync error (D44), with what to do. */
export function repoErrorKey(error: string | null): MessageKey | null {
  if (error === 'not_found') return 'github.repo.notFound';
  if (error === 'unavailable') return 'github.repo.unavailable';
  if (error === 'docs_not_utf8') return 'github.repo.notUtf8';
  return null;
}

interface CommitData {
  sha: string;
  message: string;
  url: string;
}

/** A `commits` or `release` diary event from GitHub (design 12 and 04). */
export function GitHubEventBody({ entry }: { entry: DiaryEntryView }) {
  const t = useT();
  const d = entry.data ?? {};
  if (entry.eventKind === 'release') {
    return (
      <p className="gh-line">
        <a href={String(d.url ?? '')} target="_blank" rel="noreferrer">
          {entry.body}
        </a>
        {d.repo ? <span className="meta"> · {String(d.repo)}</span> : null}
      </p>
    );
  }
  const commits = (Array.isArray(d.commits) ? d.commits : []) as CommitData[];
  const count = Number(d.count ?? commits.length);
  return (
    <>
      <p className="gh-title">
        <strong>{t('github.commitsOn', { n: count, branch: String(d.branch ?? '') })}</strong>
        {d.repo ? <span className="meta"> · {String(d.repo)}</span> : null}
      </p>
      <ul className="gh-commits">
        {commits.map((c) => (
          <li key={c.sha}>
            <a href={c.url} target="_blank" rel="noreferrer">
              <code>{c.sha.slice(0, 7)}</code>
            </a>{' '}
            {c.message}
          </li>
        ))}
      </ul>
      {count > commits.length && (
        <p className="meta">{t('github.moreCommits', { n: count - commits.length })}</p>
      )}
    </>
  );
}
