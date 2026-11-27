import type { ProposalState, ProposalView } from '@heph/schema';
import { useQuery } from '@tanstack/react-query';
import { useState } from 'react';
import { Link } from 'react-router';
import { api } from '../../api/client.js';
import { keys, useApiMutation, useProjects } from '../../api/queries.js';
import { useNotices } from '../../app/notices.js';
import {
  Alert,
  Box,
  Button,
  EmptyState,
  Field,
  RelativeTime,
  Segmented,
  Skeleton,
  SourceAvatar,
} from '../../components/ui.js';
import { type MessageKey, useT } from '../../i18n/index.js';
import { errorKey } from '../../lib/errors.js';
import { changeText } from '../changes/describe.js';
import { changesOf } from './changes.js';

/**
 * Proposals (mockup 03): pending / approved / rejected like pull requests. Nothing
 * changes until approved; the optional note is read by Claude (D32).
 */
export function ProposalsView({ projectRef }: { projectRef?: string }) {
  const t = useT();
  const [state, setState] = useState<ProposalState>('pending');
  const q = useQuery({
    queryKey: ['proposals', state, projectRef ?? null],
    queryFn: () => api.proposalsOf(projectRef ?? null, state),
  });
  const projects = useProjects();
  const project = (id: number) => projects.data?.find((p) => p.id === id);
  return (
    <div className="stack">
      <Segmented<ProposalState>
        label={t('proposals.state')}
        value={state}
        onChange={setState}
        options={(['pending', 'approved', 'rejected'] as const).map((s) => ({
          value: s,
          label: t(`proposals.state.${s}` as MessageKey),
        }))}
      />
      {q.isPending ? (
        <Skeleton lines={4} />
      ) : q.isError ? (
        <Alert
          tone="danger"
          action={<Button onClick={() => q.refetch()}>{t('common.retry')}</Button>}
        >
          {t(errorKey(q.error))}
        </Alert>
      ) : q.data.length === 0 ? (
        <Box>
          <EmptyState title={t('proposals.empty.title')} text={t('proposals.empty.text')} />
        </Box>
      ) : (
        q.data.map((p) => <ProposalBox key={p.id} p={p} projectName={project(p.projectId)} />)
      )}
    </div>
  );
}

function ProposalBox({
  p,
  projectName,
}: {
  p: ProposalView;
  projectName?: { name: string; slug: string; lifecycleStatus: string };
}) {
  const t = useT();
  const notices = useNotices();
  const [note, setNote] = useState('');
  const decide = useApiMutation(
    (approve: boolean) =>
      approve
        ? api.approveProposal(p.id, note.trim() || undefined)
        : api.rejectProposal(p.id, note.trim() || undefined),
    {
      invalidate: () => [
        ['proposals'],
        keys.proposals,
        ...(projectName ? [keys.project(projectName.slug)] : []),
      ],
      onSuccess: (_r, approve) =>
        notices.info(approve ? 'proposals.approved' : 'proposals.rejected'),
    },
  );
  const c = changesOf(p);
  return (
    <Box
      tone={p.state === 'pending' ? 'ai' : undefined}
      title={`#${p.id} · ${t(`proposals.kind.${p.kind}` as MessageKey)}`}
      meta={
        <>
          <SourceAvatar source={p.createdBy} />{' '}
          {projectName && <Link to={`/p/${projectName.slug}`}>{projectName.name}</Link>} ·{' '}
          <RelativeTime iso={p.createdAt} />
        </>
      }
    >
      {p.reason && (
        <>
          <h3 className="small-title">{t('proposals.reason')}</h3>
          <p className="pre">{p.reason}</p>
        </>
      )}
      <h3 className="small-title">{t('proposals.changes')}</h3>
      {c.kind === 'set_status' ? (
        <p>
          {t('proposals.statusChange', {
            // Older proposals have no `from`: only a pending one can use the current status.
            from: c.from
              ? t(`lifecycle.${c.from}` as MessageKey)
              : p.state === 'pending' && projectName
                ? t(`lifecycle.${projectName.lifecycleStatus}` as MessageKey)
                : '—',
            to: t(`lifecycle.${c.to}` as MessageKey),
          })}
          {c.note && <span className="pre"> — {c.note}</span>}
        </p>
      ) : c.kind === 'revert_change' ? (
        <RevertTarget changeId={c.changeId} summary={c.summary} />
      ) : c.kind === 'unknown' ? (
        <p className="muted">{t('proposals.unknown')}</p>
      ) : (
        <pre className="diff">
          {c.lines.map((l, i) => (
            // biome-ignore lint/suspicious/noArrayIndexKey: lines can repeat
            <span key={i} className={`diff-${l.op}`}>
              {l.op === 'remove' ? '- ' : l.op === 'add' ? '+ ' : '  '}
              {l.text}
              {'\n'}
            </span>
          ))}
          {c.kind === 'delete_phase' && (
            <span className="diff-remove">{`- ${t('proposals.andTasks', { n: c.taskCount })}\n`}</span>
          )}
        </pre>
      )}
      {p.state === 'pending' ? (
        <>
          <Field label={t('proposals.note')} htmlFor={`pn-${p.id}`} hint={t('proposals.noteHint')}>
            <textarea
              id={`pn-${p.id}`}
              rows={2}
              value={note}
              onChange={(e) => setNote(e.target.value)}
            />
          </Field>
          <div className="row">
            <Button
              variant="primary"
              disabled={decide.isPending}
              onClick={() => decide.mutate(true)}
            >
              {t('proposals.approve')}
            </Button>
            <Button
              variant="danger"
              disabled={decide.isPending}
              onClick={() => decide.mutate(false)}
            >
              {t('proposals.reject')}
            </Button>
          </div>
        </>
      ) : (
        <p className="meta">
          {t(`proposals.state.${p.state}` as MessageKey)}
          {p.decidedAt && (
            <>
              {' '}
              · <RelativeTime iso={p.decidedAt} />
            </>
          )}
          {p.decisionNote && <span className="pre"> — {p.decisionNote}</span>}
        </p>
      )}
    </Box>
  );
}

/** What a revert proposal undoes (D75): the change, translated when it can be read. */
function RevertTarget({ changeId, summary }: { changeId: number; summary: string }) {
  const t = useT();
  const q = useQuery({ queryKey: ['change', changeId], queryFn: () => api.change(changeId) });
  return (
    <p>
      {t('proposals.revertOf', {
        id: changeId,
        what: q.data ? changeText(q.data, t) : summary,
      })}
    </p>
  );
}
