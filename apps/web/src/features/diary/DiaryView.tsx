import type { DiaryEntryView, DiaryType, FileView, Source } from '@heph/schema';
import { useInfiniteQuery, useQueryClient } from '@tanstack/react-query';
import { useMemo, useState } from 'react';
import { Link } from 'react-router';
import { api, fileUrl } from '../../api/client.js';
import { useApiMutation, useProjects } from '../../api/queries.js';
import { Markdown, MarkdownEditor } from '../../components/markdown.js';
import {
  Alert,
  Box,
  Button,
  EmptyState,
  RelativeTime,
  Segmented,
  Skeleton,
  SourceAvatar,
} from '../../components/ui.js';
import { type MessageKey, useI18n, useT } from '../../i18n/index.js';
import { errorKey } from '../../lib/errors.js';
import { type DiaryItem, groupDiary, sourceCounts } from './group.js';

const PAGE = 50;
type SourceFilter = 'all' | Source;

/**
 * Diary timeline (mockups 04, 12, 55): editor on top for a project, day headers that
 * stay visible, Claude sessions summarized, older days loaded on demand.
 * `projectRef` null shows every project (dashboard).
 */
export function DiaryView({ projectRef }: { projectRef: string | null }) {
  const t = useT();
  const qc = useQueryClient();
  const [source, setSource] = useState<SourceFilter>('all');
  const [type, setType] = useState<'' | DiaryType>('');
  const [withFiles, setWithFiles] = useState(false);
  const [text, setText] = useState('');
  const projects = useProjects();
  const names = useMemo(
    () => new Map((projects.data ?? []).map((p) => [p.id, p] as const)),
    [projects.data],
  );

  const q = useInfiniteQuery({
    queryKey: ['diary', projectRef, source, type, withFiles],
    queryFn: ({ pageParam }) =>
      api.diaryPage(projectRef, {
        limit: PAGE,
        source: source === 'all' ? undefined : source,
        type: type || undefined,
        withFiles,
        ...pageParam,
      }),
    initialPageParam: {} as { before?: string; beforeId?: number },
    getNextPageParam: (last) => {
      const end = last.at(-1);
      return last.length < PAGE || !end ? undefined : { before: end.occurredAt, beforeId: end.id };
    },
  });
  const all = q.data?.pages.flat() ?? [];
  const needle = text.trim().toLowerCase();
  const entries = needle ? all.filter((e) => e.body.toLowerCase().includes(needle)) : all;
  const counts = sourceCounts(all);
  const days = groupDiary(entries);

  return (
    <div className="stack">
      {projectRef && (
        <NoteComposer
          projectRef={projectRef}
          onAdded={() => qc.invalidateQueries({ queryKey: ['diary'] })}
        />
      )}
      <div className="toolbar">
        <Segmented<SourceFilter>
          label={t('diary.filterSource')}
          value={source}
          onChange={setSource}
          options={(['all', 'ui', 'claude_code', 'github', 'system'] as const).map((s) => ({
            value: s,
            label:
              s === 'all'
                ? t('diary.all')
                : `${t(`source.${s}` as MessageKey)}${source === 'all' ? ` ${counts[s] ?? 0}` : ''}`,
          }))}
        />
        <label className="sr-only" htmlFor="diary-type">
          {t('diary.type')}
        </label>
        <select
          id="diary-type"
          value={type}
          onChange={(e) => setType(e.target.value as '' | DiaryType)}
        >
          <option value="">{t('diary.type.all')}</option>
          <option value="note">{t('diary.type.note')}</option>
          <option value="session">{t('diary.type.session')}</option>
          <option value="event">{t('diary.type.event')}</option>
        </select>
        <label className="check">
          <input
            type="checkbox"
            checked={withFiles}
            onChange={(e) => setWithFiles(e.target.checked)}
          />
          {t('diary.withFiles')}
        </label>
        <label className="sr-only" htmlFor="diary-search">
          {t('diary.search')}
        </label>
        <input
          id="diary-search"
          type="search"
          placeholder={t('diary.search')}
          value={text}
          onChange={(e) => setText(e.target.value)}
        />
      </div>

      {q.isPending ? (
        <Skeleton lines={6} />
      ) : q.isError ? (
        <Alert
          tone="danger"
          action={<Button onClick={() => q.refetch()}>{t('common.retry')}</Button>}
        >
          {t(errorKey(q.error))}
        </Alert>
      ) : days.length === 0 ? (
        <Box>
          <EmptyState title={t('diary.empty.title')} text={t('diary.empty.text')} />
        </Box>
      ) : (
        <ol className="timeline">
          {days.map((d) => (
            <li key={d.day} className="day">
              <h3 className="day-head">
                <DayLabel day={d.day} />
              </h3>
              <ol className="day-items">
                {d.items.map((it) => (
                  <TimelineItem
                    key={it.kind === 'entry' ? it.entry.id : `s-${it.sessionId}-${it.end}`}
                    item={it}
                    projectName={(e) => names.get(e.projectId)}
                    showProject={projectRef === null}
                  />
                ))}
              </ol>
            </li>
          ))}
        </ol>
      )}
      {q.hasNextPage && (
        <Button disabled={q.isFetchingNextPage} onClick={() => q.fetchNextPage()}>
          {t('diary.loadOlder')}
        </Button>
      )}
    </div>
  );
}

function DayLabel({ day }: { day: string }) {
  const { lang } = useI18n();
  const [y, m, d] = day.split('-').map(Number);
  const date = new Date(y as number, (m as number) - 1, d);
  return (
    <time dateTime={day}>
      {new Intl.DateTimeFormat(lang, {
        weekday: 'long',
        day: 'numeric',
        month: 'long',
        year: 'numeric',
      }).format(date)}
    </time>
  );
}

