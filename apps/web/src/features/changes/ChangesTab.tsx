import type { ChangeView } from '@heph/schema';
import { useInfiniteQuery } from '@tanstack/react-query';
import { useState } from 'react';
import { ApiError, api } from '../../api/client.js';
import { keys, useApiMutation } from '../../api/queries.js';
import { useNotices } from '../../app/notices.js';
import {
  Alert,
  Box,
  Button,
  Dialog,
  EmptyState,
  RelativeTime,
  Segmented,
  Skeleton,
  SourceAvatar,
} from '../../components/ui.js';
import { useT } from '../../i18n/index.js';
import { errorKey } from '../../lib/errors.js';
import { BlockedText } from './Blocked.js';
import { changeText, refusalOf } from './describe.js';

const PAGE = 50;
type Filter = 'revertible' | 'all';

/**
 * Changes tab of the project page (D74): what changed, who did it and when;
 * revertible changes have "Undo change", which asks for confirmation first.
 */
export function ChangesTab({ projectRef }: { projectRef: string }) {
  const t = useT();
  const [filter, setFilter] = useState<Filter>('revertible');
  const [confirm, setConfirm] = useState<ChangeView | null>(null);
  const [blocked, setBlocked] = useState<number | null>(null);
  const q = useInfiniteQuery({
    queryKey: ['changes', projectRef, filter],
    queryFn: ({ pageParam }) =>
      api.changes(projectRef, {
        limit: PAGE,
        revertible: filter === 'revertible',
        before: pageParam,
      }),
    initialPageParam: undefined as number | undefined,
    getNextPageParam: (last) => (last.length < PAGE ? undefined : last.at(-1)?.id),
    // Keep the list (and an open dialog) while another filter loads.
    placeholderData: (prev) => prev,
  });

  const head = (
    <Segmented<Filter>
      label={t('changes.filter')}
      value={filter}
      onChange={setFilter}
      options={[
        { value: 'revertible', label: t('changes.filter.revertible') },
        { value: 'all', label: t('changes.filter.all') },
      ]}
    />
  );

  if (q.isPending) return <Skeleton lines={5} />;
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
  const items = q.data.pages.flat();

  return (
    <div className="stack">
      <p className="muted">{t('changes.intro')}</p>
      {head}
      {items.length === 0 ? (
        <Box>
          <EmptyState title={t('changes.empty.title')} text={t('changes.empty.text')} />
        </Box>
      ) : (
        <Box>
          <div className="table-wrap">
            <table className="table changes-table">
              <thead>
                <tr>
                  <th scope="col">{t('changes.col.change')}</th>
                  <th scope="col">{t('changes.col.who')}</th>
                  <th scope="col">{t('changes.col.when')}</th>
                  <th scope="col">
                    <span className="sr-only">{t('changes.col.state')}</span>
                  </th>
                </tr>
              </thead>
              <tbody>
                {items.map((c) => (
                  <tr key={c.id} className={blocked === c.id ? 'row-highlight' : undefined}>
                    <td>
                      <span className={c.revertedAt ? 'reverted' : undefined}>
                        {changeText(c, t)}
                      </span>{' '}
                      <span className="meta">#{c.id}</span>
                    </td>
                    <td>
                      <SourceAvatar source={c.source} />
                    </td>
                    <td className="nowrap">
                      <RelativeTime iso={c.createdAt} />
                    </td>
                    <td className="nowrap">
                      {c.revertedAt ? (
                        <span className="meta">
                          {t('changes.reverted')} <RelativeTime iso={c.revertedAt} />
                        </span>
                      ) : c.revertible ? (
                        <Button
                          size="sm"
                          aria-label={t('changes.undoOf', { what: changeText(c, t) })}
                          onClick={() => setConfirm(c)}
                        >
                          {t('changes.undo')}
                        </Button>
                      ) : (
                        <span className="meta">{t('changes.notRevertible')}</span>
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          {q.hasNextPage && (
            <div className="row">
              <Button disabled={q.isFetchingNextPage} onClick={() => q.fetchNextPage()}>
                {t('changes.more')}
              </Button>
            </div>
          )}
        </Box>
      )}
      {confirm && (
        <ConfirmRevert
          change={confirm}
          projectRef={projectRef}
          onBlocked={(id) => {
            setBlocked(id);
            // The later change may be one that cannot be reverted: show every change
            // so it is in the list and highlighted (verification B9).
            if (id !== null) setFilter('all');
          }}
          onClose={() => setConfirm(null)}
        />
      )}
    </div>
  );
}

function ConfirmRevert({
  change,
  projectRef,
  onBlocked,
  onClose,
}: {
  change: ChangeView;
  projectRef: string;
  onBlocked: (id: number | null) => void;
  onClose: () => void;
}) {
  const t = useT();
  const notices = useNotices();
  const [error, setError] = useState<unknown>(null);
  const revert = useApiMutation((id: number) => api.revertChange(id), {
    invalidate: () => [
      ['changes', projectRef],
      keys.project(projectRef),
      ['diary'],
      ['materials', projectRef],
      ['proposals'],
    ],
    quietErrors: true,
    onSuccess: () => {
      onBlocked(null);
      notices.info('changes.done');
      onClose();
    },
  });
  // Refusals are shown in the dialog with their reason, not as a generic notice.
  const run = () => {
    setError(null);
    revert.mutate(change.id, {
      onError: (e) => {
        setError(e);
        const r = e instanceof ApiError ? refusalOf(e.details) : null;
        onBlocked(r?.kind === 'blocked' ? r.blockedBy : null);
      },
    });
  };
  const refusal = error instanceof ApiError ? refusalOf(error.details) : null;

  return (
    <Dialog
      title={t('changes.confirmTitle')}
      onClose={onClose}
      actions={
        <>
          <Button onClick={onClose}>{t('changes.keep')}</Button>
          <Button variant="danger" disabled={revert.isPending} onClick={run}>
            {t('changes.undo')}
          </Button>
        </>
      }
    >
      <p>
        <strong>{changeText(change, t)}</strong>
      </p>
      <p className="muted">{t('changes.confirmText')}</p>
      {error !== null && (
        <Alert tone={refusal?.kind === 'blocked' ? 'attention' : 'danger'}>
          {refusal?.kind === 'blocked' ? (
            <BlockedText blockedBy={refusal.blockedBy} where="changes" />
          ) : refusal?.kind === 'already' ? (
            t('changes.error.already')
          ) : refusal?.kind === 'gone' ? (
            t('changes.error.gone')
          ) : refusal?.kind === 'not_revertible' ? (
            t('changes.error.notRevertible')
          ) : (
            t(errorKey(error))
          )}
        </Alert>
      )}
    </Dialog>
  );
}
