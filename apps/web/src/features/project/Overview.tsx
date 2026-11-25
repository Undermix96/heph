import type { ProjectDetail, TaskView } from '@heph/schema';
import { CheckCircleFillIcon, CircleIcon } from '@primer/octicons-react';
import { useQuery } from '@tanstack/react-query';
import { useState } from 'react';
import { Link, useNavigate } from 'react-router';
import { api } from '../../api/client.js';
import { keys, useApiMutation } from '../../api/queries.js';
import { useNotices } from '../../app/notices.js';
import { Alert, Box, Button, Field, RelativeTime, SourceAvatar } from '../../components/ui.js';
import { useI18n, useT } from '../../i18n/index.js';
import { FormDialog } from '../roadmap/RoadmapBoard.js';
import { pathGroups } from './path.js';

/**
 * Overview (mockup 10): next step, pending test, path, current phase, latest diary.
 * After "Mark done" the server computes the new next step (D26), never the UI.
 */
export function Overview({ p }: { p: ProjectDetail }) {
  const t = useT();
  const { date } = useI18n();
  const live = p.liveSessions[0];
  const openTasks = p.phases
    .filter((ph) => ph.status !== 'done')
    .flatMap((ph) => ph.tasks.filter((x) => !x.done));
  return (
    <div className="stack">
      {live && (
        <Alert tone="ai">
          {t(live.isTesting ? 'overview.claudeTesting' : 'overview.claudeWorking', {
            since: date(live.startedAt),
          })}{' '}
          <span className="meta">
            {t('overview.lastEvent')} <RelativeTime iso={live.lastHeartbeatAt} />
          </span>
        </Alert>
      )}
      <div className="grid-2">
        {p.nextTask ? (
          <NextStepBox p={p} next={p.nextTask} openTasks={openTasks} />
        ) : (
          <NoNextStep p={p} openTasks={openTasks} />
        )}
        {p.lifecycleStatus === 'awaiting_manual_test' && (
          <Box tone="attention" title={t('overview.pendingTest')}>
            <p className="pre">{p.statusNote || t('tests.noNote')}</p>
            <Link className="btn btn-default btn-md" to="/tests">
              {t('dash.action.testOutcome')}
            </Link>
          </Box>
        )}
      </div>
      <PathBox p={p} />
      <div className="grid-2">
        <CurrentPhase p={p} />
        <LatestDiary p={p} />
      </div>
    </div>
  );
}

function NextStepBox({
  p,
  next,
  openTasks,
}: {
  p: ProjectDetail;
  next: NonNullable<ProjectDetail['nextTask']>;
  openTasks: TaskView[];
}) {
  const t = useT();
  const notices = useNotices();
  const [picking, setPicking] = useState(false);
  const done = useApiMutation(() => api.completeTask(next.id), {
    invalidate: () => [keys.project(p.slug)],
    onSuccess: () => notices.info('overview.doneNewNext'),
  });
  return (
    <Box tone="attention" title={t('overview.nextStep')} meta={next.phaseTitle}>
      <p className="next-title">{next.title}</p>
      <div className="row">
        <Button variant="primary" disabled={done.isPending} onClick={() => done.mutate(undefined)}>
          {t('overview.markDone')}
        </Button>
        <Button onClick={() => setPicking(true)} disabled={openTasks.length < 2}>
          {t('overview.pickOther')}
        </Button>
      </div>
      {picking && <PickNext p={p} tasks={openTasks} onClose={() => setPicking(false)} />}
    </Box>
  );
}

/** Mockup 53: no next step: pick an open task, create one, or put the project on hold. */
function NoNextStep({ p, openTasks }: { p: ProjectDetail; openTasks: TaskView[] }) {
  const t = useT();
  const navigate = useNavigate();
  const [picking, setPicking] = useState(false);
  return (
    <Box tone="danger" title={t('badge.no_next_step')}>
      <p>{t(openTasks.length ? 'overview.noNextPick' : 'overview.noNextCreate')}</p>
      <div className="row">
        {openTasks.length > 0 && (
          <Button variant="primary" onClick={() => setPicking(true)}>
            {t('overview.pickStep')}
          </Button>
        )}
        <Button onClick={() => navigate(`/p/${p.slug}/roadmap`)}>{t('overview.createTask')}</Button>
      </div>
      {picking && <PickNext p={p} tasks={openTasks} onClose={() => setPicking(false)} />}
    </Box>
  );
}