function NoteComposer({ projectRef, onAdded }: { projectRef: string; onAdded: () => void }) {
  const t = useT();
  const [body, setBody] = useState('');
  const [files, setFiles] = useState<FileView[]>([]);
  const add = useApiMutation(
    () =>
      api.addNote(
        projectRef,
        body.trim(),
        files.map((f) => f.id),
      ),
    {
      onSuccess: () => {
        setBody('');
        setFiles([]);
        onAdded();
      },
    },
  );
  return (
    <Box>
      <MarkdownEditor
        label={t('diary.newNote')}
        value={body}
        onChange={setBody}
        onSubmit={() => add.mutate(undefined)}
        submitLabel={t('diary.publish')}
        busy={add.isPending}
        projectRef={projectRef}
        files={files}
        onFiles={setFiles}
      />
    </Box>
  );
}

type NameOf = (e: DiaryEntryView) => { name: string; slug: string } | undefined;

function TimelineItem({
  item,
  projectName,
  showProject,
}: {
  item: DiaryItem;
  projectName: NameOf;
  showProject: boolean;
}) {
  if (item.kind === 'entry') {
    return <EntryView entry={item.entry} projectName={projectName} showProject={showProject} />;
  }
  return <SessionView item={item} projectName={projectName} showProject={showProject} />;
}

function ProjectChip({ entry, projectName }: { entry: DiaryEntryView; projectName: NameOf }) {
  const p = projectName(entry);
  return p ? (
    <Link className="tag" to={`/p/${p.slug}/diary`}>
      {p.name}
    </Link>
  ) : null;
}

function EntryView({
  entry,
  projectName,
  showProject,
}: {
  entry: DiaryEntryView;
  projectName: NameOf;
  showProject: boolean;
}) {
  const t = useT();
  const failed = entry.eventKind === 'test_outcome' && entry.data?.passed === false;
  const head = (
    <div className="entry-head">
      <SourceAvatar source={entry.source} />
      {showProject && <ProjectChip entry={entry} projectName={projectName} />}
      {entry.eventKind && (
        <span className="meta">{t(`diary.event.${entry.eventKind}` as MessageKey)}</span>
      )}
      <span className="meta">
        <RelativeTime iso={entry.occurredAt} />
      </span>
    </div>
  );
  if (
    entry.type === 'event' &&
    !failed &&
    entry.eventKind !== 'test_outcome' &&
    entry.files.length === 0
  ) {
    return (
      <li className="entry entry-event">
        {head}
        <span className="entry-line">{firstLine(entry.body)}</span>
      </li>
    );
  }
  return (
    <li className={`entry box${failed ? ' box-danger' : ''}`}>
      <div className="box-body">
        {head}
        <Markdown text={entry.body} />
        <Attachments files={entry.files} />
      </div>
    </li>
  );
}

function SessionView({
  item,
  projectName,
  showProject,
}: {
  item: Extract<DiaryItem, { kind: 'session' }>;
  projectName: NameOf;
  showProject: boolean;
}) {
  const t = useT();
  const { date } = useI18n();
  const [open, setOpen] = useState(false);
  const s = item.summary;
  const first = item.entries[0] as DiaryEntryView;
  const summary =
    item.entries.find((e) => e.type === 'session') ?? item.entries.find((e) => e.type === 'note');
  return (
    <li className="entry box box-ai">
      <div className="box-head">
        <div className="box-title">
          <SourceAvatar source={first.source} />
          <h4>{t('diary.session')}</h4>
          {showProject && <ProjectChip entry={first} projectName={projectName} />}
          <span className="meta">
            {date(item.start)} – {date(item.end)}
          </span>
        </div>
      </div>
      <div className="box-body">
        <p className="meta">
          {t('diary.sessionSummary', {
            tasks: s.tasks,
            tests: s.tests,
            files: s.files,
            status: s.status,
            notes: s.notes,
          })}
        </p>
        {summary && <Markdown text={summary.body} />}
        <Attachments
          files={item.entries.flatMap((e) => e.files).slice(0, 6)}
          more={Math.max(0, s.files - 6)}
        />
        <button
          type="button"
          className="link-btn"
          aria-expanded={open}
          onClick={() => setOpen(!open)}
        >
          {t(open ? 'diary.hideEvents' : 'diary.showEvents', { n: item.entries.length })}
        </button>
        {open && (
          <ol className="day-items">
            {item.entries.map((e) => (
              <EntryView key={e.id} entry={e} projectName={projectName} showProject={false} />
            ))}
          </ol>
        )}
      </div>
    </li>
  );
}

export function Attachments({ files, more = 0 }: { files: FileView[]; more?: number }) {
  const t = useT();
  if (files.length === 0) return null;
  return (
    <ul className="thumbs">
      {files.map((f) => (
        <li key={f.id}>
          <a
            href={fileUrl(f.id)}
            target="_blank"
            rel="noreferrer noopener"
            title={f.caption ?? f.originalName}
          >
            {f.hasThumbnail ? (
              <img
                src={fileUrl(f.id, { thumb: true })}
                alt={f.caption ?? f.originalName}
                loading="lazy"
              />
            ) : (
              <span className="thumb-file">{f.originalName}</span>
            )}
          </a>
        </li>
      ))}
      {more > 0 && <li className="meta">{t('diary.moreFiles', { n: more })}</li>}
    </ul>
  );
}

function firstLine(md: string): string {
  return (md.split('\n').find((l) => l.trim()) ?? '').replace(/^#+\s*/, '');
}
