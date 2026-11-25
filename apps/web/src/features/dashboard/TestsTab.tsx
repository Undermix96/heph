import type { ProjectSummary } from '@heph/schema';
import { BeakerIcon } from '@primer/octicons-react';
import { useQuery } from '@tanstack/react-query';
import { useState } from 'react';
import { Link } from 'react-router';
import { api } from '../../api/client.js';
import { keys, useApiMutation, useProjects } from '../../api/queries.js';
import { useNotices } from '../../app/notices.js';
import { Box, Button, EmptyState, Field, RelativeTime } from '../../components/ui.js';
import { useT } from '../../i18n/index.js';

/** Pending manual tests (mockup 02): what to check, the outcome, Passed / Failed. */
export function TestsTab({ projects }: { projects: ProjectSummary[] }) {
  const t = useT();
  if (projects.length === 0) {
    return (
      <div className="stack">
        <Box>
          <EmptyState
            icon={<BeakerIcon size={24} />}
            title={t('tests.empty.title')}
            text={t('tests.empty.text')}
          />
        </Box>
        <TestHistory />
      </div>
    );
  }
  return (
    <div className="stack">
      {projects.map((p) => (
        <PendingTest key={p.id} p={p} />
      ))}
      <TestHistory />
    </div>
  );
}

function PendingTest({ p }: { p: ProjectSummary }) {
  const t = useT();
  const notices = useNotices();
  const [notes, setNotes] = useState('');
  const record = useApiMutation(
    (passed: boolean) => api.testOutcome(p.slug, { passed, notes: notes.trim() || undefined }),
    {
      invalidate: () => [keys.project(p.slug)],
      onSuccess: (_r, passed) => {
        setNotes('');
        notices.info(passed ? 'tests.recordedPassed' : 'tests.recordedFailed');
      },
    },
  );
  const id = `outcome-${p.id}`;
  return (
    <Box
      tone="attention"
      title={<Link to={`/p/${p.slug}`}>{p.name}</Link>}
      meta={
        <>
          {t('tests.since')} <RelativeTime iso={p.statusChangedAt} />
        </>
      }
    >
      <h3 className="small-title">{t('tests.whatToCheck')}</h3>
      <p className="pre">{p.statusNote || t('tests.noNote')}</p>
      <Field label={t('tests.outcome')} htmlFor={id} hint={t('tests.outcomeHint')}>
        <textarea id={id} rows={3} value={notes} onChange={(e) => setNotes(e.target.value)} />
      </Field>
      <div className="row">
        <Button variant="primary" disabled={record.isPending} onClick={() => record.mutate(true)}>
          {t('tests.passed')}
        </Button>
        <Button variant="danger" disabled={record.isPending} onClick={() => record.mutate(false)}>
          {t('tests.failed')}
        </Button>
      </div>
    </Box>
  );
}

/** Past outcomes: test_outcome events from the diary of every project, newest first. */
function TestHistory() {
  const t = useT();
  const projects = useProjects();
  const q = useQuery({
    queryKey: ['diary', 'tests'],
    queryFn: () => api.diaryPage(null, { type: 'event', limit: 200 }),
  });
  const outcomes = (q.data ?? []).filter((e) => e.eventKind === 'test_outcome');
  const name = (id: number) => projects.data?.find((p) => p.id === id);
  return (
    <Box title={t('tests.history')}>
      {outcomes.length === 0 ? (
        <p className="muted">{t(q.isPending ? 'common.loading' : 'tests.historyEmpty')}</p>
      ) : (
        <ul className="history">
          {outcomes.map((e) => {
            const passed = e.data?.passed === true;
            const p = name(e.projectId);
            return (
              <li key={e.id}>
                <span className={`status ${passed ? 'status-success' : 'status-danger'}`}>
                  {t(passed ? 'tests.passed' : 'tests.failed')}
                </span>
                {p && <Link to={`/p/${p.slug}/diary`}>{p.name}</Link>}
                <span className="meta">
                  <RelativeTime iso={e.occurredAt} />
                </span>
              </li>
            );
          })}
        </ul>
      )}
    </Box>
  );
}