function PickNext({
  p,
  tasks,
  onClose,
}: {
  p: ProjectDetail;
  tasks: TaskView[];
  onClose: () => void;
}) {
  const t = useT();
  const [choice, setChoice] = useState<number>(
    tasks.find((x) => x.id !== p.nextTask?.id)?.id ?? tasks[0]?.id ?? 0,
  );
  const set = useApiMutation(() => api.setNextTask(p.slug, choice), {
    invalidate: () => [keys.project(p.slug)],
    onSuccess: onClose,
  });
  return (
    <FormDialog
      title={t('overview.pickStep')}
      onClose={onClose}
      onSubmit={() => choice && set.mutate(undefined)}
      busy={set.isPending}
      submitLabel={t('overview.setAsNext')}
    >
      <Field label={t('overview.openTasks')} htmlFor="pick-next">
        <select id="pick-next" value={choice} onChange={(e) => setChoice(Number(e.target.value))}>
          {p.phases.map((ph) => {
            const own = tasks.filter((x) => x.phaseId === ph.id);
            return own.length ? (
              <optgroup key={ph.id} label={ph.title}>
                {own.map((x) => (
                  <option key={x.id} value={x.id}>
                    {x.title}
                  </option>
                ))}
              </optgroup>
            ) : null;
          })}
        </select>
      </Field>
    </FormDialog>
  );
}

function PathBox({ p }: { p: ProjectDetail }) {
  const t = useT();
  const groups = pathGroups(p.phases, p.nextTask?.id ?? null);
  if (groups.length === 0) return null;
  const tone =
    p.lifecycleStatus === 'awaiting_manual_test'
      ? 'attention'
      : p.liveSessions.length
        ? 'ai'
        : 'accent';
  const state = (done: boolean) => t(done ? 'overview.done' : 'overview.todo');
  return (
    <Box title={t('overview.path')}>
      <ol className="path" aria-label={t('overview.path')}>
        {groups.map((g) => (
          <li key={g.id} className="path-group">
            <span className="path-label" title={g.title}>
              {g.title}
            </span>
            <ol className="path-nodes">
              <li className={`path-node path-phase${g.done ? ' done' : ''}`}>
                <span className="sr-only">
                  {g.title} · {state(g.done)}
                </span>
              </li>
              {g.tasks.map((n) => (
                <li
                  key={n.id}
                  className={`path-node path-task${n.done ? ' done' : ''}${n.here ? ` here here-${tone}` : ''}`}
                  title={n.title}
                >
                  <span className="sr-only">
                    {n.title} · {state(n.done)}
                    {n.here ? ` · ${t('overview.youAreHere')}` : ''}
                  </span>
                </li>
              ))}
            </ol>
          </li>
        ))}
      </ol>
    </Box>
  );
}

function CurrentPhase({ p }: { p: ProjectDetail }) {
  const t = useT();
  const phase = p.phases.find((x) => x.id === p.currentPhase?.id);
  return (
    <Box
      title={t('overview.currentPhase')}
      meta={phase?.title}
      actions={<Link to={`/p/${p.slug}/roadmap`}>{t('project.tab.roadmap')}</Link>}
    >
      {phase ? (
        <ul className="tasks compact">
          {phase.tasks.map((x) => (
            <li key={x.id} className={`task${x.id === p.nextTask?.id ? ' task-next' : ''}`}>
              <span className={`task-icon ${x.done ? 'done' : 'open'}`} aria-hidden="true">
                {x.done ? <CheckCircleFillIcon size={16} /> : <CircleIcon size={16} />}
              </span>
              <span className="task-title">{x.title}</span>
              <span className="sr-only">{t(x.done ? 'overview.done' : 'overview.todo')}</span>
            </li>
          ))}
        </ul>
      ) : (
        <p className="muted">{t('overview.noPhase')}</p>
      )}
    </Box>
  );
}

function LatestDiary({ p }: { p: ProjectDetail }) {
  const t = useT();
  const diary = useQuery({ queryKey: ['diary', p.slug, 5], queryFn: () => api.diary(p.slug, 5) });
  return (
    <Box title={t('overview.latestDiary')}>
      {diary.data?.length ? (
        <ul className="diary-mini">
          {diary.data.map((e) => (
            <li key={e.id}>
              <SourceAvatar source={e.source} />
              <span className="diary-text">{firstLine(e.body)}</span>
              <span className="meta">
                <RelativeTime iso={e.occurredAt} />
              </span>
            </li>
          ))}
        </ul>
      ) : (
        <p className="muted">{t(diary.isPending ? 'common.loading' : 'overview.noDiary')}</p>
      )}
    </Box>
  );
}

function firstLine(md: string): string {
  const line = md.split('\n').find((l) => l.trim()) ?? '';
  return line.replace(/^#+\s*/, '').slice(0, 200);
}
